/**
 * rocxps 探针 #6：补齐「基线」——后台建蒙版到底有没有把活动通道切到蒙版
 *
 * 为什么还要补：
 *   v2 日志（docs/1.json）里 V0a/V0b/V1 的 AFTER、以及 F0-F4 的 BEFORE，
 *   全部是在 B 处于**后台**时读取 activeChannels，值都是
 *   "ERR:Unknown or unsupported active channels."；F 系虽然在激活 B 之后读到
 *   [红,绿,蓝]，但没有任何一次是在「B 激活后、执行恢复动作之前」读取的。
 *   因此无法区分两种解释：
 *     A) 后台建蒙版把活动通道切到了蒙版，F 系的 NO-MASK 是「恢复成功」；
 *     B) 后台建蒙版根本没切通道，F 系的 NO-MASK 是「本来如此」，恢复无关紧要。
 *   本探针只补这个缺口，不重跑 v2 的 8 个变体。
 *
 * 验证内容（日志前缀 [R3]）：
 *   P0  包含在 P1 里：A 为激活文档、未执行任何命令时读 A 的 activeChannels
 *       （用来解释 v2 里 V1 的 A 为什么也读成 ERR：命令副作用还是 getter 限制）
 *   P1  基线：B 后台建图层+蒙版 → 激活 B → 不做任何恢复 → 读状态
 *       （若仍 ERR，则 redrawDocument 后再读一次，并标记 redrawn）
 *   P2  后台 DOM setter：B 后台建蒙版 → B 后台执行 docB.activeChannels = docB.compositeChannels
 *       → 激活 B → 读状态
 *   P3  后台 AM select：B 后台建蒙版 → B 后台执行 select RGB + document target（与 v2 的 V1 同款）
 *       → 先读 A（检查是否被污染）→ 激活 B → 读状态
 *   P4  激活态建蒙版对照：先保持 B 激活再建蒙版 → 读状态（观察蒙版通道在 activeChannels 里的真实表示）
 *       → 再 select RGB → 再读（确认激活态切回是否有效）
 *
 * 判读：
 *   ┌──────────────────────────────────┬──────────────────────────────────────────────┐
 *   │ 输出                             │ 含义                                         │
 *   ├──────────────────────────────────┼──────────────────────────────────────────────┤
 *   │ P4 建蒙版后 = MASK-ACTIVE        │ 建蒙版确实会切活动通道；以这条为判定基准     │
 *   │ P1 = NO-MASK 且 P4 = MASK-ACTIVE │ 后台建蒙版不切通道 → 贴回无需恢复，删步骤 6  │
 *   │ P1 = MASK-ACTIVE                 │ 后台建蒙版会切通道 → 看 P2/P3               │
 *   │ P2/P3 = NO-MASK                  │ 后台写入有效 → 纯后台恢复可行               │
 *   │ P2/P3 = MASK-ACTIVE              │ 后台写入被忽略 → 只能延迟修复               │
 *   │ P3 里 A AFTER 也 ERR             │ AM select 会污染激活文档的活动通道状态      │
 *   │ P0（P1 中的 A 自检）也 ERR        │ activeChannels getter 对该文档根本不可用     │
 *   └──────────────────────────────────┴──────────────────────────────────────────┘
 *
 * 会留下什么：临时文档全部 closeWithoutSaving，不写磁盘文件。
 * 什么情况下不要跑 / 会失败：
 *   - 有未保存工作时不要跑（会抢焦点、创建/关闭文档）。
 *   - 正在使用 modal 工具（自由变换 / 裁剪 / Camera Raw / 文字编辑）时进不去 modal。
 *   - 24.4 / 24.5 上 DOM activeChannels 的 setter 行为未验证（24.6 有 bugfix 记录）。
 *
 * 用法：整段粘贴到 rocxps 插件 DevTools Console。日志前缀 [R3]。
 */

