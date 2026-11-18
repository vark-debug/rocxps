import { bytesToBase64, fetchWithTimeout, ProviderError, stripDataUri } from "./http";
import type { MaskData } from "../ps/capture";
import { IOPAINT_DEFAULT_MODEL } from "./catalog";

/**
 * 本地 IOPaint HTTP API（纯擦除模型 LaMa / MAT）：
 * 1) 确保服务端当前模型与设置一致（POST /api/v1/model，进程级全局状态）；
 * 2) POST /api/v1/inpaint（JSON + base64，返回同尺寸图片二进制）。
 *
 * 关键约定（以本机 1.6.0 实测 schema 为准）：
 * - **mask 白（≥128）= 编辑，黑 = 保留**，与捕获层的黑白通道图方向一致，不需要反相；
 * - mask 与原图必须**同尺寸**，服务端会把 mask 二值化，羽化在服务端不起作用；
 * - `/api/v1/inpaint` 的 InpaintRequest **没有 `model` 字段**，模型只能通过
 *   POST /api/v1/model 切换，因此生成前先对齐模型；
 * - 成功响应是图片二进制（不是 JSON），失败响应的错误信息在 detail / error 字段。
 */

const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;
const DEFAULT_SWITCH_TIMEOUT_MS = 120_000;
const PROBE_TIMEOUT_MS = 15_000;

export const IOPAINT_MODELS = ["lama", "mat"] as const;
export type IopaintModel = (typeof IOPAINT_MODELS)[number];

export const isIopaintModel = (value: string): value is IopaintModel =>
  (IOPAINT_MODELS as readonly string[]).includes(value);

const trimBase = (base: string) => base.trim().replace(/\/+$/, "");

