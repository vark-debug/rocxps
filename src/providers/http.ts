import type { TemplateVars } from "./types";

/**
 * 多平台共用的 HTTP 小工具：超时、错误归类、模板渲染、结果下载。
 * 与 Ark 客户端保持同一套语义：超时不自动重发，5xx/429 可重试。
 */

/** cancelled：任务被用户取消（不能按失败记录，runner 会转成 cancelled 状态）。 */
export type ProviderErrorKind =
  | "terminal"
  | "retryable"
  | "timeout"
  | "cancelled";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  /** 平台稳定错误码（如 Siliconed 的 unknown_job / link），供上层做可重试判定。 */
  readonly code?: string;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    status?: number,
    code?: string,
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
    this.code = code;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 带超时的 fetch；UXP 不响应 AbortSignal 时用 Promise.race 兜底。 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new ProviderError(
                "timeout",
                `请求超时（${Math.round(timeoutMs / 1000)}s）`,
              ),
            ),
          timeoutMs + 5000,
        ),
      ),
    ]);
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ProviderError(
        "timeout",
        `请求超时（${Math.round(timeoutMs / 1000)}s）`,
      );
    }
    throw new ProviderError(
      "retryable",
      `网络错误：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

/** 读取服务端错误信息，兼容 {error:{message}}、{message}、{errorMessage} 三种形态。 */
export async function toProviderError(res: Response): Promise<ProviderError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    const detail =
      body?.error?.message ??
      body?.errorMessage ??
      body?.message ??
      body?.msg;
    const code = body?.error?.code ?? body?.errorCode ?? body?.code;
    if (detail) message = `${message}${code ? ` [${code}]` : ""} ${detail}`;
  } catch {
    // 非 JSON 响应，保留状态码
  }
  return new ProviderError(
    RETRYABLE_STATUS.has(res.status) ? "retryable" : "terminal",
    message,
    res.status,
  );
}

export async function postJson(
  url: string,
  apiKey: string | undefined,
  body: unknown,
  timeoutMs: number,
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetchWithTimeout(
    url,
    { method: "POST", headers, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (!res.ok) throw await toProviderError(res);
  try {
    return await res.json();
  } catch {
    throw new ProviderError("terminal", "服务返回的不是合法 JSON");
  }
}

const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_]+)\s*\}\}$/;
const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * 递归渲染 JSON 模板：整个字符串恰好是占位符时保留原始类型（数字），
 * 字符串内嵌占位符时按字符串拼接；未知占位符替换为空串。
 */
export function renderTemplate(value: unknown, vars: TemplateVars): unknown {
  if (typeof value === "string") {
    const whole = value.match(WHOLE_PLACEHOLDER);
    if (whole && whole[1] in vars) return vars[whole[1]];
    return value.replace(PLACEHOLDER, (_, key: string) =>
      key in vars ? String(vars[key]) : "",
    );
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, vars));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = renderTemplate(v, vars);
    }
    return out;
  }
  return value;
}

/** 解析 "data.0.url" / "data[0].url" 形式的取值路径。 */
export function getByPath(root: unknown, path: string): unknown {
  const tokens = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .map((t) => t.trim())
    .filter(Boolean);
  let cur: unknown = root;
  for (const token of tokens) {
    if (cur === null || cur === undefined) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(token);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === "object") {
      cur = (cur as Record<string, unknown>)[token];
    } else {
      return undefined;
    }
  }
  return cur;
}

export const stripDataUri = (value: string): string => {
  const idx = value.indexOf(",");
  return value.startsWith("data:") && idx >= 0 ? value.slice(idx + 1) : value;
};

/** data URI → 字节流（ComfyUI 上传需要原始字节）。 */
export function dataUriToBytes(dataUri: string): Uint8Array {
  const binary = atob(stripDataUri(dataUri));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** 结果 URL → base64（RunningHub / 自定义接口的结果链接 24 小时后失效）。 */
export async function downloadAsBase64(
  url: string,
  timeoutMs: number,
): Promise<string> {
  const res = await fetchWithTimeout(url, { method: "GET" }, timeoutMs);
  if (!res.ok) throw await toProviderError(res);
  const buffer = await res.arrayBuffer();
  return bytesToBase64(new Uint8Array(buffer));
}
