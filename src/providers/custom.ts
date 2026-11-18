import {
  downloadAsBase64,
  fetchWithTimeout,
  getByPath,
  ProviderError,
  renderTemplate,
  stripDataUri,
  toProviderError,
} from "./http";
import type { TemplateVars } from "./types";

/**
 * 通用自定义 HTTP 接口：把用户填写的 URL / 请求头 / 请求体模板发出去，
 * 按 resultPath 取出结果（base64、data URI 或 http URL 均可）。
 * 占位符：{{image}} {{mask}} {{prompt}} {{width}} {{height}} {{apiKey}}
 */

export interface CustomConfig {
  url: string;
  /** JSON 对象字符串，如 {"Content-Type":"application/json"}。 */
  headers: string;
  bodyTemplate: string;
  /** 结果取值路径，如 data.0.b64_json / data[0].url。 */
  resultPath: string;
  timeoutMs: number;
}

const pickResultString = (value: unknown): string | undefined => {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const key of ["b64_json", "base64", "b64", "url", "image"]) {
      const v = obj[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
  }
  return undefined;
};

export async function customGenerate(
  cfg: CustomConfig,
  apiKey: string,
  vars: TemplateVars,
): Promise<string> {
  const url = cfg.url.trim();
  if (!url) throw new ProviderError("terminal", "请先在设置中填写自定义接口 URL");
  if (!cfg.bodyTemplate.trim()) {
    throw new ProviderError("terminal", "请先在设置中填写自定义接口请求体模板");
  }
  if (!cfg.resultPath.trim()) {
    throw new ProviderError("terminal", "请先在设置中填写结果取值路径");
  }

  let headers: unknown = {};
  try {
    headers = cfg.headers.trim() ? JSON.parse(cfg.headers) : {};
  } catch {
    throw new ProviderError("terminal", "自定义接口请求头不是合法 JSON");
  }
  let body: unknown;
  try {
    body = JSON.parse(cfg.bodyTemplate);
  } catch {
    throw new ProviderError("terminal", "自定义接口请求体模板不是合法 JSON");
  }

  const allVars: TemplateVars = { ...vars, apiKey };
  const renderedHeaders = renderTemplate(headers, allVars) as Record<
    string,
    string
  >;
  if (!Object.keys(renderedHeaders).some((k) => k.toLowerCase() === "content-type")) {
    renderedHeaders["Content-Type"] = "application/json";
  }
  const renderedBody = renderTemplate(body, allVars);

  const res = await fetchWithTimeout(
    url,
    {
      method: "POST",
      headers: renderedHeaders,
      body: JSON.stringify(renderedBody),
    },
    cfg.timeoutMs,
  );
  if (!res.ok) throw await toProviderError(res);

  const json = await res.json();
  const picked = getByPath(json, cfg.resultPath) ?? json;
  const value = pickResultString(picked);
  if (!value) {
    throw new ProviderError(
      "terminal",
      `结果路径「${cfg.resultPath}」未取到图片数据`,
    );
  }

  if (value.startsWith("data:")) return stripDataUri(value);
  if (/^https?:\/\//i.test(value)) {
    return downloadAsBase64(value, 60_000);
  }
  return value;
}