/** 从服务地址取端口，拼出可直接复制的启动命令（含模型与 CPU 设备）。 */
export const iopaintStartCommand = (baseUrl: string, model: string): string => {
  const match = baseUrl.trim().match(/:(\d+)(?:[/?#]|$)/);
  const port = match ? match[1] : "18088";
  const name = model.trim() || IOPAINT_DEFAULT_MODEL;
  return `iopaint start --model=${name} --device=cpu --port=${port}`;
};

/** 启动提示：错误信息里统一带上命令，避免用户只看到 ECONNREFUSED。 */
const connectionMessage = (baseUrl: string, model: string, raw: string): string =>
  `未连接 IOPaint（${baseUrl}）：${raw}。请先在终端启动服务：${iopaintStartCommand(baseUrl, model)}`;

/**
 * 蒙版覆盖率（只用于挡掉必然无效果 / 全图重绘的请求）：
 * - empty：全黑，没有可编辑区域；
 * - full：全白，整块发送区域都会被重绘；
 * - ok：有白有黑。
 * 阈值与 IOPaint 的 `cv2.threshold(..., 127, ..., THRESH_BINARY)` 对齐（≥128 为白）。
 */
export const maskCoverage = (mask: MaskData): "empty" | "full" | "ok" => {
  let white = 0;
  const total = Math.min(mask.data.length, mask.width * mask.height);
  for (let i = 0; i < total; i += 1) {
    if (mask.data[i] >= 128) white += 1;
  }
  if (white === 0) return "empty";
  if (white === total && total > 0) return "full";
  return "ok";
};

/** mask 与原图必须完全同尺寸（IOPaint 对不一致的 API 请求直接 400）。 */
export const assertMaskSize = (
  mask: MaskData,
  width: number,
  height: number,
): void => {
  if (
    mask.width !== width ||
    mask.height !== height ||
    mask.data.length !== width * height
  ) {
    throw new ProviderError(
      "terminal",
      `蒙版尺寸（${mask.width}×${mask.height}）与发送原图（${width}×${height}）不一致；IOPaint 要求两者完全同尺寸`,
    );
  }
};

/** `/api/v1/inpaint` 请求体：只发实际生效的字段，模型由服务端当前模型决定。 */
export interface IopaintInpaintBody {
  image: string;
  mask: string;
  hd_strategy: string;
  sd_keep_unmasked_area: boolean;
}

export const buildInpaintBody = (
  imageBase64: string,
  maskBase64: string,
  hdStrategy: "Crop" | "Original" = "Crop",
): IopaintInpaintBody => ({
  image: stripDataUri(imageBase64),
  mask: stripDataUri(maskBase64),
  hd_strategy: hdStrategy,
  sd_keep_unmasked_area: true,
});

/** 从错误响应体里提取可读信息（1.6.0 常见形态：detail / error / message / errors）。 */
const readErrorDetail = (rawBody: string): string => {
  try {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const detail = body?.detail ?? body?.error ?? body?.message ?? body?.errors;
    if (detail == null) return "";
    return typeof detail === "string" ? detail : JSON.stringify(detail);
  } catch {
    return rawBody.trim().slice(0, 200);
  }
};

/** HTTP 错误映射：尺寸不符 / 500 带服务端 message 的单测入口。 */
export const iopaintHttpError = (
  status: number,
  rawBody: string,
  baseUrl: string,
  model: string,
): ProviderError => {
  const detail = readErrorDetail(rawBody);
  const suffix = detail ? `：${detail}` : "";
  if (status === 400 && /mask/i.test(detail) && /(not match|size|尺寸)/i.test(detail)) {
    return new ProviderError(
      "terminal",
      `IOPaint 蒙版尺寸与原图不一致${suffix}；请重新抓取选区（原图与蒙版必须同尺寸）`,
      400,
    );
  }
  if (status === 500) {
    return new ProviderError(
      "terminal",
      `IOPaint 处理失败（HTTP 500）${suffix}`,
      500,
    );
  }
  if (status === 404) {
    return new ProviderError(
      "terminal",
      `IOPaint 接口不存在（HTTP 404）${suffix}；请确认服务地址正确：${baseUrl}`,
      404,
    );
  }
  return new ProviderError(
    status >= 500 ? "retryable" : "terminal",
    `IOPaint 返回 HTTP ${status}${suffix}${status === 503 ? `；请确认模型已下载（${iopaintStartCommand(baseUrl, model)}）` : ""}`,
    status,
  );
};

/** fetch 包装：把网络层错误统一换成带启动命令的 terminal 错误（超时保持 timeout）。 */
const fetchIopaint = async (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  baseUrl: string,
  model: string,
): Promise<Response> => {
  try {
    return await fetchWithTimeout(url, init, timeoutMs);
  } catch (err) {
    if (err instanceof ProviderError && err.kind === "timeout") throw err;
    const raw = err instanceof Error ? err.message : String(err);
    throw new ProviderError("terminal", connectionMessage(baseUrl, model, raw));
  }
};

const readJson = async (
  res: Response,
  baseUrl: string,
  model: string,
): Promise<unknown> => {
  const text = await res.text();
  if (!res.ok) throw iopaintHttpError(res.status, text, baseUrl, model);
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError("terminal", "IOPaint 返回的不是合法 JSON");
  }
};

/** 生成前对齐服务端模型（IOPaint 的「当前模型」是进程级全局状态）。 */
const ensureModel = async (
  base: string,
  model: string,
  timeoutMs: number,
): Promise<void> => {
  const current = (await readJson(
    await fetchIopaint(`${base}/api/v1/model`, { method: "GET" }, PROBE_TIMEOUT_MS, base, model),
    base,
    model,
  )) as { name?: unknown };
  if (String(current?.name ?? "") === model) return;
  await fetchIopaint(
    `${base}/api/v1/model`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    },
    timeoutMs,
    base,
    model,
  ).then((res) => readJson(res, base, model));
};

export interface IopaintConfig {
  baseUrl: string;
  /** lama / mat；生成前会切到该模型。 */
  model: string;
  timeoutMs?: number;
  /** 服务端加载模型权重可能较慢，单独给更长的上限。 */
  switchTimeoutMs?: number;
}

export interface IopaintInput {
  /** 捕获区域原图（base64，可带 data URI；预设模式已缩放到预设尺寸，与 mask 同几何）。 */
  imageBase64: string;
  /** 同一几何的黑白通道图（白 = 编辑）。 */
  maskBase64: string;
  mask: MaskData;
  width: number;
  height: number;
}

/** 调 IOPaint 做擦除，返回结果图 base64（无 data: 前缀、与输入同尺寸）。 */
export const iopaintGenerate = async (
  cfg: IopaintConfig,
  input: IopaintInput,
): Promise<string> => {
  const base = trimBase(cfg.baseUrl);
  if (!base) {
    throw new ProviderError("terminal", "请先在设置中填写 IOPaint 服务地址");
  }
  const model = cfg.model.trim() || IOPAINT_DEFAULT_MODEL;

  assertMaskSize(input.mask, input.width, input.height);
  const coverage = maskCoverage(input.mask);
  if (coverage === "empty") {
    throw new ProviderError(
      "terminal",
      "蒙版全黑：没有需要编辑的区域（IOPaint 约定白色=编辑、黑色=保留），请重新框选要擦除的内容",
    );
  }
  if (coverage === "full") {
    throw new ProviderError(
      "terminal",
      "蒙版全白：整块发送区域都会被擦除/重绘，请缩小选区，或改用其他生成平台",
    );
  }

  await ensureModel(base, model, cfg.switchTimeoutMs ?? DEFAULT_SWITCH_TIMEOUT_MS);

  const res = await fetchIopaint(
    `${base}/api/v1/inpaint`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildInpaintBody(input.imageBase64, input.maskBase64)),
    },
    cfg.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS,
    base,
    model,
  );
  if (!res.ok) {
    throw iopaintHttpError(res.status, await res.text(), base, model);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length === 0) {
    throw new ProviderError("terminal", "IOPaint 返回了空响应，请查看服务端日志");
  }
  return bytesToBase64(bytes);
};

