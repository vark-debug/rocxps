/**
 * 文档重定位（纯函数，不依赖 Photoshop，可在 Node 单测）。
 *
 * 背景：贴回改为按捕获时的 docId 定位，不再要求目标文档是前台。
 * - `Document.id` 在文档打开期间稳定（另存为不换 id，关闭重开换新 id），
 *   所以首选按 id 命中；
 * - 文档被关闭重开后 id 会变，此时按「路径 + 画布尺寸」做次级匹配；
 * - 未保存文档没有 path，退化为「文档名 + 画布尺寸」；
 * - 云文档的 path 是标识符而不是文件系统路径，只有以 `/` 开头的才参与路径匹配。
 *
 * 任何次级匹配都必须唯一，否则宁可转人工，也不要把结果贴到错误的文档。
 */

export interface DocCandidate {
  id: number;
  name: string;
  /** 文件系统路径；未保存 / 云文档可能为空或标识符。 */
  path: string;
  width: number;
  height: number;
}

export interface CaptureIdentity {
  docId: number;
  docName?: string;
  docPath?: string;
  canvasWidth?: number;
  canvasHeight?: number;
}

export type MatchKind = "id" | "path" | "name";

/**
 * 目标文档是否仍处于打开状态。
 * 后台写入（batchPlay / imaging）必须以显式 docId 定位；执行前若该 id 已不在
 * 打开列表中，必须转「落盘 + 等原文档」分支，绝不能落到当前活动文档。
 */
export const isDocumentOpen = (
  docId: number,
  openDocIds: readonly number[],
): boolean => openDocIds.includes(docId);

export interface DocMatchResult {
  /** 命中时为目标文档 id；未命中 / 多命中时为空。 */
  docId?: number;
  kind?: MatchKind;
  /** 参与最后一次匹配的候选（用于提示「找到多个候选」）。 */
  candidates: DocCandidate[];
}

/**
 * 路径归一化：
 * - 去掉 `file://` 协议前缀（`file:///a/b` → `/a/b`）；
 * - 去掉尾部斜杠；
 * - macOS 的 `/private/var/...` 与 `/var/...` 是同一路径，统一剥掉 `/private` 前缀；
 * - 不做小写化（大小写敏感文件系统与 Unicode 名会被破坏），也不做 percent 解码。
 */
export const normalizePath = (input: string | null | undefined): string => {
  let path = (input ?? "").trim();
  if (!path) return "";
  if (path.startsWith("file://")) path = path.slice("file://".length);
  path = path.replace(/\/+$/, "");
  if (path.startsWith("/private/")) path = path.slice("/private".length);
  return path;
};

/** 只有绝对路径才可能是文件系统路径；云文档的标识符（如 `adobe-cloud-id`）不参与比较。 */
const isPathComparable = (normalized: string): boolean => normalized.startsWith("/");

const sizeMatches = (candidate: DocCandidate, identity: CaptureIdentity): boolean => {
  const width = identity.canvasWidth ?? 0;
  const height = identity.canvasHeight ?? 0;
  // 捕获数据里没有尺寸时无法校验，只能接受（仍要求唯一命中）
  if (width <= 0 || height <= 0) return true;
  return candidate.width === width && candidate.height === height;
};

/**
 * 按 id → 路径+尺寸 → 名称+尺寸的顺序定位文档。
 * 任一步出现多个候选都立即停止并返回候选列表（由调用方转人工）。
 */
export const matchDocument = (
  candidates: readonly DocCandidate[],
  identity: CaptureIdentity,
): DocMatchResult => {
  const byId = candidates.filter((c) => c.id === identity.docId);
  if (byId.length === 1) {
    return { docId: byId[0].id, kind: "id", candidates: byId };
  }

  const wantedPath = normalizePath(identity.docPath);
  if (isPathComparable(wantedPath)) {
    const hits = candidates.filter(
      (c) => normalizePath(c.path) === wantedPath && sizeMatches(c, identity),
    );
    if (hits.length === 1) return { docId: hits[0].id, kind: "path", candidates: hits };
    if (hits.length > 1) return { candidates: hits };
  }

  const wantedName = (identity.docName ?? "").trim();
  if (wantedName) {
    const hits = candidates.filter(
      (c) => c.name === wantedName && sizeMatches(c, identity),
    );
    if (hits.length === 1) return { docId: hits[0].id, kind: "name", candidates: hits };
    if (hits.length > 1) return { candidates: hits };
  }

  return { candidates: [] };
};
