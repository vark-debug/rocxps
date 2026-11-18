/**
 * 火山方舟 Ark Seedream HTTP 客户端（docs/local-redraw-plan.md §6）。
 * - b64_json 返回，错误按 terminal / retryable / timeout 分类；
 * - 可重试错误（429 / 5xx / 网络抖动）指数退避，最多重试 2 次；
 * - 超时绝不自动重发（无法确认是否已计费），交给用户重试。
 */

const ARK_ENDPOINT =
  "https://ark.cn-beijing.volces.com/api/v3/images/generations";

export type ArkErrorKind = "terminal" | "retryable" | "timeout";

export class ArkError extends Error {
  readonly kind: ArkErrorKind;
  readonly status?: number;
  /** 429 时优先读取 Retry-After。 */
  readonly retryAfterMs?: number;

  constructor(
    kind: ArkErrorKind,
    message: string,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ArkError";
    this.kind = kind;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ArkGenerateParams {
  model: string;
  prompt: string;
  /** 输入图（data URL 或 https URL），图生图时提供。 */
  image?: string[];
  /** "宽x高"，或 seededit 的 "adaptive"。 */
  size?: string;
  watermark?: boolean;
  timeoutMs?: number;
}

export interface ArkGeneratedImage {
  size?: string;
  b64Json?: string;
  url?: string;
}

export interface ArkGenerateResult {
  model: string;
  images: ArkGeneratedImage[];
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3; // 首次 + 2 次重试
const backoffMs = (attempt: number) => 1000 * 2 ** (attempt - 1);

export const maskApiKey = (key: string): string =>
  key.length <= 8 ? "***" : `${key.slice(0, 4)}****${key.slice(-4)}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 发请求；UXP fetch 若不响应 AbortSignal，由 Promise.race 兜底超时。 */
async function arkFetch(
  apiKey: string,
  payload: unknown,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    return await Promise.race([
      fetch(ARK_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(
              new ArkError("timeout", `请求超时（${Math.round(timeoutMs / 1000)}s）`),
            ),
          timeoutMs + 5000,
        ),
      ),
    ]);
  } catch (err) {
    if (err instanceof ArkError) throw err;
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new ArkError("timeout", `请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw new ArkError(
      "retryable",
      `网络错误：${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function parseErrorResponse(res: Response): Promise<ArkError> {
  let message = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    const err = body?.error;
    if (err?.message) {
      message = `${message} ${err.code ? `[${err.code}]` : ""} ${err.message}`.trim();
    }
  } catch {
    // body 非 JSON，保留状态码消息
  }
  const retryAfterHeader = res.headers.get("retry-after");
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSec)
    ? retryAfterSec * 1000
    : undefined;
  const kind: ArkErrorKind = RETRYABLE_STATUS.has(res.status)
    ? "retryable"
    : "terminal";
  return new ArkError(kind, message, res.status, retryAfterMs);
}

async function parseResult(res: Response): Promise<ArkGenerateResult> {
  const body = await res.json();
  const data: Record<string, string>[] = body?.data ?? [];
  return {
    model: body?.model ?? "",
    images: data.map((d) => ({
      size: d.size,
      b64Json: d.b64_json,
      url: d.url,
    })),
  };
}

export async function generateImage(
  apiKey: string,
  params: ArkGenerateParams,
  opts: { signal?: AbortSignal } = {},
): Promise<ArkGenerateResult> {
  const timeoutMs = params.timeoutMs ?? 300_000;
  const payload: Record<string, unknown> = {
    model: params.model,
    prompt: params.prompt,
    response_format: "b64_json",
    watermark: params.watermark ?? false,
  };
  // sequential_image_generation（多图序列）不发送：仅生成单图时 Ark 默认即为 disabled，
  // 且部分模型（如 Seedream 5.0 Pro）不支持该参数，发送会返回 HTTP 400。
  if (params.image?.length) payload.image = params.image;
  if (params.size) payload.size = params.size;

  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await arkFetch(apiKey, payload, timeoutMs, opts.signal);
    } catch (err) {
      const canRetry =
        err instanceof ArkError &&
        err.kind === "retryable" &&
        attempt < MAX_ATTEMPTS;
      if (canRetry) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw err;
    }
    if (res.ok) return parseResult(res);
    const arkErr = await parseErrorResponse(res);
    if (arkErr.kind === "retryable" && attempt < MAX_ATTEMPTS) {
      await sleep(arkErr.retryAfterMs ?? backoffMs(attempt));
      continue;
    }
    throw arkErr;
  }
}

export type AuthProbeResult =
  | { ok: true; status: number; message: string }
  | { ok: false; status: number; message: string };

/**
 * 零成本鉴权探测：发送无效的最小 body。
 * Key 无效 → 401/403；Key 有效 → 因模型/参数校验被拒（400/404 等），即视为鉴权通过。
 */
export async function testConnection(apiKey: string): Promise<AuthProbeResult> {
  let res: Response;
  try {
    res = await arkFetch(apiKey, { model: "__probe__" }, 15_000);
  } catch (err) {
    const message = err instanceof ArkError ? err.message : String(err);
    return { ok: false, status: 0, message };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      status: res.status,
      message: "鉴权失败：API Key 无效或无权限",
    };
  }
  return {
    ok: true,
    status: res.status,
    message: res.ok
      ? "连接正常"
      : `鉴权通过（服务返回 HTTP ${res.status}，探测请求被参数校验拒绝属预期）`,
  };
}