export type IopaintProbeResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

/** 连通性探测：GET /api/v1/model（当前模型）+ /api/v1/server-config（已安装模型）。 */
export const iopaintProbe = async (
  baseUrl: string,
  model: string,
): Promise<IopaintProbeResult> => {
  const base = trimBase(baseUrl);
  if (!base) return { ok: false, message: "请先填写 IOPaint 服务地址" };
  const desired = model.trim() || IOPAINT_DEFAULT_MODEL;

  let currentName = "未知";
  try {
    const res = await fetchWithTimeout(`${base}/api/v1/model`, { method: "GET" }, PROBE_TIMEOUT_MS);
    if (!res.ok) return { ok: false, message: `IOPaint 返回 HTTP ${res.status}` };
    const info = (await res.json()) as { name?: unknown };
    if (info?.name) currentName = String(info.name);
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err);
    return { ok: false, message: connectionMessage(base, desired, raw) };
  }

  try {
    const res = await fetchWithTimeout(
      `${base}/api/v1/server-config`,
      { method: "GET" },
      PROBE_TIMEOUT_MS,
    );
    if (res.ok) {
      const config = (await res.json()) as { modelInfos?: Array<{ name?: unknown }> };
      const names = (config.modelInfos ?? [])
        .map((m) => String(m?.name ?? ""))
        .filter(Boolean);
      if (names.length && !names.includes(desired)) {
        return {
          ok: false,
          message: `服务已连接（当前模型 ${currentName}），但没有模型「${desired}」；已安装：${names.join(" / ")}`,
        };
      }
    }
  } catch {
    // server-config 只是补充信息，失败不影响「连接成功」的结论
  }

  return {
    ok: true,
    message: `已连接 IOPaint（当前模型 ${currentName}；设置模型 ${desired}，生成前会自动切换）`,
  };
};
