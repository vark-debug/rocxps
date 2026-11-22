import type { CaptureResult } from "../ps/capture";
import type { ExpandCaptureResult } from "../ps/expandCapture";
import type { QueueJob, QueueStatus } from "./queue";
import {
  FAILED_RETENTION_MS,
  QUEUE_HARD_LIMIT,
  QUEUE_LIMIT,
  enforceHardLimitOnLoad,
  findEvictableFinishedJob,
  isFinishedQueueStatus,
} from "./queue";

/**
 * 队列落盘（queue.json + queue/<jobId>/ 目录）。
 *
 * - 队列项只存路径与元数据；抓取结果在入队时立刻写入磁盘，避免 188MB 级快照驻留内存；
 * - 完成项删除大文件只留缩略图；失败 / 取消 / 等原文档保留输入文件（默认 7 天，可按 LRU 上限清理）；
 * - 启动时清理孤儿目录、把上次会话遗留的 running 标为 failed（可重试，不自动续跑）。
 *
 * 纯函数（序列化 / 磁盘清理计划）与 UXP 适配层放在同一文件：
 * 纯函数可被 Node 单测直接使用，UXP 适配层只在宿主里调用。
 */

export const QUEUE_VERSION = 1;
export const QUEUE_META_FILE = "redraw-queue.json";
export const QUEUE_FOLDER = "redraw-queue";
/** 磁盘 LRU 默认上限（用户拍板 2GB，可在设置调整）。 */
export const DEFAULT_QUEUE_DISK_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export interface QueueMeta {
  version: number;
  jobs: QueueJob[];
  /** 队列暂停（不执行新任务，仍照常入队）；缺省 false（旧文件兼容）。 */
  paused?: boolean;
}

const REQUIRED_JOB_FIELDS: Array<keyof QueueJob> = [
  "id",
  "prompt",
  "providerId",
  "docId",
  "docName",
  "refPath",
  "maskPath",
  "sendMaskPath",
  "maskPngPath",
  "status",
  "createdAt",
];

/** 序列化（紧凑 JSON：路径与元数据都很短，不需要缩进）。 */
export const serializeQueue = (
  jobs: readonly QueueJob[],
  paused = false,
): string =>
  JSON.stringify({
    version: QUEUE_VERSION,
    jobs: [...jobs],
    paused,
  } satisfies QueueMeta);

/** 解析并过滤损坏条目：单条损坏不应让整个队列丢失。 */
export const parseQueue = (
  text: string,
): { jobs: QueueJob[]; paused: boolean } => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { jobs: [], paused: false };
  }
  const raw = parsed as Partial<QueueMeta> | null;
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.jobs))
    return { jobs: [], paused: false };
  const jobs: QueueJob[] = [];
  for (const item of raw.jobs) {
    if (!item || typeof item !== "object") continue;
    const job = item as QueueJob;
    if (REQUIRED_JOB_FIELDS.some((field) => job[field] === undefined)) continue;
    jobs.push(job);
  }
  return { jobs, paused: raw.paused === true };
};

/* ---------------- 磁盘清理计划（纯函数） ---------------- */

export interface DiskCleanupOptions {
  maxBytes: number;
  now: number;
  retentionMs?: number;
}

export interface DiskCleanupPlan {
  /** 需要删除文件的 job id（保留元数据与状态，UI 标注「输入文件已清理」）。 */
  purge: string[];
  totalBytes: number;
  keptBytes: number;
}

const jobBytes = (job: QueueJob): number =>
  (job.inputBytes ?? 0) + (job.resultBytes ?? 0) + (job.thumbBytes ?? 0);

const canPurge = (job: QueueJob): boolean =>
  !job.filesPruned && (job.status === "failed" || job.status === "cancelled" || job.status === "completed");

/**
 * 计算需要清理文件的项：
 * 1) 失败/取消超过保留期（默认 7 天）；
 * 2) 仍超磁盘上限时，按结束时间从旧到新清理终态项；
 * 3) 排队 / 运行 / 待贴回 / 等原文档永不清理（等原文档走 documentMissing，保留结果）。
 */
