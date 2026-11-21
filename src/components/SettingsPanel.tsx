import { useEffect, useState, type ReactNode } from "react";
import {
  EXPAND_MAX_SAMPLE_DEFAULT,
  normalizeExpandMaxSample,
} from "../ps/expandPlan";
import { maskApiKey } from "../ark/client";
import { siliconMacs } from "../core/silicontrol";
import { probeProvider } from "../providers";
import { modelsForProvider } from "../providers/catalog";
import { isMacHost } from "../providers/host";
import {
  isMacUnusable,
  macStateReason,
  macStateText,
  SILICONED_LOCAL_LABEL,
  type SiliconComputeTarget,
  type SiliconMacsSnapshot,
  type SiliconTargetPolicy,
} from "../providers/siliconedTarget";
import {
  PROVIDERS,
  providerChoices,
  providerLabel,
  providerUsesSingleQueue,
  type ProviderId,
} from "../providers/types";
import {
  clearApiKey,
  loadApiKey,
  loadSettings,
  saveApiKey,
  saveSettings,
} from "../settings/store";
import {
  providerAvailability,
  providerSwitchPatch,
  resolveTemplateProvider,
  rhPresetPatch,
} from "../settings/templates";
import { DEFAULT_SETTINGS, PlaceBackMode, RedrawSettings } from "../settings/types";
import type { PromptTemplate } from "../settings/types";
import { CAPTURE_ALIGN } from "../ps/align";
import { copyDiagReport, exportDiagReport } from "../ps/placeBackDiag";
import type { SizeMode } from "../ps/presetFit";
import { presetLabel, SIZE_PRESETS } from "../ps/presets";

type ProbeState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; text: string }
  | { kind: "error"; text: string };

/** sp-picker 的 change 事件取选中项下标：官方示例用 evt.target.selectedIndex；
 *  若个别版本把事件目标透传为菜单项（无 selectedIndex），回退用 value 匹配。 */
const dropdownIndex = (e: any, values: string[]): number => {
  const target = e?.target;
  const idx = target?.selectedIndex;
  if (typeof idx === "number" && idx >= 0 && idx < values.length) return idx;
  const value = target?.value;
  if (typeof value === "string") {
    const byValue = values.indexOf(value);
    if (byValue >= 0) return byValue;
  }
  return -1;
};

const PLACE_BACK_LABELS: Record<PlaceBackMode, string> = {
  layerMask: "图层蒙版（整块贴回，可在 PS 里编辑蒙版）",
  mask: "像素蒙版合成（只保留选区内的像素）",
  block: "整块替换（不做选区约束）",
};
const PLACE_BACK_VALUES = Object.keys(PLACE_BACK_LABELS) as PlaceBackMode[];

/** 尺寸规划模式：auto 自动匹配已验证预设 / fixed 指定预设 / custom 旧 32 对齐。 */
const SIZE_MODE_LABELS: Record<SizeMode, string> = {
  auto: "自动匹配预设（推荐）",
  fixed: "固定预设",
  custom: `自定义（宽高独立按 ${CAPTURE_ALIGN} 对齐）`,
};
const SIZE_MODE_VALUES = Object.keys(SIZE_MODE_LABELS) as SizeMode[];
const PRESET_IDS = SIZE_PRESETS.map((p) => p.id);

/** Siliconed 跨机：目标与实际不一致时的处理策略。 */
const TARGET_POLICY_LABELS: Record<SiliconTargetPolicy, string> = {
  auto: "自动切换（提交前把 Siliconed 切到目标机）",
  warn: "不切换（按当前实际目标执行，并在历史中标注差异）",
};
const TARGET_POLICY_VALUES = Object.keys(
  TARGET_POLICY_LABELS,
) as SiliconTargetPolicy[];

type MacsState =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "ok"; snapshot: SiliconMacsSnapshot }
  | { kind: "error"; text: string };

/** ComfyUI / Siliconed / IOPaint 都是本地服务或 CLI，不需要鉴权。 */
const needsApiKey = (provider: ProviderId): boolean =>
  provider !== "comfyui" &&
  provider !== "siliconed" &&
  provider !== "iopaint";

const IOPAINT_MODEL_LABELS: Record<string, string> = {
  lama: "LaMa（擦除，快）",
  mat: "MAT（擦除，慢但质量更好）",
};
const IOPAINT_MODEL_VALUES = Object.keys(IOPAINT_MODEL_LABELS);

