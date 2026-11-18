/**
 * 贴回诊断日志（只观测，不改变贴回行为）。
 *
 * 目的：定位“A 正确贴回 + B 的选中图层额外出现全白蒙版”。
 * 关键观测点：
 * - 构建指纹：证明 PS 里加载的是哪一版 dist；
 * - make / putLayerMask / putPixels 的调用计数与调用点标签；
 * - 每次 batchPlay 的完整 descriptor 与返回原文；
 * - make 前后、putLayerMask 前后的「所有文档 → 所有图层 → 是否有 user mask / 是否全白」快照。
 *
 * 日志同时进入 console 与内存缓冲，可通过面板复制或导出到 ~/Desktop。
 */

import { photoshop, uxp, os } from "../globals";
import type { Document } from "photoshop/dom/Document";
import type { Layer } from "photoshop/dom/Layer";

/** 由 vite.config.ts 的 define 注入；单测（esbuild）环境下不存在，用 typeof 兜底。 */
declare const __BUILD_STAMP__: string;

export const BUILD_STAMP: string =
  typeof __BUILD_STAMP__ === "string" && __BUILD_STAMP__
    ? __BUILD_STAMP__
    : "未知（未注入构建指纹）";

export interface DiagEntry {
  seq: number;
  at: string;
  step: string;
  data?: unknown;
}

const MAX_ENTRIES = 600;
/** 关键事件环：无论调试开关是否开启都保留，最多 50 条（异常 / 降级 / 等原文档）。 */
const MAX_KEY_ENTRIES = 50;
const entries: DiagEntry[] = [];
const keyEntries: DiagEntry[] = [];
let seq = 0;
let sessionStarted = false;
let debugEnabled = false;

/** 调试开关（默认关闭）：关闭时不抓全文档快照、不写逐步日志。 */
export const setDiagEnabled = (enabled: boolean): void => {
  debugEnabled = enabled === true;
};

export const isDiagEnabled = (): boolean => debugEnabled;

/**
 * 关键事件：始终记录（异常、降级、等原文档等），用于默认关闭状态下仍可导出定位。
 * 与 diagLog 分开，避免调试开关关闭时完全丢失现场。
 */
export const diagKey = (step: string, data?: unknown): void => {
  const entry: DiagEntry = {
    seq: ++seq,
    at: new Date().toISOString(),
    step,
    data,
  };
  keyEntries.push(entry);
  if (keyEntries.length > MAX_KEY_ENTRIES) keyEntries.shift();
  try {
    console.log(`[rocxps-diag-key] #${entry.seq} ${entry.at} ${step}`, data ?? "");
  } catch {
    // console 不可用时只保留缓冲
  }
};

const safe = <T>(fn: () => T, fallback: T): T => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};

export const errText = (e: unknown): string => {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
};

const bundleUrl = (): string =>
  safe(() => String((globalThis as { location?: { href?: string } }).location?.href ?? ""), "");

const pluginInfo = (): Record<string, unknown> =>
  safe<Record<string, unknown>>(() => {
    const info = (uxp as unknown as {
      entrypoints?: { _pluginInfo?: { id?: string; name?: string; version?: string } };
    }).entrypoints?._pluginInfo;
    return { id: info?.id, name: info?.name, version: info?.version };
  }, {});

/** 当前已加载的 UXP 插件（用于判断 psedit 是否在同一会话里活动）。 */
export const listLoadedPlugins = (): Array<{ id: string; name: string; version: string }> =>
  safe(() => {
    const manager = (uxp as unknown as {
      pluginManager?: { plugins?: Set<{ id?: string; name?: string; version?: string }> };
    }).pluginManager;
    const plugins = manager?.plugins;
    if (!plugins) return [];
    const out: Array<{ id: string; name: string; version: string }> = [];
    plugins.forEach((p) => {
      out.push({
        id: safe(() => String(p.id ?? ""), "?"),
        name: safe(() => String(p.name ?? ""), "?"),
        version: safe(() => String(p.version ?? ""), "?"),
      });
    });
    return out;
  }, []);

