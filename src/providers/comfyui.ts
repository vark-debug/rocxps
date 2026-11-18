import {
  bytesToBase64,
  dataUriToBytes,
  fetchWithTimeout,
  ProviderError,
  renderTemplate,
  sleep,
  toProviderError,
} from "./http";
import type { TemplateVars } from "./types";

/**
 * 本地 ComfyUI HTTP API：
 * 1) POST /upload/image（multipart）上传选区原图；
 * 2) POST /prompt 提交工作流（API 格式 JSON，支持 {{image}}/{{prompt}}/{{width}}/{{height}} 占位符）；
 * 3) 轮询 GET /history/{prompt_id} 取输出图片；
 * 4) GET /view 下载并转 base64。
 *
 * 工作流需由用户自行提供：ComfyUI 没有统一的模型参数约定，节点 ID 因工作流而异。
 */

export interface ComfyUIConfig {
  baseUrl: string;
  workflow: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 1500;

const trimBase = (base: string) => base.trim().replace(/\/+$/, "");

interface ComfyImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

const pickFirstImage = (historyEntry: unknown): ComfyImageRef | undefined => {
  const outputs = (historyEntry as { outputs?: Record<string, unknown> })?.outputs;
  if (!outputs || typeof outputs !== "object") return undefined;
  for (const node of Object.values(outputs)) {
    const images = (node as { images?: unknown })?.images;
    if (Array.isArray(images)) {
      for (const img of images) {
        const ref = img as Partial<ComfyImageRef>;
        if (typeof ref.filename === "string" && ref.filename) {
          return {
            filename: ref.filename,
            subfolder: ref.subfolder,
            type: ref.type,
          };
        }
      }
    }
  }
  return undefined;
};

export async function comfyGenerate(
  cfg: ComfyUIConfig,
  imageDataUri: string,
  vars: TemplateVars,
): Promise<string> {
  const base = trimBase(cfg.baseUrl);
  if (!base) throw new ProviderError("terminal", "请先在设置中填写 ComfyUI 服务地址");
  if (!cfg.workflow.trim()) {
    throw new ProviderError("terminal", "请先在设置中粘贴 ComfyUI 工作流 JSON");
  }
  if (typeof FormData === "undefined" || typeof Blob === "undefined") {
    throw new ProviderError(
      "terminal",
      "当前 UXP 版本不支持 multipart 上传，无法向 ComfyUI 提交图片",
    );
  }

  // 1) 上传输入图（ComfyUI 的 LoadImage 节点只接受服务端文件名）
  const uploadName = `rocxps-${Date.now()}.png`;
  const form = new FormData();
  form.append(
    "image",
    new Blob([dataUriToBytes(imageDataUri)], { type: "image/png" }),
    uploadName,
  );
  form.append("overwrite", "true");
  const uploadRes = await fetchWithTimeout(
    `${base}/upload/image`,
    { method: "POST", body: form },
    30_000,
  );
  if (!uploadRes.ok) throw await toProviderError(uploadRes);
  const uploaded = (await uploadRes.json()) as {
    name?: string;
    subfolder?: string;
  };
  const serverImage = uploaded.subfolder
    ? `${uploaded.subfolder}/${uploaded.name ?? uploadName}`
    : uploaded.name ?? uploadName;

  // 2) 渲染并提交工作流
  let workflow: unknown;
  try {
    workflow = JSON.parse(cfg.workflow);
  } catch {
    throw new ProviderError("terminal", "ComfyUI 工作流不是合法 JSON");
  }
  const promptVars: TemplateVars = { ...vars, image: serverImage };
  const rendered = renderTemplate(workflow, promptVars);

  const submitRes = await fetchWithTimeout(
    `${base}/prompt`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: rendered,
        client_id: `rocxps-${Date.now()}`,
      }),
    },
    30_000,
  );
  if (!submitRes.ok) throw await toProviderError(submitRes);
  const submit = (await submitRes.json()) as {
    prompt_id?: string;
    error?: unknown;
    node_errors?: unknown;
  };
  if (submit.error || (submit.node_errors && Object.keys(submit.node_errors).length)) {
    throw new ProviderError(
      "terminal",
      `ComfyUI 工作流校验失败：${JSON.stringify(submit.error ?? submit.node_errors)}`,
    );
  }
  const promptId = submit.prompt_id;
  if (!promptId) throw new ProviderError("terminal", "ComfyUI 未返回 prompt_id");

  // 3) 轮询 history 直到出现输出
  const deadline = Date.now() + cfg.timeoutMs;
  const pollMs = cfg.pollIntervalMs ?? DEFAULT_POLL_MS;
  let lastError = "";
  while (Date.now() < deadline) {
    await sleep(pollMs);
    let historyRes: Response;
    try {
      historyRes = await fetchWithTimeout(
        `${base}/history/${promptId}`,
        { method: "GET" },
        Math.max(5000, Math.min(30_000, deadline - Date.now())),
      );
    } catch (err) {
      if (err instanceof ProviderError && err.kind === "retryable") continue;
      throw err;
    }
    if (!historyRes.ok) {
      if (historyRes.status >= 500) continue;
      throw await toProviderError(historyRes);
    }
    const history = (await historyRes.json()) as Record<string, unknown>;
    const entry = history[promptId] as
      | { status?: { status_str?: string; messages?: unknown }; outputs?: unknown }
      | undefined;
    if (entry?.status?.status_str === "error") {
      lastError = JSON.stringify(entry.status.messages ?? entry.status);
      break;
    }
    const image = pickFirstImage(entry);
    if (image) {
      const params = [
        `filename=${encodeURIComponent(image.filename)}`,
        `subfolder=${encodeURIComponent(image.subfolder ?? "")}`,
        `type=${encodeURIComponent(image.type ?? "output")}`,
      ].join("&");
      const viewRes = await fetchWithTimeout(
        `${base}/view?${params}`,
        { method: "GET" },
        Math.max(5000, deadline - Date.now()),
      );
      if (!viewRes.ok) throw await toProviderError(viewRes);
      return bytesToBase64(new Uint8Array(await viewRes.arrayBuffer()));
    }
  }

  if (lastError) throw new ProviderError("terminal", `ComfyUI 执行失败：${lastError}`);
  throw new ProviderError(
    "timeout",
    `ComfyUI 任务在 ${Math.round(cfg.timeoutMs / 1000)}s 内未产出图片`,
  );
}

export type ComfyProbeResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 连通性探测：GET /system_stats。 */
export async function comfyProbe(baseUrl: string): Promise<ComfyProbeResult> {
  const base = trimBase(baseUrl);
  if (!base) return { ok: false, message: "请先填写 ComfyUI 服务地址" };
  try {
    const res = await fetchWithTimeout(`${base}/system_stats`, { method: "GET" }, 15_000);
    if (!res.ok) {
      return { ok: false, message: `ComfyUI 返回 HTTP ${res.status}` };
    }
    return { ok: true, message: "已连接 ComfyUI" };
  } catch (err) {
    return {
      ok: false,
      message: `连接失败：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