(async () => {
  if (typeof require !== "function") {
    console.error("[R3] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
    return;
  }

  const ps = require("photoshop");
  const { app, core, action, constants } = ps;
  const BP = { synchronousExecution: true, dialogOptions: "dontDisplay" };
  const log = (...a) => console.log("[R3]", ...a);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isErr = (r) => Array.isArray(r) && r.some((x) => x && x._obj === "error");
  const errText = (r) => JSON.stringify(r);

  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      return "ERR:" + e.message;
    }
  };

  const chan = (c) => ({
    name: safe(() => c.name, null),
    kind: safe(() => c.kind, null),
    visible: safe(() => c.visible, null),
  });

  /** 完整快照：不做 PASS/FAIL 推断，只输出原始事实。 */
  const snapshot = (doc, label) => {
    const s = {
      label,
      docId: safe(() => doc.id, null),
      activeDocumentId: safe(() => app.activeDocument && app.activeDocument.id, null),
      activeChannels: safe(() => (doc.activeChannels || []).map(chan), null),
      compositeChannels: safe(() => (doc.compositeChannels || []).map(chan), null),
      componentChannels: safe(() => (doc.componentChannels || []).map(chan), null),
      allChannels: safe(
        () => (doc.channels || []).map((c, i) => ({ index: i, ...chan(c) })),
        null,
      ),
    };
    log(label, JSON.stringify(s, null, 2));
    return s;
  };

  /** 只描述状态，不做集合相等判断。 */
  const stateWord = (s) => {
    if (!Array.isArray(s.activeChannels)) return "READ-ERROR";
    if (s.activeChannels.length === 0) return "EMPTY";
    const mask = s.activeChannels.some(
      (c) =>
        c.kind === "maskedAreas" ||
        c.kind === "selectedAreas" ||
        /蒙版|mask/i.test(String(c.name || "")),
    );
    return mask ? "MASK-ACTIVE" : "NO-MASK";
  };

  const maskDesc = (docId, layerId) => ({
    _obj: "make",
    _target: [
      { _ref: "document", _id: docId },
      { _ref: "layer", _id: layerId },
    ],
    new: { _obj: "channel" },
    at: { _ref: "channel", _enum: "channel", _value: "mask" },
    using: { _enum: "userMaskEnabled", _value: "revealAll" },
  });

  const selectRgbNoTarget = {
    _obj: "select",
    _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }],
  };

  const selectRgbWithDoc = (docId) => ({
    _obj: "select",
    _target: [
      { _ref: "channel", _enum: "channel", _value: "RGB" },
      { _ref: "document", _id: docId },
    ],
  });

  const addDoc = (w, h) =>
    app.documents.add({
      width: w,
      height: h,
      resolution: 72,
      mode: "RGBColorMode",
      fill: "white",
    });

  /**
   * 建一对临时文档。
   * maskWhileActive=true 时保持 B 为激活文档再建蒙版（P4 用）；
   * 否则先切回 A，再在**后台**的 B 上建图层 + 蒙版（P1/P2/P3 用）。
   */
  const setupPair = async (maskWhileActive) => {
    const docA = await addDoc(64, 64);
    const docB = await addDoc(128, 128);
    if (!docA || !docB) throw new Error("建临时文档失败");

    if (!maskWhileActive) {
      app.activeDocument = docA;
    }
    const layer = await docB.createLayer(constants.LayerKind.NORMAL, { name: "MASK-TEST" });
    if (!layer) throw new Error("建图层失败");

    const r = await action.batchPlay([maskDesc(docB.id, layer.id)], BP);
    if (isErr(r)) throw new Error("加蒙版失败：" + errText(r));

    return { docA, docB, layer };
  };

  const teardown = (pair) => {
    if (!pair) return;
    try {
      pair.docA.closeWithoutSaving();
    } catch (e) {
      /* 忽略 */
    }
    try {
      pair.docB.closeWithoutSaving();
    } catch (e) {
      /* 忽略 */
    }
  };

  const variants = [
    {
      id: "P1",
      desc: "基线：B 后台建蒙版 → 激活 B → 不恢复直接读",
      maskWhileActive: false,
      run: async ({ docA, docB }) => {
        // P0：A 为激活文档、尚未执行任何命令，读一次 A（对应 v2 V1 里 A 读成 ERR 的疑点）
        const sanityA = snapshot(docA, "P1/P0 A ACTIVE（无命令自检）");

        app.activeDocument = docB;
        const activeAfterSet = safe(() => app.activeDocument.id, null);

        let baseline = snapshot(docB, "P1 B ACTIVE BASELINE");
        let redrawn = false;
        if (!Array.isArray(baseline.activeChannels)) {
          await core.redrawDocument({ documentID: docB.id });
          baseline = snapshot(docB, "P1 B ACTIVE BASELINE（redraw 后重读）");
          redrawn = true;
        }

        app.activeDocument = docA;
        return {
          activeAfterSet,
          activated: activeAfterSet === docB.id,
          aSanity: stateWord(sanityA),
          baseline: stateWord(baseline),
          redrawn,
        };
      },
    },
    {
      id: "P2",
      desc: "B 后台：docB.activeChannels = docB.compositeChannels → 激活 B → 读",
      maskWhileActive: false,
      run: async ({ docA, docB }) => {
        const beforeBg = snapshot(docB, "P2 BEFORE（B 后台）");

        let setError = null;
        try {
          docB.activeChannels = docB.compositeChannels;
        } catch (e) {
          setError = e.message;
        }
        const afterSetBg = snapshot(docB, "P2 AFTER SET（B 后台）");

        app.activeDocument = docB;
        const activeAfterSet = safe(() => app.activeDocument.id, null);
        const whileActive = snapshot(docB, "P2 B ACTIVE（后台 set 之后）");

        app.activeDocument = docA;
        return {
          beforeBg: stateWord(beforeBg),
          setError,
          afterSetBg: stateWord(afterSetBg),
          activeAfterSet,
          activated: activeAfterSet === docB.id,
          baseline: stateWord(whileActive),
        };
      },
    },
    {
      id: "P3",
      desc: "B 后台：AM select RGB + document target → 读 A → 激活 B → 读",
      maskWhileActive: false,
      run: async ({ docA, docB }) => {
        const aBefore = snapshot(docA, "P3 A ACTIVE BEFORE（命令前）");

        let runError = null;
        try {
          const r = await action.batchPlay([selectRgbWithDoc(docB.id)], BP);
          if (isErr(r)) runError = errText(r);
        } catch (e) {
          runError = e.message;
        }

        const aAfter = snapshot(docA, "P3 A ACTIVE AFTER（命令后，检查是否被污染）");

        app.activeDocument = docB;
        const activeAfterSet = safe(() => app.activeDocument.id, null);
        const whileActive = snapshot(docB, "P3 B ACTIVE（后台 AM select 之后）");

        app.activeDocument = docA;
        return {
          runError,
          aBefore: stateWord(aBefore),
          aAfter: stateWord(aAfter),
          activeAfterSet,
          activated: activeAfterSet === docB.id,
          baseline: stateWord(whileActive),
        };
      },
    },
    {
      id: "P4",
      desc: "对照：保持 B 激活再建蒙版 → 直接读 → select RGB → 再读",
      maskWhileActive: true,
      run: async ({ docB }) => {
        // 此时 B 刚在激活态建完蒙版，未做任何恢复
        const created = snapshot(docB, "P4 AFTER MAKE MASK（B 激活）");

        const r = await action.batchPlay([selectRgbNoTarget], BP);
        const afterSelect = snapshot(docB, "P4 AFTER select RGB（B 激活）");

        return {
          created: stateWord(created),
          selectError: isErr(r) ? errText(r) : null,
          afterSelect: stateWord(afterSelect),
        };
      },
    },
  ];

  await core.executeAsModal(
    async () => {
      log("Photoshop " + safe(() => app.version, "未知版本") + " | 开始基线补齐（P0-P4）");
      for (const v of variants) {
        let pair = null;
        try {
          pair = await setupPair(v.maskWhileActive);
          const result = await v.run(pair);
          log("[" + v.id + "] " + v.desc + " => " + JSON.stringify(result, null, 2));
        } catch (e) {
          log("[" + v.id + "] SETUP/RUN 失败 - " + v.desc, e.message);
        } finally {
          teardown(pair);
          await sleep(30);
        }
      }
      log("基线补齐结束（临时文档均已无保存关闭）");
    },
    { commandName: "rocxps 复合通道基线补齐" },
  );
})();