/** 详细日志：仅调试开关开启时记录（console + 内存缓冲，供复制/导出）。 */
export const diagLog = (step: string, data?: unknown): void => {
  if (!debugEnabled) return;
  const entry: DiagEntry = {
    seq: ++seq,
    at: new Date().toISOString(),
    step,
    data,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  try {
    console.log(`[rocxps-diag] #${entry.seq} ${entry.at} ${step}`, data ?? "");
  } catch {
    // console 不可用时只保留缓冲
  }
};

let diagCommand = "";

/** 设置当前 executeAsModal 的 commandName，随每条 batchPlay 日志一起打印。 */
export const setDiagCommand = (name: string): void => {
  diagCommand = name;
};

const activeDocumentId = (): number | null =>
  safe(() => photoshop.app.activeDocument?.id ?? null, null);

const batchContext = (): Record<string, unknown> => ({
  commandName: diagCommand || undefined,
  activeDocumentId: activeDocumentId(),
});

/** 会话级初始化：只记录一次构建指纹、入口 URL、已加载插件。 */
export const ensureDiagSession = (): void => {
  if (sessionStarted) return;
  sessionStarted = true;
  diagKey("会话开始", {
    buildStamp: BUILD_STAMP,
    bundleUrl: bundleUrl(),
    plugin: pluginInfo(),
    psVersion: safe(
      () => String((photoshop.app as unknown as { version?: string })?.version ?? ""),
      "",
    ),
    loadedPlugins: listLoadedPlugins(),
  });
};

/* ---------------- 调用计数 ---------------- */

export type CounterName = "makeLayerMask" | "putLayerMask" | "putPixels";

const counters: Record<CounterName, number> = {
  makeLayerMask: 0,
  putLayerMask: 0,
  putPixels: 0,
};

export const getCounters = (): Record<CounterName, number> => ({ ...counters });

/** 计数并打印调用点；返回该动作的累计次数。 */
export const bumpCounter = (
  name: CounterName,
  callSite: string,
  detail?: unknown,
): number => {
  counters[name] += 1;
  if (debugEnabled) diagLog(`COUNTER ${name} #${counters[name]}`, { callSite, detail });
  return counters[name];
};

export const counterDelta = (
  before: Record<CounterName, number>,
): Record<CounterName, number> => ({
  makeLayerMask: counters.makeLayerMask - before.makeLayerMask,
  putLayerMask: counters.putLayerMask - before.putLayerMask,
  putPixels: counters.putPixels - before.putPixels,
});

/* ---------------- batchPlay 包装 ---------------- */

/**
 * 观测型 batchPlay：记录完整 descriptor、options、返回原文、耗时与异常。
 * 不改变调用参数与执行顺序。
 */
export const diagBatchPlay = async (
  label: string,
  callSite: string,
  descriptors: readonly unknown[],
  options: unknown,
): Promise<unknown[]> => {
  if (!debugEnabled) {
    // 关闭诊断时不做任何额外包装，行为与直接 batchPlay 完全一致
    return (await photoshop.action.batchPlay(
      descriptors as never,
      options as never,
    )) as unknown[];
  }
  diagLog(`${label} · 发出`, { callSite, ...batchContext(), options, descriptors });
  const started = Date.now();
  try {
    const results = (await photoshop.action.batchPlay(
      descriptors as never,
      options as never,
    )) as unknown[];
    diagLog(`${label} · 返回`, {
      callSite,
      ...batchContext(),
      ms: Date.now() - started,
      isError: Array.isArray(results) && results.some((r) => (r as { _obj?: string })?._obj === "error"),
      results,
    });
    return results;
  } catch (e) {
    diagLog(`${label} · 抛出`, {
      callSite,
      ...batchContext(),
      ms: Date.now() - started,
      error: errText(e),
    });
    throw e;
  }
};

/* ---------------- 蒙版快照 ---------------- */

export interface LayerMaskSnapshot {
  layerId: number;
  layerName: string;
  depth: number;
  hasUserMask: boolean;
  /** true = 全白；false = 有非白像素；null = 无蒙版或读取失败。 */
  maskAllWhite: boolean | null;
  maskMin?: number;
  maskMax?: number;
  /** 读取蒙版的错误（用于区分“确实没蒙版”和“读取失败”）。 */
  maskError?: string;
}

export interface DocumentSnapshot {
  docId: number;
  docName: string;
  active: boolean;
  layers: LayerMaskSnapshot[];
  error?: string;
}

const NO_MASK_RE =
  /(does not have|doesn't have|no)\s+(a\s+)?(layer\s+)?mask|not\s+.*mask|layer does not have a mask|没有.*蒙版|无.*蒙版/i;

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`读取蒙版超时（${ms}ms）`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

const readLayerMask = async (
  docId: number,
  layerId: number,
): Promise<Omit<LayerMaskSnapshot, "layerId" | "layerName" | "depth">> => {
  const imaging = photoshop.imaging;
  if (typeof imaging?.getLayerMask !== "function") {
    return { hasUserMask: false, maskAllWhite: null, maskError: "getLayerMask 不可用" };
  }
  try {
    const result = await withTimeout(
      imaging.getLayerMask({
        documentID: docId,
        layerID: layerId,
        kind: "user",
        targetSize: { width: 16, height: 16 },
      }),
      1500,
    );
    const imageData = result?.imageData;
    if (!imageData) {
      return { hasUserMask: false, maskAllWhite: null };
    }
    try {
      const data = await imageData.getData({ chunky: true });
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      if (!Number.isFinite(min) || !Number.isFinite(max)) {
        return { hasUserMask: true, maskAllWhite: null };
      }
      return {
        hasUserMask: true,
        maskAllWhite: min === max && min >= 255,
        maskMin: min,
        maskMax: max,
      };
    } finally {
      try {
        await imageData.dispose();
      } catch {
        // 槽位释放失败不影响观测
      }
    }
  } catch (e) {
    const message = errText(e);
    if (NO_MASK_RE.test(message)) {
      return { hasUserMask: false, maskAllWhite: null };
    }
    return { hasUserMask: false, maskAllWhite: null, maskError: message };
  }
};

/**
 * 回读某个图层的 user 蒙版是否存在（production 用，不是纯观测）。
 *
 * 为什么需要：`imaging.putLayerMask` 在没有 user 蒙版时会**隐式创建**蒙版
 * （2026-11-07 诊断日志已证实），而后台 `make` 无法可靠指定目标文档。
 * 写入后必须回读确认蒙版真的落在目标图层，否则删图层走像素蒙版降级。
 *
 * 返回：
 * - present：读到蒙版；
 * - absent：确认没有蒙版（PS 明确报“没有蒙版”）；
 * - unknown：读取失败/超时/API 不可用，无法判断（调用方只记日志，不降级）。
 */
export type UserMaskProbe = {
  state: "present" | "absent" | "unknown";
  error?: string;
};

export const probeUserMask = async (
  docId: number,
  layerId: number,
): Promise<UserMaskProbe> => {
  const result = await readLayerMask(docId, layerId);
  if (result.hasUserMask) return { state: "present" };
  if (result.maskError) return { state: "unknown", error: result.maskError };
  return { state: "absent" };
};

const collectLayerMasks = async (
  doc: Document,
  layers: readonly Layer[] | undefined,
  depth: number,
  out: LayerMaskSnapshot[],
): Promise<void> => {
  const list = layers ?? [];
  for (let i = 0; i < list.length; i++) {
    const layer = list[i];
    if (!layer) continue;
    const mask = await readLayerMask(doc.id, layer.id);
    out.push({
      layerId: layer.id,
      layerName: safe(() => String(layer.name ?? ""), ""),
      depth,
      ...mask,
    });
    const children = safe(
      () => (layer as Layer & { layers?: Layer[] }).layers,
      undefined as Layer[] | undefined,
    );
    if (children && children.length > 0) {
      await collectLayerMasks(doc, children, depth + 1, out);
    }
  }
};

const snapshotStore = new Map<string, DocumentSnapshot[]>();

export interface MaskDelta {
  docId: number;
  docName: string;
  layerId: number;
  layerName: string;
  allWhite: boolean | null;
}

export interface SnapshotDiff {
  activeBefore: number | null;
  activeAfter: number | null;
  addedMasks: MaskDelta[];
  removedMasks: MaskDelta[];
  layerCountChanges: Array<{
    docId: number;
    docName: string;
    before: number;
    after: number;
  }>;
}

/**
 * 对比两次快照，直接回答：哪一步之后、哪个文档的哪个图层多出了蒙版。
 * 用于把“计数”变成可判定的结论（而不是只看 make 次数）。
 */
export const diffSnapshots = (
  beforeLabel: string,
  afterLabel: string,
): SnapshotDiff | null => {
  const before = snapshotStore.get(beforeLabel);
  const after = snapshotStore.get(afterLabel);
  if (!before || !after) return null;

  const keyOf = (docId: number, layerId: number): string => `${docId}:${layerId}`;
  const beforeLayers = new Map<
    string,
    { doc: DocumentSnapshot; layer: LayerMaskSnapshot }
  >();
  for (const doc of before) {
    for (const layer of doc.layers) {
      beforeLayers.set(keyOf(doc.docId, layer.layerId), { doc, layer });
    }
  }

  const addedMasks: MaskDelta[] = [];
  const removedMasks: MaskDelta[] = [];
  const seen = new Set<string>();
  for (const doc of after) {
    for (const layer of doc.layers) {
      const key = keyOf(doc.docId, layer.layerId);
      seen.add(key);
      const prior = beforeLayers.get(key);
      const hadMask = prior?.layer.hasUserMask ?? false;
      if (!hadMask && layer.hasUserMask) {
        addedMasks.push({
          docId: doc.docId,
          docName: doc.docName,
          layerId: layer.layerId,
          layerName: layer.layerName,
          allWhite: layer.maskAllWhite,
        });
      } else if (hadMask && !layer.hasUserMask && prior) {
        removedMasks.push({
          docId: doc.docId,
          docName: doc.docName,
          layerId: layer.layerId,
          layerName: layer.layerName,
          allWhite: prior.layer.maskAllWhite,
        });
      }
    }
  }
  for (const [key, prior] of beforeLayers) {
    if (seen.has(key)) continue;
    if (prior.layer.hasUserMask) {
      removedMasks.push({
        docId: prior.doc.docId,
        docName: prior.doc.docName,
        layerId: prior.layer.layerId,
        layerName: prior.layer.layerName,
        allWhite: prior.layer.maskAllWhite,
      });
    }
  }

  const layerCountChanges: SnapshotDiff["layerCountChanges"] = [];
  const docIds = new Set<number>();
  for (const doc of before) docIds.add(doc.docId);
  for (const doc of after) docIds.add(doc.docId);
  for (const docId of docIds) {
    const beforeDoc = before.find((d) => d.docId === docId);
    const afterDoc = after.find((d) => d.docId === docId);
    const beforeCount = beforeDoc?.layers.length ?? 0;
    const afterCount = afterDoc?.layers.length ?? 0;
    if (beforeCount !== afterCount) {
      layerCountChanges.push({
        docId,
        docName: afterDoc?.docName ?? beforeDoc?.docName ?? "",
        before: beforeCount,
        after: afterCount,
      });
    }
  }

  return {
    activeBefore: before.find((d) => d.active)?.docId ?? null,
    activeAfter: after.find((d) => d.active)?.docId ?? null,
    addedMasks,
    removedMasks,
    layerCountChanges,
  };
};

const summaryOf = (snapshots: readonly DocumentSnapshot[]): string =>
  snapshots
    .map((s) => {
      const masks = s.layers
        .filter((l) => l.hasUserMask)
        .map((l) => `${l.layerName}#${l.layerId}${l.maskAllWhite ? "(全白)" : ""}`)
        .join(",");
      const failures = s.layers.filter((l) => l.maskError).length;
      return `${s.docName}#${s.docId}${s.active ? "(活动)" : ""} 图层=${s.layers.length} 蒙版=${masks || "无"}${failures ? ` 读取失败=${failures}` : ""}`;
    })
    .join(" | ");

/**
 * 抓取当前所有打开文档 → 所有图层的蒙版状态。
 * 只能在 executeAsModal 内调用（imaging.getLayerMask 需要 modal）。
 */
export const snapshotDocuments = async (label: string): Promise<DocumentSnapshot[]> => {
  // 默认关闭：抓全文档蒙版快照开销大，不开启时直接跳过
  if (!debugEnabled) return [];
  const snapshots: DocumentSnapshot[] = [];
  try {
    const documents = photoshop.app.documents;
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (!doc) continue;
      const snapshot: DocumentSnapshot = {
        docId: doc.id,
        docName: safe(() => String(doc.name ?? ""), ""),
        active: photoshop.app.activeDocument?.id === doc.id,
        layers: [],
      };
      try {
        await collectLayerMasks(doc, doc.layers, 0, snapshot.layers);
      } catch (e) {
        snapshot.error = errText(e);
      }
      snapshots.push(snapshot);
    }
  } catch (e) {
    diagLog(`SNAPSHOT ${label} 失败`, { error: errText(e) });
    return snapshots;
  }
  snapshotStore.set(label, snapshots);
  diagLog(`SNAPSHOT ${label}`, {
    ...batchContext(),
    summary: summaryOf(snapshots),
    documents: snapshots,
  });
  return snapshots;
};

/* ---------------- 报告与导出 ---------------- */

export const buildDiagReport = (): string => {
  ensureDiagSession();
  const lines: string[] = [];
  lines.push("rocxps 贴回诊断日志");
  lines.push(`报告生成时间: ${new Date().toISOString()}`);
  lines.push(`构建指纹: ${BUILD_STAMP}`);
  lines.push(`入口 URL: ${bundleUrl()}`);
  lines.push(`插件: ${JSON.stringify(pluginInfo())}`);
  lines.push(
    `PS 版本: ${safe(() => String((photoshop.app as unknown as { version?: string })?.version ?? ""), "")}`,
  );
  lines.push(`调用计数: ${JSON.stringify(getCounters())}`);
  lines.push(`已加载 UXP 插件: ${JSON.stringify(listLoadedPlugins())}`);
  lines.push(`调试开关: ${debugEnabled ? "开启" : "关闭"}`);
  lines.push("");

  const dump = (label: string, list: readonly DiagEntry[]): void => {
    lines.push(`${label}（共 ${list.length} 条）:`);
    for (const entry of list) {
      lines.push(`#${entry.seq} ${entry.at} ${entry.step}`);
      if (entry.data !== undefined) {
        try {
          lines.push(JSON.stringify(entry.data, null, 2));
        } catch {
          lines.push(String(entry.data));
        }
      }
    }
    lines.push("");
  };

  // 关键事件在调试开关关闭时也保留（≤50 条），保证异常/降级/等原文档仍可定位
  dump(`关键事件（最多 ${MAX_KEY_ENTRIES} 条）`, keyEntries);
  if (debugEnabled) dump("详细日志", entries);
  else lines.push("详细日志：调试开关关闭，仅保留关键事件。");

  return lines.join("\n");
};

const pad = (n: number): string => (n < 10 ? `0${n}` : String(n));

const fileStamp = (): string => {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

interface UXPFsLike {
  createEntryWithUrl?: (url: string, options?: { overwrite?: boolean }) => Promise<{
    write: (data: string, options?: { format?: unknown }) => Promise<void>;
    nativePath?: string;
  }>;
  getDataFolder?: () => Promise<{
    createFile: (name: string, options?: { overwrite?: boolean }) => Promise<{
      write: (data: string, options?: { format?: unknown }) => Promise<void>;
      nativePath?: string;
    }>;
  }>;
}

const uxpFs = (): UXPFsLike | undefined =>
  (uxp as unknown as { storage?: { localFileSystem?: UXPFsLike; formats?: { utf8?: symbol } } })
    .storage?.localFileSystem;

const utf8Format = (): symbol | undefined =>
  (uxp as unknown as { storage?: { formats?: { utf8?: symbol } } }).storage?.formats?.utf8;

const writeTextFile = async (
  file: { write: (data: string, options?: { format?: unknown }) => Promise<void> },
  text: string,
): Promise<void> => {
  const format = utf8Format();
  if (format) {
    await file.write(text, { format });
    return;
  }
  await file.write(text);
};

/** 导出到 ~/Desktop；失败时回退到插件 data 目录。 */
export const exportDiagReport = async (): Promise<{ path: string; warning?: string }> => {
  const text = buildDiagReport();
  const fs = uxpFs();
  const name = `rocxps-placeback-log-${fileStamp()}.txt`;
  let desktopError: unknown;
  const home = safe(() => (typeof os?.homedir === "function" ? os.homedir() : ""), "");
  if (fs?.createEntryWithUrl && home) {
    try {
      const file = await fs.createEntryWithUrl(`file:${home}/Desktop/${name}`, {
        overwrite: true,
      });
      await writeTextFile(file, text);
      return { path: file.nativePath ?? `${home}/Desktop/${name}` };
    } catch (e) {
      desktopError = e;
    }
  }
  if (!fs?.getDataFolder) {
    throw new Error(`导出失败：${desktopError ? errText(desktopError) : "文件系统不可用"}`);
  }
  const folder = await fs.getDataFolder();
  const file = await folder.createFile(name, { overwrite: true });
  await writeTextFile(file, text);
  return {
    path: file.nativePath ?? name,
    warning: desktopError
      ? `桌面导出失败（${errText(desktopError)}），已改存插件数据目录`
      : undefined,
  };
};

/** 复制完整诊断日志到剪贴板。 */
export const copyDiagReport = async (): Promise<void> => {
  const text = buildDiagReport();
  const clipboard = (globalThis as unknown as { navigator?: { clipboard?: {
    write?: (data: Record<string, string>) => Promise<void>;
    writeText?: (data: Record<string, string>) => Promise<void>;
  } } }).navigator?.clipboard;
  if (!clipboard) throw new Error("剪贴板不可用");
  if (typeof clipboard.write === "function") {
    await clipboard.write({ "text/plain": text });
    return;
  }
  if (typeof clipboard.writeText === "function") {
    await clipboard.writeText({ "text/plain": text });
    return;
  }
  throw new Error("剪贴板 API 不可用");
};