export const planDiskCleanup = (
  jobs: readonly QueueJob[],
  options: DiskCleanupOptions,
): DiskCleanupPlan => {
  const retentionMs = options.retentionMs ?? FAILED_RETENTION_MS;
  const purge: string[] = [];
  let keptBytes = 0;
  let totalBytes = 0;
  for (const job of jobs) {
    const bytes = jobBytes(job);
    totalBytes += bytes;
    if (job.filesPruned) continue;
    if (job.documentMissing) {
      keptBytes += bytes;
    }
  }

  // 1) 过期终态项
  for (const job of jobs) {
    if (!canPurge(job) || job.documentMissing) continue;
    const at = job.finishedAt ?? job.createdAt;
    if (options.now - at >= retentionMs) {
      purge.push(job.id);
      totalBytes -= jobBytes(job);
    }
  }

  // 2) 超上限：按结束时间从旧到新清理终态项
  if (totalBytes > options.maxBytes) {
    const candidates = jobs
      .filter(
        (job) =>
          canPurge(job) &&
          !job.documentMissing &&
          !purge.includes(job.id) &&
          (job.status === "failed" || job.status === "cancelled"),
      )
      .sort((a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt));
    for (const job of candidates) {
      if (totalBytes <= options.maxBytes) break;
      purge.push(job.id);
      totalBytes -= jobBytes(job);
    }
  }

  keptBytes = totalBytes;
  return { purge, totalBytes, keptBytes };
};

/** 孤儿目录：queue/ 下不在 jobs 里的目录名。 */
export const planOrphanDirs = (
  jobIds: readonly string[],
  folderNames: readonly string[],
): string[] => {
  const known = new Set(jobIds);
  return folderNames.filter((name) => !known.has(name));
};

/** 启动恢复：上次会话遗留的 running 一律标失败（可重试），pendingPlace 保持不变。 */
export const recoverInterruptedJobs = (
  jobs: readonly QueueJob[],
  now: number,
): QueueJob[] =>
  jobs.map((job) => {
    if (job.status !== "running") return job;
    return {
      ...job,
      status: "failed" as QueueStatus,
      stage: "queued",
      error: "Photoshop 已重启，任务在执行中断开；输入文件已保留，可重试（不会自动续跑）",
      finishedAt: now,
      remoteJobId: undefined,
      cancelRequestedAt: undefined,
      progress: undefined,
    };
  });

/* ---------------- UXP 适配层 ---------------- */

interface UXPFileLike {
  nativePath?: string;
  write(
    data: string | ArrayBuffer,
    options?: { format?: symbol },
  ): Promise<void>;
  read(options?: { format?: symbol }): Promise<string | ArrayBuffer>;
  delete?(): Promise<void>;
}

interface UXPFolderLike {
  nativePath?: string;
  createFile(
    name: string,
    options?: { overwrite?: boolean },
  ): Promise<UXPFileLike>;
  createFolder(name: string): Promise<UXPFolderLike>;
  getEntry(name: string): Promise<UXPFileLike | undefined>;
  getEntries?(): Promise<Array<{ name?: string; isFolder?: boolean; delete?(): Promise<void> }>>;
  delete?(): Promise<void>;
}

interface UXPStorageLike {
  localFileSystem: { getDataFolder(): Promise<UXPFolderLike> };
  formats: { binary: symbol; utf8?: symbol };
}

/**
 * 避免在单测环境 import ../globals（那里顶层访问 window / require）。
 * UXP 是 CommonJS 环境，`require` 是模块级函数；Node ESM 里 typeof 判断安全，
 * 拿不到时返回 undefined，队列在非宿主环境自动退化为纯内存（单测友好）。
 */
