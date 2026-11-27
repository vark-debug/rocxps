import { useEffect, useRef, useState } from "react";
import { photoshop } from "../globals";
import { readSelection, type SelectionInfo } from "../ps/selection";
import { readCanvasView, placeToolbar } from "../ps/canvasView";
import { generateFromSelection } from "../task/generateFlow";
import {
  getDocWindowFrame,
  hideToolbar,
  setToolbarState,
  showToolbar,
  waitToolbarEvent,
  type ToolbarUiState,
} from "../native/toolbar";

/**
 * 选区上下文任务栏（实验）：独立 UXP 面板 + 原生浮窗任务栏（hybrid C++）。
 *
 * 显隐机制（事件驱动 + 可见时保底轮询）：
 * - 主路径：Photoshop 的选区操作（画选框、魔棒、载入选区）广播 batchPlay
 *   "select" / "set" 事件 → 150ms 尾沿 debounce → 读一次选区（selection.bounds，
 *   单次读取很便宜）→ 有选区浮现 / 无选区消失；
 * - 盲区兜底：Cmd+D 取消选择与撤销/重做（Cmd+Z）不触发 select/set，靠
 *   "historyStateChanged" 事件补（若宿主不支持则注册失败）——仍可能有残留
 *   盲区，因此浮窗**可见时**每 2s 保底轮询一次，检测到选区消失即关闭；
 *   浮窗不可见时零轮询（无任何定时器开销）。
 *
 * 浮窗架构（.trae/documents/native-toolbar-plan.md）：
 * - 浮窗本体是 SiliconedBridge.uxpaddon（hybrid C++）创建的无边框 NSPanel：
 *   无系统标题栏、出现即定位到目标位置（选区锚点：正下方 16px、随选区移动、
 *   钳制进可见画布，规则见 canvasViewMath；视口读取失败退回 native 固定
 *   位置）、NonactivatingPanel 不抢 PS 焦点；
 * - JS 是唯一状态源：显隐/两态/操作反馈经 setToolbarState 推送，native 侧
 *   UI = f(state)；点击/输入经 waitToolbarEvent 回传（Promise 循环）；
 * - 实验性：hybrid 画 UI 属官方未支持路径，PS 大版本更新需复测（POC 教训：
 *   窗口操作只在 PS 主线程、schedule 回调不释放 task）。
 */

/** 浮窗可见时的保底轮询间隔；不可见时完全停止。 */
const FALLBACK_POLL_MS = 2000;

/** 事件触发后的尾沿 debounce：拖拽/连点期间只在最后一次变化后检查一次。 */
const DEBOUNCE_MS = 150;

const BASE_EVENTS = ["select", "set"];
const HISTORY_EVENTS = ["historyStateChanged"];

/** 浮窗默认尺寸（native 侧布局按此设计；位置仅首次创建时设定，之后可用把手拖动）。 */
const TOOLBAR_SIZE = { width: 380, height: 40 };

/** 输入态提示词占位文案。 */
const PROMPT_PLACEHOLDER = "描述要生成的内容…";

/** 入队成功后横幅保持的时长；之后 native 播 1.5s 淡出并自动收起浮窗。 */
const HIDE_AFTER_ENQUEUE_MS = 1200;

/** 事件循环是否在跑（浮窗生命周期内常驻，close 后退出、下次浮现重启）。 */
const loopRunningRef = { current: false };