/** 字段容器：标签行（可选小字说明）+ 控件，纵向排列。 */
const Field = ({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) => (
  <div className="settings-panel__field">
    <div className="settings-panel__field-head">
      <span className="settings-panel__field-label">{label}</span>
      {hint && <span className="settings-panel__field-hint">{hint}</span>}
    </div>
    <span className="settings-panel__field-control">{children}</span>
  </div>
);

/** 单行文本：输入时只更新本地 state（避免逐字符写盘），失焦时落盘。 */
const TextField = ({
  label,
  value,
  placeholder,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}) => (
  <Field label={label}>
    <sp-textfield
      className="settings-panel__textfield"
      value={value}
      placeholder={placeholder}
      oninput={(e: any) => onChange(e.target.value)}
      onblur={(e: any) => onCommit(e.target.value)}
    />
  </Field>
);

/** 多行文本（请求体 / 工作流 JSON）；hint 用来说明可用占位符，避免长标题撑成两行。 */
const TextAreaField = ({
  label,
  value,
  hint,
  onChange,
  onCommit,
}: {
  label: string;
  value: string;
  hint?: string;
  onChange: (value: string) => void;
  onCommit: (value: string) => void;
}) => (
  <Field label={label} hint={hint}>
    <sp-textarea
      className="settings-panel__textarea"
      value={value}
      oninput={(e: any) => onChange(e.target.value)}
      onblur={(e: any) => onCommit(e.target.value)}
    />
  </Field>
);

/**
 * 设置二级面板（manifest `${id}.settings`）：
 * 平台 + 模型 + 各平台专属参数 + API Key + 并发 / 贴回模式 / 水印 / 提示词后缀。
 */
export const SettingsPanel = () => {
  const [apiKey, setApiKey] = useState("");
  const [keyStored, setKeyStored] = useState(false);
  const [settings, setSettings] = useState<RedrawSettings>(DEFAULT_SETTINGS);
  const [probe, setProbe] = useState<ProbeState>({ kind: "idle" });
  // 各平台是否已保存 Key（模板行展示「缺 API Key」用；仅静态判断，不做连接探测）
  const [keyPresence, setKeyPresence] = useState<Record<string, boolean>>({});
  // Siliconed 已配对的 Mac 列表（settings.providerId=siliconed 时读取）
  const [macs, setMacs] = useState<MacsState>({ kind: "idle" });
  // 诊断日志按钮的结果反馈（原主面板头部入口，已移至设置页）
  const [diagNotice, setDiagNotice] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  /** 读取所有平台的 Key 存在性（不读明文内容）。 */
  const refreshKeyPresence = async (): Promise<void> => {
    const entries = await Promise.all(
      PROVIDERS.map(async (p) => [p.id, Boolean(await loadApiKey(p.id))] as const),
    );
    setKeyPresence(Object.fromEntries(entries));
  };

  useEffect(() => {
    void refreshKeyPresence().catch(() => undefined);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const loaded = await loadSettings();
        // 模型必须属于当前平台（旧设置或手工改文件后可能不一致），否则下拉框无选中项
        const list = modelsForProvider(loaded.providerId);
        const normalized: RedrawSettings =
          list.some((m) => m.id === loaded.modelId) || list.length === 0
            ? loaded
            : { ...loaded, modelId: list[0].id };
        setSettings(normalized);
        if (normalized !== loaded) await saveSettings(normalized);
      } catch (err) {
        setProbe({
          kind: "error",
          text: `读取设置失败：${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })();
  }, []);

  // 平台切换时加载该平台自己保存的 Key（各平台互不覆盖）
  useEffect(() => {
    let alive = true;
    setProbe({ kind: "idle" });
    loadApiKey(settings.providerId)
      .then((key) => {
        if (!alive) return;
        setApiKey(key);
        setKeyStored(Boolean(key));
      })
      .catch((err) => {
        if (!alive) return;
        setProbe({
          kind: "error",
          text: `读取 API Key 失败：${err instanceof Error ? err.message : String(err)}`,
        });
      });
    return () => {
      alive = false;
    };
  }, [settings.providerId]);

  const patch = (partial: Partial<RedrawSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...partial };
      saveSettings(next).catch((err) =>
        console.error("保存设置失败", err),
      );
      return next;
    });
  };

  /** 读取已配对的 Mac（离线 / 版本不符也会带 state 返回，由 UI 标原因）。 */
  const refreshMacs = async (cliPath: string) => {
    const path = cliPath.trim();
    if (!path) {
      setMacs({ kind: "idle" });
      return;
    }
    setMacs({ kind: "busy" });
    try {
      const snapshot = await siliconMacs(path);
      setMacs({ kind: "ok", snapshot });
    } catch (err) {
      setMacs({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // 切到 Siliconed 时读取一次已配对的 Mac；路径改动后可用「刷新」按钮重读
  useEffect(() => {
    if (settings.providerId !== "siliconed") {
      setMacs({ kind: "idle" });
      return;
    }
    void refreshMacs(settings.siliconedCliPath);
    // 只在切换平台时自动读取，避免逐字符编辑路径时反复调用 CLI
  }, [settings.providerId]);

  /** 只改内存草稿，等失焦再保存。 */
  const draft = (partial: Partial<RedrawSettings>) =>
    setSettings((prev) => ({ ...prev, ...partial }));

  /** 更新第 index 个提示词模板的某个字段，返回新的模板数组。 */
  const templatePatch = (
    index: number,
    field: "name" | "prompt" | "providerId",
    value: string,
  ): PromptTemplate[] =>
    settings.promptTemplates.map((t, i) =>
      i === index ? { ...t, [field]: value } : t,
    );

  const switchProvider = (provider: ProviderId) => {
    patch(providerSwitchPatch(provider));
  };

  const handleSaveKey = async () => {
    const key = apiKey.trim();
    if (needsApiKey(settings.providerId) && !key) return;
    setProbe({ kind: "busy" });
    try {
      const result = await probeProvider(settings.providerId, settings, key);
      if (result.ok) {
        if (needsApiKey(settings.providerId)) {
          await saveApiKey(settings.providerId, key);
          setKeyStored(true);
          await refreshKeyPresence();
        }
        setProbe({ kind: "ok", text: result.message });
      } else {
        setProbe({ kind: "error", text: result.message });
      }
    } catch (err) {
      setProbe({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const handleClearKey = async () => {
    await clearApiKey(settings.providerId);
    setApiKey("");
    setKeyStored(false);
    setProbe({ kind: "idle" });
    await refreshKeyPresence().catch(() => undefined);
  };

  const provider = settings.providerId;
  const models = modelsForProvider(provider);
  const modelIds = models.map((m) => m.id);
  // 暂时屏蔽的供应商不进入下拉；若当前已保存为该值则保留，避免显示空白
  const providerOptions = providerChoices(provider);
  const providerIds = providerOptions.map((p) => p.id);

  // ---- Siliconed 跨机：计算目标下拉项（本机 + 已配对 Mac，不可用的置灰并写原因）----
  const macSnapshot = macs.kind === "ok" ? macs.snapshot : null;
  const selectedMacId = settings.siliconedTargetMac.trim();
  const targetValue: string =
    settings.siliconedComputeTarget === "mac" && selectedMacId
      ? `mac:${selectedMacId}`
      : "local";
  const targetOptions: Array<{
    value: string;
    label: string;
    disabled?: boolean;
  }> = [{ value: "local", label: `${SILICONED_LOCAL_LABEL}（默认）` }];
  if (macSnapshot) {
    if (macSnapshot.supported) {
      for (const mac of macSnapshot.macs) {
        targetOptions.push({
          value: `mac:${mac.id}`,
          label: `${mac.name} — ${macStateText(mac.state)}`,
          disabled: isMacUnusable(mac.state),
        });
      }
      if (!macSnapshot.pairingsRead) {
        targetOptions.push({
          value: "hint:pairings",
          label: "先在 Siliconed 的「其他 Mac」中读取配对列表",
          disabled: true,
        });
      } else if (macSnapshot.macs.length === 0) {
        targetOptions.push({
          value: "hint:none",
          label: "没有已配对的 Mac（请在 Siliconed 中配对）",
          disabled: true,
        });
      }
    } else {
      targetOptions.push({
        value: "hint:old",
        label: "当前 Siliconed 版本不支持跨机（需 0.20＋）",
        disabled: true,
      });
    }
  } else if (macs.kind === "busy") {
    targetOptions.push({
      value: "hint:busy",
      label: "正在读取已配对的 Mac…",
      disabled: true,
    });
  } else if (macs.kind === "error") {
    targetOptions.push({
      value: "hint:error",
      label: "读取已配对 Mac 失败（见下方）",
      disabled: true,
    });
  }
  // 已保存的目标 Mac 不在当前列表中（未读取 / 已取消配对）：保留可见，避免静默变成「本机」
  if (!targetOptions.some((option) => option.value === targetValue)) {
    targetOptions.push({
      value: targetValue,
      label: `已选 Mac（${selectedMacId}，当前列表中没有）`,
      disabled: true,
    });
  }
  const targetValues = targetOptions.map((option) => option.value);

  return (
    <section className="settings-panel">
      {/* UXP 内置 Spectrum 组件是自定义元素：React 19 的事件绑定大小写敏感，
          标准 DOM 事件必须用全小写 prop（onclick/onchange/oninput/onblur），onClick 会绑定到不存在的 "Click" 事件 */}
      <sp-heading size="M" className="settings-panel__title">
        AI 局部重绘设置
      </sp-heading>

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">生图平台</span>
        <span className="settings-panel__field-control">
          <sp-picker
            className="settings-panel__dropdown"
            onchange={(e) => {
              const idx = dropdownIndex(e, providerIds);
              if (idx >= 0) switchProvider(providerIds[idx]);
            }}
          >
            <sp-menu slot="options">
              {providerOptions.map((p) => (
                <sp-menu-item key={p.id} selected={provider === p.id}>
                  {p.label}
                </sp-menu-item>
              ))}
            </sp-menu>
          </sp-picker>
        </span>
      </div>

      {/* ---------------- 平台连接配置 ---------------- */}

      {provider === "runninghub" && (
        <>
          <TextField
            label="平台地址"
            value={settings.rhBaseUrl}
            placeholder="https://www.runninghub.cn"
            onChange={(v) => draft({ rhBaseUrl: v })}
            onCommit={(v) => patch({ rhBaseUrl: v })}
          />
          <TextField
            label="提交接口路径"
            value={settings.rhEndpoint}
            placeholder="/openapi/v2/..."
            onChange={(v) => draft({ rhEndpoint: v })}
            onCommit={(v) => patch({ rhEndpoint: v })}
          />
          <TextAreaField
            label="请求体模板（JSON）"
            hint={
              "占位符：{{image}} 原图、{{mask}} 通道图、{{prompt}} 提示词、" +
              "{{width}}/{{height}} 目标尺寸、{{aspect}} 宽高比"
            }
            value={settings.rhBodyTemplate}
            onChange={(v) => draft({ rhBodyTemplate: v })}
            onCommit={(v) => patch({ rhBodyTemplate: v })}
          />
        </>
      )}

      {provider === "comfyui" && (
        <>
          <TextField
            label="服务地址"
            value={settings.comfyBaseUrl}
            placeholder="http://127.0.0.1:8188"
            onChange={(v) => draft({ comfyBaseUrl: v })}
            onCommit={(v) => patch({ comfyBaseUrl: v })}
          />
          <TextAreaField
            label="工作流 JSON（API 格式）"
            hint={
              "占位符：{{image}} 原图、{{prompt}} 提示词、{{width}}/{{height}} 目标尺寸"
            }
            value={settings.comfyWorkflow}
            onChange={(v) => draft({ comfyWorkflow: v })}
            onCommit={(v) => patch({ comfyWorkflow: v })}
          />
          <p className="settings-panel__hint">
            在 ComfyUI 中开启「设置 → 开发模式选项 → 保存 API 格式工作流」，把导出的 JSON 粘贴到上方。
          </p>
        </>
      )}

      {provider === "siliconed" && (
        <>
          <TextField
            label="silicontrol 路径"
            value={settings.siliconedCliPath}
            placeholder="/Applications/Siliconed.app/Contents/Helpers/silicontrol"
            onChange={(v) => draft({ siliconedCliPath: v })}
            onCommit={(v) => patch({ siliconedCliPath: v })}
          />
          <TextField
            label="扩图采样长边上限"
            value={String(settings.expandMaxSample)}
            placeholder="2048"
            onChange={(v) =>
              draft({
                expandMaxSample: Number(v) > 0 ? Number(v) : EXPAND_MAX_SAMPLE_DEFAULT,
              })
            }
            onCommit={(v) =>
              patch({ expandMaxSample: normalizeExpandMaxSample(Number(v)) })
            }
          />
          <p className="settings-panel__hint">
            扩图（--mode expand）的采样长边上限：1024–3840，步进 128；越低越快，越高细节越多。
          </p>

          {/* ---------- 跨机渲染（0.20 的 macs / compute） ---------- */}
          <div className="settings-panel__field">
            <span className="settings-panel__field-label">计算目标</span>
            <span className="settings-panel__field-control">
              <sp-picker
                className="settings-panel__dropdown"
                onchange={(e) => {
                  const idx = dropdownIndex(e, targetValues);
                  const value = idx >= 0 ? targetValues[idx] : "";
                  if (value === "local") {
                    patch({
                      siliconedComputeTarget: "local" as SiliconComputeTarget,
                      siliconedTargetMac: "",
                    });
                  } else if (value.startsWith("mac:")) {
                    patch({
                      siliconedComputeTarget: "mac" as SiliconComputeTarget,
                      siliconedTargetMac: value.slice(4),
                    });
                  }
                }}
              >
                <sp-menu slot="options">
                  {targetOptions.map((option) => (
                    <sp-menu-item
                      key={option.value}
                      selected={targetValue === option.value}
                      disabled={option.disabled}
                    >
                      {option.label}
                    </sp-menu-item>
                  ))}
                </sp-menu>
              </sp-picker>
            </span>
            <sp-button
              size="s"
              variant="secondary"
              onclick={() => void refreshMacs(settings.siliconedCliPath)}
              disabled={macs.kind === "busy"}
            >
              {macs.kind === "busy" ? "读取中…" : "刷新已配对 Mac"}
            </sp-button>
          </div>

          {macSnapshot?.supported &&
            macSnapshot.macs.map((mac) => {
              const reason = isMacUnusable(mac.state)
                ? macStateReason(mac.state)
                : "";
              return (
                <p key={mac.id} className="settings-panel__hint">
                  {mac.name}：{macStateText(mac.state)}
                  {mac.machine ? ` · ${mac.machine}` : ""}
                  {reason ? ` — ${reason}` : ""}
                </p>
              );
            })}
          {macSnapshot && !macSnapshot.supported && (
            <p className="settings-panel__hint">
              当前 Siliconed 没有 macs / compute 命令（0.18 / 0.19）：只能使用本机；
              升级到 0.20 后才会出现已配对的 Mac。
            </p>
          )}
          {macs.kind === "error" && (
            <p className="settings-panel__status settings-panel__status--error">
              读取已配对 Mac 失败：{macs.text}
            </p>
          )}

          <div className="settings-panel__field">
            <span className="settings-panel__field-label">目标不一致时</span>
            <span className="settings-panel__field-control">
              <sp-picker
                className="settings-panel__dropdown"
                onchange={(e) => {
                  const idx = dropdownIndex(e, TARGET_POLICY_VALUES);
                  if (idx >= 0) {
                    patch({
                      siliconedTargetPolicy: TARGET_POLICY_VALUES[idx],
                    });
                  }
                }}
              >
                <sp-menu slot="options">
                  {TARGET_POLICY_VALUES.map((value) => (
                    <sp-menu-item
                      key={value}
                      selected={settings.siliconedTargetPolicy === value}
                    >
                      {TARGET_POLICY_LABELS[value]}
                    </sp-menu-item>
                  ))}
                </sp-menu>
              </sp-picker>
            </span>
          </div>

          <p className="settings-panel__hint">
            每次提交前都会读取 silicontrol status 的 computing_on：Siliconed 可能自行回切到别的
            Mac，不能假设目标固定。实际计算目标会写入历史记录；跨机首次渲染会先自测约 2 分钟。
          </p>

          <p className="settings-panel__hint">
            需 macOS 26+ 与 Siliconed 应用（模型 Qwen-Image-2.1，蒙版移除工作流默认 9 步，非商用研究许可）。
            Siliconed 接收选区图 + 同尺寸黑白蒙版（白=移除），由应用内部染色并移除；贴回仍按「贴回模式」合成。单队列执行，「生成并发数」对它无效。
          </p>
        </>
      )}

      {provider === "iopaint" && (
        <>
          <TextField
            label="服务地址"
            value={settings.iopaintBaseUrl}
            placeholder="http://127.0.0.1:18088"
            onChange={(v) => draft({ iopaintBaseUrl: v })}
            onCommit={(v) => patch({ iopaintBaseUrl: v })}
          />
          <div className="settings-panel__field">
            <span className="settings-panel__field-label">IOPaint 模型</span>
            <span className="settings-panel__field-control">
              <sp-picker
                className="settings-panel__dropdown"
                onchange={(e) => {
                  const idx = dropdownIndex(e, IOPAINT_MODEL_VALUES);
                  if (idx >= 0) patch({ iopaintModel: IOPAINT_MODEL_VALUES[idx] });
                }}
              >
                <sp-menu slot="options">
                  {IOPAINT_MODEL_VALUES.map((m) => (
                    <sp-menu-item key={m} selected={settings.iopaintModel === m}>
                      {IOPAINT_MODEL_LABELS[m]}
                    </sp-menu-item>
                  ))}
                </sp-menu>
              </sp-picker>
            </span>
          </div>
          <p className="settings-panel__hint">
            先启动服务：iopaint start --model=lama --device=cpu --port=18088（模型可在上方切换，
            生成前插件会自动把服务端当前模型对齐到设置值）。擦除类模型只填补周围像素，
            不支持「把 A 换成 B」的语义替换；蒙版外画面由服务端贴回原像素。
          </p>
        </>
      )}

      {provider === "custom" && (
        <>
          <TextField
            label="接口 URL"
            value={settings.customUrl}
            placeholder="https://example.com/v1/images/edits"
            onChange={(v) => draft({ customUrl: v })}
            onCommit={(v) => patch({ customUrl: v })}
          />
          <TextAreaField
            label="请求头（JSON）"
            hint={"占位符：{{apiKey}} 已保存的 API Key"}
            value={settings.customHeaders}
            onChange={(v) => draft({ customHeaders: v })}
            onCommit={(v) => patch({ customHeaders: v })}
          />
          <TextAreaField
            label="请求体模板（JSON）"
            hint={
              "占位符：{{image}} 原图、{{mask}} 通道图、{{prompt}} 提示词、" +
              "{{width}}/{{height}} 目标尺寸、{{apiKey}} API Key"
            }
            value={settings.customBodyTemplate}
            onChange={(v) => draft({ customBodyTemplate: v })}
            onCommit={(v) => patch({ customBodyTemplate: v })}
          />
          <TextField
            label="结果取值路径"
            value={settings.customResultPath}
            placeholder="data.0.b64_json"
            onChange={(v) => draft({ customResultPath: v })}
            onCommit={(v) => patch({ customResultPath: v })}
          />
        </>
      )}

      {/* ---------------- API Key ---------------- */}

      {needsApiKey(provider) && (
        <>
          {/* UXP 中 label 包裹表单控件布局怪异，改用 div + class 显式控制。
              API Key 保留原生 input：sp-textfield type="password" 在 macOS 上读不到 value（官方已知缺陷） */}
          <div className="settings-panel__field">
            <span className="settings-panel__field-label">
              {providerLabel(provider)} API Key
            </span>
            <span className="settings-panel__field-control">
              <input
                className="settings-panel__input"
                type="password"
                value={apiKey}
                placeholder="粘贴 API Key"
                onChange={(e) => setApiKey(e.target.value)}
              />
            </span>
          </div>
          {keyStored && (
            <p className="settings-panel__hint">
              已保存：<code>{maskApiKey(apiKey.trim())}</code>
            </p>
          )}
        </>
      )}

      <div className="settings-panel__row">
        <sp-button
          className="settings-panel__row-btn"
          onclick={() => void handleSaveKey()}
          disabled={probe.kind === "busy"}
        >
          {probe.kind === "busy"
            ? "测试中…"
            : provider === "siliconed"
              ? "检测 Siliconed / 模型 / 许可"
              : needsApiKey(provider)
                ? "测试并保存"
                : "测试连接"}
        </sp-button>
        <sp-button
          variant="secondary"
          onclick={() => void handleClearKey()}
          disabled={!needsApiKey(provider) || !keyStored}
        >
          清除
        </sp-button>
      </div>

      {probe.kind === "ok" && (
        <p className="settings-panel__status settings-panel__status--ok">
          {probe.text}
        </p>
      )}
      {probe.kind === "error" && (
        <p className="settings-panel__status settings-panel__status--error">
          {probe.text}
        </p>
      )}

      {/* ---------------- 模型 ---------------- */}

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">模型</span>
        <span className="settings-panel__field-control">
          {/* sp-dropdown 已被 UXP 弃用，且其 value 是 getter-only 计算属性：
              React 19 按「propName in node」判定后直接赋 property 会崩溃（only a getter）。
              改用 sp-picker：不传 value，初始选中由 menu-item 的 selected 提供
              （与 Adobe 官方面板一致），change 回调只读 selectedIndex/value。 */}
          <sp-picker
            className="settings-panel__dropdown"
            onchange={(e) => {
              const idx = dropdownIndex(e, modelIds);
              if (idx >= 0) {
                const id = modelIds[idx];
                patch({ modelId: id, ...rhPresetPatch(id) });
              }
            }}
          >
            <sp-menu slot="options">
              {models.map((m) => (
                <sp-menu-item key={m.id} selected={settings.modelId === m.id}>
                  {m.label}
                </sp-menu-item>
              ))}
            </sp-menu>
          </sp-picker>
        </span>
      </div>

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">尺寸模式</span>
        <span className="settings-panel__field-control">
          <sp-picker
            className="settings-panel__dropdown"
            onchange={(e) => {
              const idx = dropdownIndex(e, SIZE_MODE_VALUES);
              if (idx >= 0) patch({ sizeMode: SIZE_MODE_VALUES[idx] });
            }}
          >
            <sp-menu slot="options">
              {SIZE_MODE_VALUES.map((v) => (
                <sp-menu-item key={v} selected={settings.sizeMode === v}>
                  {SIZE_MODE_LABELS[v]}
                </sp-menu-item>
              ))}
            </sp-menu>
          </sp-picker>
        </span>
      </div>
      {settings.sizeMode === "fixed" && (
        <div className="settings-panel__field">
          <span className="settings-panel__field-label">固定预设</span>
          <span className="settings-panel__field-control">
            <sp-picker
              className="settings-panel__dropdown"
              onchange={(e) => {
                const idx = dropdownIndex(e, PRESET_IDS);
                if (idx >= 0) patch({ fixedPresetId: PRESET_IDS[idx] });
              }}
            >
              <sp-menu slot="options">
                {SIZE_PRESETS.map((p) => (
                  <sp-menu-item
                    key={p.id}
                    selected={settings.fixedPresetId === p.id}
                    disabled={!p.verified}
                  >
                    {p.verified
                      ? `${presetLabel(p)}`
                      : `${presetLabel(p)} — 未验证，应用实测会返回其他尺寸`}
                  </sp-menu-item>
                ))}
              </sp-menu>
            </sp-picker>
          </span>
        </div>
      )}
      <p className="settings-panel__hint">
        预设模式会把抓取区域以选区中心向外扩到预设比例，再缩放到预设精确尺寸送模型；
        工具实际返回尺寸与请求不一致时，贴回会按实际尺寸缩放并在历史记录中提示。
        「自定义」保留旧的宽高独立 32 对齐逻辑作为兜底。
      </p>

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">生成并发数</span>
        <span className="settings-panel__field-control">
          {/* sp-slider 未记录 step、sp-textfield type=number 无 min/max，故用单选组 */}
          <sp-radio-group
            disabled={providerUsesSingleQueue(provider)}
            onchange={(e) => {
              const n = Number(e.target.value);
              if ([1, 2, 3, 4].includes(n)) patch({ concurrency: n });
            }}
          >
            {[1, 2, 3, 4].map((n) => (
              <sp-radio
                key={n}
                value={String(n)}
                checked={settings.concurrency === n}
              >
                {n}
              </sp-radio>
            ))}
          </sp-radio-group>
        </span>
      </div>
      {providerUsesSingleQueue(provider) && (
        <p className="settings-panel__hint">
          {provider === "iopaint"
            ? "IOPaint 为单队列（CPU 推理 + 服务端模型为全局状态）：无论此处选几，实际同时只执行 1 个任务。"
            : "Siliconed 为单队列：无论此处选几，实际同时只执行 1 个任务。"}
        </p>
      )}

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">默认贴回模式</span>
        <span className="settings-panel__field-control">
          <sp-picker
            className="settings-panel__dropdown"
            onchange={(e) => {
              const idx = dropdownIndex(e, PLACE_BACK_VALUES);
              if (idx >= 0) patch({ placeBackMode: PLACE_BACK_VALUES[idx] });
            }}
          >
            <sp-menu slot="options">
              {PLACE_BACK_VALUES.map((v) => (
                <sp-menu-item key={v} selected={settings.placeBackMode === v}>
                  {PLACE_BACK_LABELS[v]}
                </sp-menu-item>
              ))}
            </sp-menu>
          </sp-picker>
        </span>
      </div>

      <div className="settings-panel__check">
        <sp-checkbox
          checked={settings.autoPlaceBack}
          onchange={(e) => patch({ autoPlaceBack: e.target.checked })}
        >
          生成后自动贴回
        </sp-checkbox>
        <span className="settings-panel__check-note">
          关闭则生成后仅预览，需在任务队列中手动点「贴回」
        </span>
      </div>

      <div className="settings-panel__check">
        <sp-checkbox
          checked={settings.debugDiag}
          onchange={(e) => patch({ debugDiag: e.target.checked })}
        >
          调试诊断
        </sp-checkbox>
        <span className="settings-panel__check-note">
          默认关闭；开启后记录逐步日志与全文档蒙版快照（仅排障用，会增加开销）。
          异常 / 降级 / 等原文档的关键事件始终保留最近 50 条，可随时导出。
        </span>
      </div>

      {/* 诊断日志：复制 / 导出（自主面板头部移入，排障入口统一收敛到设置页） */}
      <div className="settings-panel__row">
        <sp-button
          className="settings-panel__row-btn"
          onclick={async () => {
            try {
              await copyDiagReport();
              setDiagNotice({ ok: true, text: "诊断日志已复制到剪贴板" });
            } catch (e) {
              setDiagNotice({
                ok: false,
                text: `复制诊断日志失败：${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }}
        >
          复制诊断
        </sp-button>
        <sp-button
          variant="secondary"
          onclick={async () => {
            try {
              const exported = await exportDiagReport();
              setDiagNotice({
                ok: true,
                text: `诊断日志已导出：${exported.path}${exported.warning ? `（${exported.warning}）` : ""}`,
              });
            } catch (e) {
              setDiagNotice({
                ok: false,
                text: `导出诊断日志失败：${e instanceof Error ? e.message : String(e)}`,
              });
            }
          }}
        >
          导出诊断
        </sp-button>
      </div>
      {diagNotice && (
        <p
          className={`settings-panel__status ${
            diagNotice.ok
              ? "settings-panel__status--ok"
              : "settings-panel__status--error"
          }`}
        >
          {diagNotice.text}
        </p>
      )}

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">队列磁盘上限（MB）</span>
        <span className="settings-panel__field-control">
          <sp-textfield
            className="settings-panel__textfield"
            value={String(settings.queueDiskLimitMB)}
            onblur={(e) => {
              const mb = Math.round(Number(e.target.value));
              patch({
                queueDiskLimitMB:
                  Number.isFinite(mb) && mb > 0
                    ? Math.min(16384, Math.max(256, mb))
                    : 2048,
              });
            }}
          />
        </span>
      </div>
      <p className="settings-panel__hint">
        默认 2048（2GB）。失败 / 取消 / 等原文档的输入文件默认保留 7 天，超过上限时按结束时间从旧到新清理；
        排队、生成中与待贴回的任务不会被清理。
      </p>

      {provider === "ark" && (
        <div className="settings-panel__check">
          <sp-checkbox
            checked={settings.watermark}
            onchange={(e) => patch({ watermark: e.target.checked })}
          >
            生成水印
          </sp-checkbox>
          <span className="settings-panel__check-note">
            默认关闭；是否可关由账号策略决定
          </span>
        </div>
      )}

      <div className="settings-panel__field">
        <span className="settings-panel__field-label">
          提示词固定后缀（拼在用户指令后）
        </span>
        <span className="settings-panel__field-control">
          <sp-textfield
            className="settings-panel__textfield"
            value={settings.promptSuffix}
            oninput={(e) => draft({ promptSuffix: e.target.value })}
            onblur={(e) => patch({ promptSuffix: e.target.value })}
          />
        </span>
      </div>

      {/* ---------------- 提示词模板（主面板两行三列按钮） ---------------- */}
      <div className="settings-panel__field">
        <div className="settings-panel__field-head">
          <span className="settings-panel__field-label">提示词模板</span>
          <span className="settings-panel__field-hint">
            名称与提示词都填写后，主面板才显示该按钮（最多 6 个，两行三列）；点击按钮直接用该提示词生成并贴回，输入框内容不变
          </span>
        </div>
      </div>

      {settings.promptTemplates.map((tpl, i) => {
        const resolution = resolveTemplateProvider(tpl);
        const invalidRaw = resolution.kind === "invalid" ? resolution.raw : "";
        // 「跟随当前服务商」 + 目录内平台 + 已失效的旧 id（保留在列表里可见）；
        // 暂时屏蔽的供应商仅在模板已保存为该值时才显示
        const templateProviderOptions = providerChoices(
          resolution.kind === "provider" ? resolution.providerId : undefined,
        );
        const providerValues = [
          "",
          ...templateProviderOptions.map((p) => p.id as string),
          ...(invalidRaw ? [invalidRaw] : []),
        ];
        const statusText =
          resolution.kind === "invalid"
            ? `服务商已失效（${resolution.raw}）`
            : resolution.kind === "follow"
              ? "跟随当前服务商"
              : providerAvailability(resolution.providerId, settings, {
                  hasKey: keyPresence[resolution.providerId] ?? false,
                  isMac: isMacHost(),
                }).text;
        return (
          <div className="settings-panel__template" key={i}>
            <span className="settings-panel__field-control">
              <sp-textfield
                className="settings-panel__textfield"
                value={tpl.name}
                placeholder={`模板 ${i + 1} 名称，如：去掉汽车`}
                oninput={(e) =>
                  draft({ promptTemplates: templatePatch(i, "name", e.target.value) })
                }
                onblur={(e) =>
                  patch({ promptTemplates: templatePatch(i, "name", e.target.value) })
                }
              />
            </span>
            <span className="settings-panel__field-control settings-panel__template-provider">
              <sp-picker
                className="settings-panel__dropdown"
                onchange={(e) => {
                  const value = providerValues[Number(e.target.value)] ?? "";
                  patch({ promptTemplates: templatePatch(i, "providerId", value) });
                }}
              >
                <sp-menu slot="options">
                  <sp-menu-item key="follow" selected={resolution.kind === "follow"}>
                    跟随当前服务商
                  </sp-menu-item>
                  {templateProviderOptions.map((p) => (
                    <sp-menu-item
                      key={p.id}
                      selected={
                        resolution.kind === "provider" &&
                        resolution.providerId === p.id
                      }
                    >
                      {p.label}
                    </sp-menu-item>
                  ))}
                  {invalidRaw && (
                    <sp-menu-item key="invalid" selected>
                      {`已失效（${invalidRaw}）`}
                    </sp-menu-item>
                  )}
                </sp-menu>
              </sp-picker>
              <span
                className={
                  resolution.kind === "invalid"
                    ? "settings-panel__template-status settings-panel__template-status--invalid"
                    : "settings-panel__template-status"
                }
              >
                {statusText}
              </span>
            </span>
            <span className="settings-panel__field-control settings-panel__template-prompt">
              <sp-textarea
                className="settings-panel__textarea settings-panel__textarea--sm"
                value={tpl.prompt}
                placeholder="提示词内容，如：去掉画面中的汽车并补全背景"
                oninput={(e) =>
                  draft({
                    promptTemplates: templatePatch(i, "prompt", e.target.value),
                  })
                }
                onblur={(e) =>
                  patch({
                    promptTemplates: templatePatch(i, "prompt", e.target.value),
                  })
                }
              />
            </span>
          </div>
        );
      })}
    </section>
  );
};