const getStorage = (): UXPStorageLike | undefined => {
  try {
    const req =
      typeof require === "function"
        ? require
        : (globalThis as { require?: (name: string) => unknown }).require;
    if (typeof req !== "function") return undefined;
    return (req("uxp") as { storage?: UXPStorageLike })?.storage;
  } catch {
    return undefined;
  }
};

const storageAvailable = (): boolean => Boolean(getStorage()?.localFileSystem && getStorage()?.formats?.binary);

const binaryFormat = (): symbol | undefined => getStorage()?.formats?.binary;

export interface CaptureFiles {
  refPath: string;
  maskPath: string;
  sendMaskPath: string;
  maskPngPath: string;
  inputBytes: number;
}

/** expand 任务的落盘产物：只有源图，无蒙版。 */
export interface ExpandCaptureFiles {
  refPath: string;
  inputBytes: number;
}

export interface LoadedCapture {
  pngBase64: string;
  maskPngBase64: string;
  mask: { width: number; height: number; data: Uint8Array };
  sendMask: { width: number; height: number; data: Uint8Array };
}

const base64ToBytes = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
};

const readBinary = async (file: UXPFileLike): Promise<Uint8Array> => {
  const data = await file.read({ format: binaryFormat() });
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  throw new Error("队列文件读取失败：返回内容不是二进制");
};

const writeBinary = async (
  folder: UXPFolderLike,
  name: string,
  bytes: Uint8Array,
): Promise<{ path: string; size: number }> => {
  const file = await folder.createFile(name, { overwrite: true });
  await file.write(bytes.buffer as ArrayBuffer, { format: binaryFormat() });
  return { path: file.nativePath ?? name, size: bytes.length };
};

export type QueueListener = () => void;

/**
 * 队列 store：内存列表 + 落盘。
 * 所有修改立即通知订阅者；落盘串行化并在下一次微任务合并写入。
 */
export class QueueStore {
  private jobs: QueueJob[] = [];
  /** 队列暂停（持久化于 queue.json；缺省 false 兼容旧文件）。 */
  private paused = false;
  private listeners = new Set<QueueListener>();
  private queueFolder: UXPFolderLike | null = null;
  private rootFolder: UXPFolderLike | null = null;
  private saveChain: Promise<void> = Promise.resolve();
  private saveQueued = false;
  private initPromise: Promise<void> | null = null;

  list(): QueueJob[] {
    return this.jobs;
  }

  subscribe(cb: QueueListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }

  /** 读取磁盘队列、恢复中断任务、清理孤儿目录与过期文件（幂等）。 */
  init(maxBytes = DEFAULT_QUEUE_DISK_LIMIT_BYTES): Promise<void> {
    if (!this.initPromise) this.initPromise = this.doInit(maxBytes);
    return this.initPromise;
  }

  private async doInit(maxBytes: number): Promise<void> {
    const storage = getStorage();
    if (!storageAvailable() || !storage) {
      this.notify();
      return;
    }
    this.rootFolder = await storage.localFileSystem.getDataFolder();
    try {
      this.queueFolder = await this.rootFolder.createFolder(QUEUE_FOLDER);
    } catch {
      this.queueFolder =
        ((await this.rootFolder.getEntry(QUEUE_FOLDER)) as unknown as UXPFolderLike) ?? null;
    }
    try {
      const file = await this.rootFolder.getEntry(QUEUE_META_FILE);
      if (file) {
        const text = await file.read();
        const parsed = parseQueue(typeof text === "string" ? text : "");
        this.jobs = parsed.jobs;
        this.paused = parsed.paused;
      }
    } catch {
      this.jobs = [];
    }
    // 恢复时不按旧 QUEUE_LIMIT 截断（未执行的不淘汰）；只做失控保护（超硬上限先裁终态）
    this.jobs = enforceHardLimitOnLoad(recoverInterruptedJobs(this.jobs, Date.now()));
    await this.cleanOrphans();
    this.enforceDiskLimit(maxBytes);
    this.notify();
  }