export const SelectionPanel = () => {
  const [listening, setListening] = useState(false);
  /** historyStateChanged 是否注册成功（撤销/取消选择依赖它）。 */
  const [historyOk, setHistoryOk] = useState<boolean | null>(null);
  const [selText, setSelText] = useState("");
  /** 操作反馈（主面板同步显示一份；浮窗内的显示经 setToolbarState 推送）。 */
  const [statusText, setStatusText] = useState("");
  const [statusError, setStatusError] = useState(false);
  /** 输入框实时草稿：native 逐键回传 input 事件，提交以此为准。 */
  const draftRef = useRef("");
  const busyRef = useRef(false);
  const lastTextRef = useRef("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /** 推送浮窗 UI 状态（幂等；fire-and-forget，错误走 native error 事件）。 */
  const pushUi = (patch: ToolbarUiState) => {
    void setToolbarState(patch).catch((err) => {
      setStatusText(err instanceof Error ? err.message : String(err));
      setStatusError(true);
    });
  };

  const startPolling = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(() => void checkSelection(), FALLBACK_POLL_MS);
  };

  const stopPolling = () => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  };

  const checkSelection = async () => {
    let text = "";
    let selInfo: SelectionInfo | null = null;
    try {
      selInfo = await readSelection();
      if (selInfo) {
        const w = Math.round(selInfo.bounds.right - selInfo.bounds.left);
        const h = Math.round(selInfo.bounds.bottom - selInfo.bounds.top);
        text = `选区 ${w}×${h} @ (${Math.round(selInfo.bounds.left)}, ${Math.round(
          selInfo.bounds.top,
        )})`;
      }
    } catch {
      // 无文档等 → 视作无选区，隐藏
    }
    if (text === lastTextRef.current) return;
    lastTextRef.current = text;
    setSelText(text);
    if (text) {
      // 选区锚点定位（三场景规则见 canvasViewMath.placeToolbar）：读取视口
      // 失败（旋转画布/版本不支持等）时 anchor 为 null → 退回 native 固定定位；
      // 文档窗口 frame 读取失败/无效时 clampRect 为 null → 退回旧「可见画布」钳制
      const [view, winFrame] = await Promise.all([
        readCanvasView(),
        getDocWindowFrame().catch(() => null),
      ]);
      const anchor = selInfo
        ? placeToolbar({
            view,
            selDoc: selInfo.bounds,
            docWidth: selInfo.canvasWidth,
            docHeight: selInfo.canvasHeight,
            toolbarWidth: TOOLBAR_SIZE.width,
            toolbarHeight: TOOLBAR_SIZE.height,
            clampRect: winFrame,
          })
        : null;
      // 浮现：出现即全量复位浮窗状态（连续操作不串状态）；事件循环幂等启动
      void showToolbar(
        anchor ? { ...TOOLBAR_SIZE, x: anchor.x, y: anchor.y } : TOOLBAR_SIZE,
      )
        .then(() =>
          setToolbarState({
            mode: "buttons",
            status: "",
            statusError: false,
            busy: busyRef.current,
            placeholder: PROMPT_PLACEHOLDER,
            value: "",
            fadeOut: false,
          }),
        )
        .catch((err) => {
          setStatusText(err instanceof Error ? err.message : String(err));
          setStatusError(true);
        });
      startPolling();
      void runEventLoop();
    } else {
      stopPolling();
      void hideToolbar().catch(() => undefined);
    }
  };

  const onSelectionEvent = () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void checkSelection(), DEBOUNCE_MS);
  };

  const stop = async () => {
    for (const events of [BASE_EVENTS, HISTORY_EVENTS]) {
      try {
        await photoshop.action.removeNotificationListener(
          events,
          onSelectionEvent,
        );
      } catch {
        // 未注册 / 不支持的事件忽略
      }
    }
    if (debounceRef.current) clearTimeout(debounceRef.current);
    stopPolling();
    lastTextRef.current = "";
    setSelText("");
    void hideToolbar().catch(() => undefined);
    setListening(false);
    setHistoryOk(null);
  };

  const start = async () => {
    await photoshop.action.addNotificationListener(
      BASE_EVENTS,
      onSelectionEvent,
    );
    let ok: boolean | null = true;
    try {
      await photoshop.action.addNotificationListener(
        HISTORY_EVENTS,
        onSelectionEvent,
      );
    } catch {
      ok = false;
    }
    setHistoryOk(ok);
    setListening(true);
    // 启用时立即同步一次当前状态
    void checkSelection();
  };

  /**
   * 把 PS 模态冲突错误转译成可读提示：用户正在拖拽/调整选区、或有模态
   * 对话框打开时，任何 batchPlay/executeAsModal 都会报「命令“设置”当前
   * 不可用」（PS 把 _obj:"set" 本地化为「设置」，来源按钮看起来毫不相干）。
   * 统一在浮窗操作层转译，覆盖生成 / 移去两条路径。
   */
  const friendlyPsBusyError = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err);
    if (/不可用|不能完成|unavailable|busy/i.test(msg)) {
      return "Photoshop 正忙（可能正在拖拽选区或有对话框打开），请松开鼠标后重试";
    }
    return msg;
  };

  /** 通用操作执行器：busy 防重入；结果同时反馈到主面板与浮窗。 */
  const runAction = async (action: () => Promise<string>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    pushUi({ busy: true });
    try {
      const message = await action();
      setStatusText(message);
      setStatusError(false);
      // 入队成功：整窗横幅反馈（不跳回按钮态），约 1.2s 后自动收起。
      // 清空 lastTextRef，允许同选区通过新的选区操作重新唤起。
      pushUi({
        mode: "banner",
        status: `✓ ${message}`,
        statusError: false,
        busy: false,
      });
      setTimeout(() => {
        stopPolling();
        lastTextRef.current = "";
        // 交由 native 播放 2s 淡出并自动收起浮窗；fadeOut:false 在下次浮现
        // 的全量推送里复位（setToolbarState 幂等缓存需要显式翻转才重推）
        pushUi({ fadeOut: true });
      }, HIDE_AFTER_ENQUEUE_MS);
    } catch (err) {
      const msg = friendlyPsBusyError(err);
      setStatusText(msg);
      setStatusError(true);
      pushUi({ mode: "buttons", status: msg, statusError: true, busy: false });
    } finally {
      busyRef.current = false;
    }
  };

  /** 「生成式填充」：读取实时草稿入队（强制重绘语义）。空提示词不拦截，
   * 直传下游由 promptPolicy 保底（Siliconed auto 语义，与「移去」一致）。 */
  const runGenerate = async () => {
    await runAction(async () => {
      const outcome = await generateFromSelection({
        prompt: draftRef.current,
        forceRedraw: true,
      });
      if (!outcome.ok) throw new Error(outcome.message);
      return "已加入队列";
    });
  };

  /** 「移去」：空提示词入队（Siliconed auto 语义 = 移除；其他平台会提示填写）。 */
  const runRemove = async () => {
    await runAction(async () => {
      const outcome = await generateFromSelection({ prompt: "" });
      if (!outcome.ok) throw new Error(outcome.message);
      return "已加入队列";
    });
  };

  /**
   * 浮窗事件循环（Promise 链）：close 后退出，浮窗下次浮现时幂等重启。
   * native 事件：click{id}（gen/remove/submit/cancel/close）、input{value}
   * （逐键草稿）、error{message}（native 侧异常）。
   */
  const runEventLoop = async () => {
    if (loopRunningRef.current) return;
    loopRunningRef.current = true;
    try {
      for (;;) {
        const ev = await waitToolbarEvent();
        if (!ev) break; // native 侧异常终止，等下次浮现重启
        if (ev.type === "input") {
          draftRef.current = ev.value ?? "";
          continue;
        }
        if (ev.type === "error") {
          setStatusText(ev.message ?? "浮窗内部错误");
          setStatusError(true);
          continue;
        }
        if (ev.type !== "click") continue;
        switch (ev.id) {
          case "gen":
            // 进入输入态前清掉上次草稿
            draftRef.current = "";
            pushUi({ mode: "input", value: "", placeholder: PROMPT_PLACEHOLDER });
            break;
          case "remove":
            void runRemove();
            break;
          case "submit":
            void runGenerate();
            break;
          case "cancel":
            pushUi({ mode: "buttons" });
            break;
          case "close":
            // 与原「关闭」语义一致：只收起，不执行 PS 命令。选区未变化时
            // 不会自动重开——lastTextRef 仍持有当前选区文本，checkSelection
            // 对相同文本直接跳过；选区变化后按正常逻辑重新浮现。
            stopPolling();
            void hideToolbar().catch(() => undefined);
            break;
        }
        if (ev.id === "close") break;
      }
    } catch {
      // addon 加载失败等：主面板手动刷新/重选区可重试
    } finally {
      loopRunningRef.current = false;
    }
  };

  // 面板挂载即自动启用监听；卸载时清理（避免重载插件后残留旧监听与浮窗）
  useEffect(() => {
    void start().catch(() => undefined);
    return () => {
      void stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <section className="selection-panel">
      <sp-heading size="M" className="selection-panel__title">
        选区上下文任务栏（实验）
      </sp-heading>
      <p className="selection-panel__hint">
        有选区时浮现原生任务栏（hybrid C++ 绘制：无标题栏、无闪烁、不抢焦点）。
        撤销/取消选择不触发 select/set 事件，由 historyStateChanged + 任务栏
        存在期间 2s 保底轮询兜底。操作结果同步到本面板。
      </p>
      <div className="selection-panel__row">
        <sp-button
          size="s"
          variant="secondary"
          onclick={() => (listening ? void stop() : void start())}
        >
          {listening ? "停用监听" : "启用监听"}
        </sp-button>
        <sp-button
          size="s"
          variant="secondary"
          onclick={() => void checkSelection()}
        >
          手动刷新
        </sp-button>
      </div>
      {listening && historyOk !== null && (
        <p className="selection-panel__note">
          historyStateChanged 监听：
          {historyOk ? "已注册" : "不可用（该宿主不支持此事件名）"}
        </p>
      )}
      {statusText && (
        <p
          className={
            statusError
              ? "selection-panel__note selection-panel__note--error"
              : "selection-panel__note"
          }
        >
          {statusText}
        </p>
      )}
    </section>
  );
};
