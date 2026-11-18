import {
  downloadAsBase64,
  fetchWithTimeout,
  postJson,
  ProviderError,
  renderTemplate,
  sleep,
} from "./http";
import type { TemplateVars } from "./types";

/**
 * RunningHub 标准模型 API：提交任务（同步返回 taskId）→ 轮询 /openapi/v2/query
 * → SUCCESS 后下载结果 URL 转 base64（结果链接仅 24 小时有效）。
 * 输入图支持 data URI，免去先上传媒体。
 */

export interface RunningHubConfig {
  /** 平台域名，如 https://www.runninghub.cn（国际站 runninghub.ai）。 */
  baseUrl: string;
  /** 提交接口路径，如 /openapi/v2/alibaba/qwen-image-2.0/image-edit。 */
  endpoint: string;
  /** JSON 请求体模板。 */
  bodyTemplate: string;
  /** 总超时（含排队与生成）。 */
  timeoutMs: number;
  pollIntervalMs?: number;
}

interface RunningHubResponse {
  taskId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
  results?: Array<{ url?: string | null; outputType?: string | null }> | null;
  failedReason?: unknown;
}

const DEFAULT_POLL_MS = 2000;
const QUERY_PATH = "/openapi/v2/query";

const trimBase = (base: string) => base.trim().replace(/\/+$/, "");
const normalizeEndpoint = (endpoint: string) =>
  endpoint.startsWith("http")
    ? endpoint
    : `/${endpoint.replace(/^\/+/, "")}`;

const failMessage = (res: RunningHubResponse): string => {
  const code = res.errorCode ? ` [${res.errorCode}]` : "";
  const reason = res.failedReason ? ` ${JSON.stringify(res.failedReason)}` : "";
  return `${(res.errorMessage || "任务失败").trim()}${code}${reason}`;
};

const resultUrl = (res: RunningHubResponse): string | undefined =>
  res.results?.find((r) => typeof r.url === "string" && r.url)?.url ?? undefined;

export async function runningHubGenerate(
  cfg: RunningHubConfig,
  apiKey: string,
  vars: TemplateVars,
): Promise<string> {
  const base = trimBase(cfg.baseUrl);
  if (!base) throw new ProviderError("terminal", "请先在设置中填写 RunningHub 平台地址");
  if (!apiKey) throw new ProviderError("terminal", "尚未配置 RunningHub API Key");
  const endpoint = normalizeEndpoint(cfg.endpoint);
  if (!endpoint) throw new ProviderError("terminal", "请先在设置中填写 RunningHub 提交接口");

  let template: unknown;
  try {
    template = JSON.parse(cfg.bodyTemplate);
  } catch {
    throw new ProviderError("terminal", "RunningHub 请求体模板不是合法 JSON");
  }
  const body = renderTemplate(template, vars);

  const deadline = Date.now() + cfg.timeoutMs;
  const submit = (await postJson(
    endpoint.startsWith("http") ? endpoint : `${base}${endpoint}`,
    apiKey,
    body,
    Math.min(cfg.timeoutMs, 60_000),
  )) as RunningHubResponse;

  if (submit.status === "FAILED") {
    throw new ProviderError("terminal", failMessage(submit));
  }
  const immediate = resultUrl(submit);
  if (immediate) return downloadAsBase64(immediate, 60_000);

  const taskId = submit.taskId;
  if (!taskId) {
    throw new ProviderError(
      "terminal",
      submit.errorMessage || "RunningHub 未返回 taskId",
    );
  }

  const pollMs = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
  let lastStatus = submit.status ?? "QUEUED";
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let query: RunningHubResponse;
    try {
      query = (await postJson(
        `${base}${QUERY_PATH}`,
        apiKey,
        { taskId },
        Math.max(5000, Math.min(30_000, deadline - Date.now())),
      )) as RunningHubResponse;
    } catch (err) {
      // 轮询阶段的网络抖动可继续等待；任务本身已在服务端，不重复提交
      if (err instanceof ProviderError && err.kind === "retryable") continue;
      throw err;
    }

    lastStatus = query.status ?? lastStatus;
    if (query.status === "SUCCESS") {
      const url = resultUrl(query);
      if (!url) throw new ProviderError("terminal", "RunningHub 任务成功但没有返回图片 URL");
      return downloadAsBase64(url, Math.max(5000, deadline - Date.now()));
    }
    if (query.status === "FAILED") {
      throw new ProviderError("terminal", failMessage(query));
    }
  }

  throw new ProviderError(
    "timeout",
    `RunningHub 任务 ${taskId} 在 ${Math.round(cfg.timeoutMs / 1000)}s 内未完成（最后状态 ${lastStatus}），可稍后在历史记录中重试`,
  );
}

export type ProbeResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 零成本鉴权探测：用不存在的 taskId 查询，401/403 视为 Key 无效。 */
export async function runningHubProbe(
  baseUrl: string,
  apiKey: string,
): Promise<ProbeResult> {
  const base = trimBase(baseUrl);
  if (!base) return { ok: false, message: "请先填写 RunningHub 平台地址" };
  if (!apiKey) return { ok: false, message: "请先填写 RunningHub API Key" };
  try {
    const res = await fetchWithTimeout(
      `${base}${QUERY_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ taskId: "0" }),
      },
      15_000,
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, message: "鉴权失败：API Key 无效或无权限" };
    }
    return {
      ok: true,
      message:
        res.ok
          ? "连接正常"
          : `鉴权通过（服务返回 HTTP ${res.status}，探测任务不存在属预期）`,
    };
  } catch (err) {
    return {
      ok: false,
      message: `网络错误：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