  private async cleanOrphans(): Promise<void> {
    if (!this.queueFolder?.getEntries) return;
    try {
      const entries = await this.queueFolder.getEntries();
      const names = entries
        .filter((e): e is { name: string } => typeof e.name === "string")
        .map((e) => e.name);
      const orphans = planOrphanDirs(this.jobs.map((j) => j.id), names);
      for (const name of orphans) {
        const entry = entries.find((e) => e.name === name);
        try {
          await entry?.delete?.();
        } catch {
          /* 单个目录删除失败不影响启动 */
        }
      }
    } catch {
      /* 列目录失败时跳过清理 */
    }
  }

  private scheduleSave(): void {
    if (this.saveQueued) return;
    this.saveQueued = true;
    this.saveChain = this.saveChain
      .then(async () => {
        this.saveQueued = false;
        if (!this.rootFolder) return;
        const file = await this.rootFolder.createFile(QUEUE_META_FILE, { overwrite: true });
        await file.write(serializeQueue(this.jobs, this.paused));
      })
      .catch(() => undefined);
  }

  /** 队列是否还能接纳新任务（终态项可自动淘汰腾位；仅失控保护硬上限会拒绝）。 */
  hasCapacity(): boolean {
    // 终态项总能被 add() 自动淘汰腾位，唯一拒绝条件是失控保护硬上限
    return this.jobs.length < QUEUE_HARD_LIMIT;
  }

  add(job: QueueJob): void {
    // 新项在前（UI 顺序）。容量语义（「未执行的不淘汰，执行结束的淘汰」）：
    // completed/cancelled 超过 QUEUE_LIMIT 时自动淘汰最旧；failed / 排队 / 运行中绝不淘汰；
    // 只有总数超过 QUEUE_HARD_LIMIT 才拒绝入队（失控保护）。
    this.jobs = [job, ...this.jobs];
    if (this.jobs.length > QUEUE_LIMIT) {
      let finished = this.jobs.filter((item) => isFinishedQueueStatus(item.status));
      while (finished.length > QUEUE_LIMIT) {
        const evictable = findEvictableFinishedJob(this.jobs);
        if (!evictable) break;
        this.jobs = this.jobs.filter((item) => item.id !== evictable.id);
        void this.removeFiles(evictable, { keepThumb: false });
        finished = this.jobs.filter((item) => isFinishedQueueStatus(item.status));
      }
    }
    if (this.jobs.length > QUEUE_HARD_LIMIT) {
      // 回滚并拒绝入队（调用方会提示用户先执行或清理）
      this.jobs = this.jobs.filter((item) => item.id !== job.id);
      throw new Error(
        `任务队列积压过多（超过 ${QUEUE_HARD_LIMIT} 条），请先执行或清理队列`,
      );
    }
    this.notify();
    this.scheduleSave();
  }

  /** 队列是否暂停（不执行新任务，仍照常入队）。持久化在 queue.json。 */
  isPaused(): boolean {
    return this.paused;
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    this.notify();
    this.scheduleSave();
  }

  /** 排队中（尚未启动）的任务数——暂停按钮的积压显示。 */
  pendingCount(): number {
    return this.jobs.filter((job) => job.status === "queued").length;
  }

  update(id: string, patch: Partial<QueueJob>): QueueJob | undefined {
    let updated: QueueJob | undefined;
    this.jobs = this.jobs.map((job) => {
      if (job.id !== id) return job;
      updated = { ...job, ...patch };
      return updated;
    });
    if (updated) {
      this.notify();
      this.scheduleSave();
    }
    return updated;
  }

  get(id: string): QueueJob | undefined {
    return this.jobs.find((job) => job.id === id);
  }

  /** 从队列移除（不自动删文件；调用方按需 removeFiles）。 */
  remove(id: string): QueueJob | undefined {
    const job = this.get(id);
    if (!job) return undefined;
    this.jobs = this.jobs.filter((item) => item.id !== id);
    this.notify();
    this.scheduleSave();
    return job;
  }

