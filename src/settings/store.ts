import { uxp } from "../globals";
import {
  RH_DEFAULT_BODY_TEMPLATE,
  RH_QWEN_BODY_LEGACY,
} from "../providers/catalog";
import type { ProviderId } from "../providers/types";
import {
  normalizeSiliconTarget,
  normalizeSiliconTargetPolicy,
} from "../providers/siliconedTarget";
import {
  normalizePresetId,
  normalizeSizeMode,
} from "../ps/presetFit";
import { normalizePromptTemplates } from "./templates";
import { DEFAULT_SETTINGS, RedrawSettings, TEMPLATE_SLOTS } from "./types";
import { normalizeUpscaleLongSide } from "../core/upscalePlan";

/**
 * API Key 存 secureStorage（加密），其余设置存 plugin data folder 的 JSON。
 * uxp.types 对 storage 子模块的类型不完整，这里用最小结构接口直接取用。
 */
const SETTINGS_FILE = "redraw-settings.json";

/** 按平台分开存 Key；ark 沿用旧键名，老用户已保存的 Key 无需重填。 */
const KEY_NAMES: Record<ProviderId, string> = {
  ark: "arkApiKey",
  runninghub: "runninghubApiKey",
  comfyui: "comfyuiApiKey",
  // Siliconed 走本机 CLI，无 API Key；保留键名以满足 ProviderId 全覆盖
  siliconed: "siliconedApiKey",
  // IOPaint 同样走本机 HTTP 服务，无鉴权
  iopaint: "iopaintApiKey",
  custom: "customApiKey",
};

interface UXPFileLike {
  read(): Promise<string>;
  write(text: string): Promise<void>;
}
interface UXPFolderLike {
  getEntry(name: string): Promise<UXPFileLike | undefined>;
  createFile(
    name: string,
    options: { overwrite?: boolean },
  ): Promise<UXPFileLike>;
}
interface UXPFileSystem {
  localFileSystem: { getDataFolder(): Promise<UXPFolderLike> };
  secureStorage?: {
    setItem(key: string, value: string): Promise<void>;
    getItem(key: string): Promise<Uint8Array>;
    removeItem(key: string): Promise<void>;
  };
}

const storage = (uxp as unknown as { storage: UXPFileSystem }).storage;

/** UXP（PS 24.x）未暴露全局 TextDecoder，自行实现 UTF-8 解码。 */
const decodeUtf8 = (bytes: Uint8Array): string => {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) |
          ((bytes[i + 1] & 0x3f) << 6) |
          (bytes[i + 2] & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      out += String.fromCharCode(
        0xd800 + ((cp - 0x10000) >> 10),
        0xdc00 + ((cp - 0x10000) & 0x3ff),
      );
      i += 4;
    }
  }
  return out;
};

const getSecureStorage = () => {
  if (!storage.secureStorage) {
    throw new Error("secureStorage 不可用（需要 Photoshop 24.2+）");
  }
  return storage.secureStorage;
};

// ---------- API Key ----------

export const saveApiKey = async (
  provider: ProviderId,
  key: string,
): Promise<void> => {
  await getSecureStorage().setItem(KEY_NAMES[provider], key);
};

export const loadApiKey = async (provider: ProviderId): Promise<string> => {
  const data = await getSecureStorage().getItem(KEY_NAMES[provider]);
  if (!data || data.length === 0) return "";
  return decodeUtf8(data);
};

export const clearApiKey = async (provider: ProviderId): Promise<void> => {
  await getSecureStorage().removeItem(KEY_NAMES[provider]);
};

// ---------- 常规设置 ----------

export const loadSettings = async (): Promise<RedrawSettings> => {
  try {
    const folder = await storage.localFileSystem.getDataFolder();
    const file = await folder.getEntry(SETTINGS_FILE);
    if (!file) return { ...DEFAULT_SETTINGS };
    const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(await file.read()) };
    // 旧版千问模板只传原图，升级后自动补上通道图；用户自定义过的模板不受影响
    if (merged.rhBodyTemplate === RH_QWEN_BODY_LEGACY) {
      merged.rhBodyTemplate = RH_DEFAULT_BODY_TEMPLATE;
    }
    // 提示词模板槽位固定：旧配置缺字段或长度不符时补齐 / 截断，避免主面板渲染越界；
    // 老模板没有 providerId（跟随当前服务商），未知 providerId 原样保留供 UI 标记失效
    merged.promptTemplates = normalizePromptTemplates(
      merged.promptTemplates,
      TEMPLATE_SLOTS,
    );
    // 队列折叠开关：旧配置缺字段 / 非布尔值一律按「展开」处理
    merged.queueCollapsed = merged.queueCollapsed === true;
    // 尺寸模式 / 固定预设做归一化：旧配置缺字段或存了非法值时回退默认
    merged.sizeMode = normalizeSizeMode(merged.sizeMode);
    merged.fixedPresetId = normalizePresetId(merged.fixedPresetId);
    // 跨机设置做归一化：旧配置缺字段或存了非法值时回退「本机 + 自动切换」
    merged.siliconedComputeTarget = normalizeSiliconTarget(
      merged.siliconedComputeTarget,
    );
    merged.siliconedTargetMac =
      typeof merged.siliconedTargetMac === "string"
        ? merged.siliconedTargetMac
        : "";
    // 选了「指定 Mac」但没有 id（旧配置 / 手改）：回退本机，避免提交时必然 blocked
    if (merged.siliconedComputeTarget === "mac" && !merged.siliconedTargetMac.trim()) {
      merged.siliconedComputeTarget = "local";
    }
    merged.siliconedTargetPolicy = normalizeSiliconTargetPolicy(
      merged.siliconedTargetPolicy,
    );
    // 处理方式：旧配置缺字段或非法值回退「自动」
    merged.siliconedMode =
      merged.siliconedMode === "remove" || merged.siliconedMode === "redraw"
        ? merged.siliconedMode
        : "auto";
    // 超分目标长边：旧配置缺字段或非法值回退 4096
    merged.upscaleLongSide = normalizeUpscaleLongSide(merged.upscaleLongSide);
    // 诊断开关默认关闭；磁盘上限默认 2GB（旧配置缺字段时补齐）
    merged.debugDiag = merged.debugDiag === true;
    const diskMb = Number(merged.queueDiskLimitMB);
    merged.queueDiskLimitMB =
      Number.isFinite(diskMb) && diskMb > 0 ? Math.round(diskMb) : 2048;
    return merged;
  } catch {
    // 首次运行 / 文件损坏时回退默认值
    return { ...DEFAULT_SETTINGS };
  }
};

export const saveSettings = async (settings: RedrawSettings): Promise<void> => {
  const folder = await storage.localFileSystem.getDataFolder();
  const file = await folder.createFile(SETTINGS_FILE, { overwrite: true });
  await file.write(JSON.stringify(settings, null, 2));
};