  /** 清空全部已完成/已取消项（保留失败项，便于查看原因与重试）。 */
  clearFinished(): QueueJob[] {
    const removed = this.jobs.filter(
      (job) => job.status === "completed" || job.status === "cancelled",
    );
    this.jobs = this.jobs.filter(
      (job) => job.status !== "completed" && job.status !== "cancelled",
    );
    for (const job of removed) void this.removeFiles(job, { keepThumb: job.status === "completed" });
    this.notify();
    this.scheduleSave();
    return removed;
  }

  /** 按设置里的磁盘上限清理文件（不动状态）。 */
  enforceDiskLimit(maxBytes: number): void {
    const plan = planDiskCleanup(this.jobs, { maxBytes, now: Date.now() });
    if (plan.purge.length === 0) return;
    this.jobs = this.jobs.map((job) =>
      plan.purge.includes(job.id) ? { ...job, filesPruned: true } : job,
    );
    for (const id of plan.purge) {
      const job = this.jobs.find((item) => item.id === id);
      if (job) void this.removeFiles({ ...job, filesPruned: false }, { keepThumb: false });
    }
    this.notify();
    this.scheduleSave();
  }

  /** 把抓取结果写入 queue/<jobId>/，返回路径与总字节数。 */
  async persistCapture(id: string, capture: CaptureResult): Promise<CaptureFiles> {
    await this.init();
    if (!storageAvailable()) {
      throw new Error("当前宿主不支持 UXP 本地文件系统，无法把抓取结果落盘");
    }
    if (!this.queueFolder) throw new Error("队列目录不可用");
    const folder = await this.ensureJobFolder(id);
    const ref = await writeBinary(folder, "ref.png", base64ToBytes(capture.pngBase64));
    const mask = await writeBinary(folder, "mask.bin", capture.mask.data);
    const sendMask = await writeBinary(folder, "mask-send.bin", capture.sendMask.data);
    const maskPng = await writeBinary(folder, "mask.png", base64ToBytes(capture.maskPngBase64));
    return {
      refPath: ref.path,
      maskPath: mask.path,
      sendMaskPath: sendMask.path,
      maskPngPath: maskPng.path,
      inputBytes: ref.size + mask.size + sendMask.size + maskPng.size,
    };
  }

  /** expand 任务只落源图 ref.png（无蒙版），返回路径与字节数。 */
  async persistExpandCapture(
    id: string,
    capture: ExpandCaptureResult,
  ): Promise<ExpandCaptureFiles> {
    await this.init();
    if (!storageAvailable()) {
      throw new Error("当前宿主不支持 UXP 本地文件系统，无法把抓取结果落盘");
    }
    if (!this.queueFolder) throw new Error("队列目录不可用");
    const folder = await this.ensureJobFolder(id);
    const ref = await writeBinary(folder, "ref.png", base64ToBytes(capture.pngBase64));
    return { refPath: ref.path, inputBytes: ref.size };
  }

  /** expand 生成只需源图 base64（无蒙版可读）。 */
  async loadExpandCapture(job: QueueJob): Promise<string> {
    const bytes = await readBinary(await this.resolveFile(job.refPath));
    return bytesToBase64(bytes);
  }

  /** 从磁盘重建生成所需的像素 / 蒙版。 */
  async loadCapture(job: QueueJob): Promise<LoadedCapture> {
    const read = async (path: string): Promise<Uint8Array> => {
      const file = await this.resolveFile(path);
      return readBinary(file);
    };
    const [ref, mask, sendMask, maskPng] = await Promise.all([
      read(job.refPath),
      read(job.maskPath),
      read(job.sendMaskPath),
      read(job.maskPngPath),
    ]);
    return {
      pngBase64: bytesToBase64(ref),
      maskPngBase64: bytesToBase64(maskPng),
      mask: {
        width: job.expanded.width,
        height: job.expanded.height,
        data: mask,
      },
      sendMask: {
        width: job.sendWidth,
        height: job.sendHeight,
        data: sendMask,
      },
    };
  }

  /** 只读取贴回所需的灰色蒙版（不必把 188MB 的参考图重新读回）。 */
  async loadMask(job: QueueJob): Promise<{ width: number; height: number; data: Uint8Array }> {
    const bytes = await readBinary(await this.resolveFile(job.maskPath));
    return {
      width: job.expanded.width,
      height: job.expanded.height,
      data: bytes,
    };
  }

  /** 读取生成结果（base64，无 data: 前缀）用于贴回。 */
  async loadResultBase64(job: QueueJob): Promise<string> {
    if (!job.resultPath) throw new Error("该任务没有可贴回的生成结果");
    const bytes = await readBinary(await this.resolveFile(job.resultPath));
    return bytesToBase64(bytes);
  }

  /** 写入生成结果与缩略图；返回路径与字节数。 */
  async writeResult(
    id: string,
    resultBase64: string,
    thumbBytes?: Uint8Array,
  ): Promise<{ resultPath: string; thumbPath?: string; resultBytes: number; thumbBytes: number }> {
    const folder = await this.ensureJobFolder(id);
    const result = await writeBinary(folder, "result.png", base64ToBytes(resultBase64));
    let thumb: { path: string; size: number } | undefined;
    if (thumbBytes) thumb = await writeBinary(folder, "thumb.png", thumbBytes);
    return {
      resultPath: result.path,
      thumbPath: thumb?.path,
      resultBytes: result.size,
      thumbBytes: thumb?.size ?? 0,
    };
  }

  /** 缩略图 data URI（只读小图，不把 188MB 结果读回界面）。 */
  async readThumbDataUri(job: QueueJob): Promise<string | undefined> {
    if (!job.thumbPath) return undefined;
    try {
      const bytes = await readBinary(await this.resolveFile(job.thumbPath));
      const mime = bytes[0] === 0xff && bytes[1] === 0xd8 ? "image/jpeg" : "image/png";
      return `data:${mime};base64,${bytesToBase64(bytes)}`;
    } catch {
      return undefined;
    }
  }

  /** 删除任务目录中的大文件；keepThumb 时只保留 thumb.png。 */
  async removeFiles(job: QueueJob, options: { keepThumb: boolean }): Promise<void> {
    if (!this.queueFolder) return;
    try {
      const folder = (await this.queueFolder.getEntry(job.id)) as unknown as UXPFolderLike | undefined;
      if (!folder?.getEntries) return;
      const entries = await folder.getEntries();
      for (const entry of entries) {
        if (options.keepThumb && entry.name === "thumb.png") continue;
        try {
          await entry.delete?.();
        } catch {
          /* 单个文件删除失败不影响其他清理 */
        }
      }
    } catch {
      /* 目录不存在 / 删除失败忽略 */
    }
  }

  private async ensureJobFolder(id: string): Promise<UXPFolderLike> {
    if (!this.queueFolder) throw new Error("队列目录不可用");
    try {
      return await this.queueFolder.createFolder(id);
    } catch {
      return (await this.queueFolder.getEntry(id)) as unknown as UXPFolderLike;
    }
  }

  private async resolveFile(path: string): Promise<UXPFileLike> {
    if (!this.queueFolder) throw new Error("队列目录不可用");
    // 路径是绝对 nativePath：用最后两段（jobId / 文件名）回到队列目录取文件
    const parts = path.split(/[\\/]/).filter(Boolean);
    const name = parts.pop();
    const jobId = parts.pop();
    if (!name || !jobId) throw new Error(`无法解析队列文件路径：${path}`);
    const folder = (await this.queueFolder.getEntry(jobId)) as unknown as UXPFolderLike | undefined;
    const file = folder ? await folder.getEntry(name) : undefined;
    if (!file) throw new Error(`队列文件不存在：${jobId}/${name}`);
    return file;
  }
}
