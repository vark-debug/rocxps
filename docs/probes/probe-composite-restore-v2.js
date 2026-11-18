/**
 * rocxps 探针 #5（v2）：先自证判定逻辑，再测「通道切回」到底哪种写法成立
 *
 * 为什么要 v2：
 *   上一轮 11 个变体全部报 FAIL，但其中 V0a/V0b/V1/V3/V6/F 的 runError 都是 null，
 *   说明「脚本没报错」和「我们判定为失败」之间存在矛盾。上一轮的判定函数有两个
 *   未经验证的假设，可能把成功误判为失败：
 *     1) 假设 doc.activeChannels 的表示形式与 doc.compositeChannels / componentChannels
 *        完全一致（集合逐项相等）。但复合通道和分量通道可能是两种表示（[RGB] vs [R,G,B]），
 *        compositeChannels 本身还是 deprecated getter。
 *     2) 假设图层蒙版通道的 kind 一定是 "maskedAreas"/"selectedAreas"。
 *   所以本探针不再用「集合相等」判 PASS/FAIL，而是：
 *     - 打印每个阶段的完整 JSON（通道数量、name/kind/visible/index）；
 *     - 只把「活动通道里是否还有蒙版通道」作为状态词（MASK-ACTIVE / NO-MASK / EMPTY / READ-ERROR）；
 *     - 把最终解释权留给原始 JSON，避免二次误判。
 *
 * 验证内容（日志前缀 [R2]）：
 *   V0a  DOM doc.activeChannels = doc.compositeChannels（后台文档 B）
 *   V0b  DOM doc.activeChannels = doc.componentChannels（后台文档 B）
 *   V1   AM select：channel 在前、document 在后（后台文档 B）
 *   F0   临时激活 B → DOM setter（控制组：验证 setter 在激活态是否有效）
 *   F1   临时激活 B → 立刻 select RGB → 检查 → 切回
 *   F2   临时激活 B → 等 50ms → 再 select RGB → 检查 → 切回
 *   F3   临时激活 B → redrawDocument → select RGB → 检查 → 切回
 *   F4   临时激活 B → batchPlay(synchronousExecution:false) → 等 300ms → 检查 → 切回
 *
 * 每个变体：
 *   - 使用全新的一对临时文档（A 64×64 激活、B 128×128 后台，B 上有图层+图层蒙版）
 *   - 打印 BEFORE / AFTER 的完整 JSON
 *   - F 系额外打印「B 激活时」和「切回 A 之后」两次状态，排除切回动作改变状态的可能
 *   - 结束后 closeWithoutSaving
 *
 * 会留下什么：
 *   - 正常结束什么都不留；崩溃时可能残留若干未保存临时文档。
 *   - 不写磁盘文件。
 *
 * 什么情况下会失败 / 不要跑：
 *   - 有未保存工作时不要跑（抢焦点、创建/关闭文档）。
 *   - 正在使用 modal 工具（自由变换/裁剪/Camera Raw/文字编辑）时 executeAsModal 进不去。
 *   - 24.4/24.5 上 DOM activeChannels 的 setter 行为属于未验证（24.6 有 bugfix 记录）。
 *
 * 判读表：
 *   ┌────────┬──────────────────────────────────────────────────────────────────────┐
 *   │ 输出   │ 含义                                                                 │
 *   ├────────┼──────────────────────────────────────────────────────────────────────┤
 *   │ BEFORE │ 应为 MASK-ACTIVE；若不是，说明 setup 的加蒙版没生效，该变体结论无效     │
 *   │ V0a/V0b AFTER = NO-MASK │ DOM setter 后台有效 → 首选方案成立                     │
 *   │ V0a/V0b AFTER = MASK-ACTIVE 且无报错 │ setter 对后台文档静默无效           │
 *   │ V1 AFTER = NO-MASK      │ 描述符顺序是问题 → 改顺序即可                                │
 *   │ V1 的 A 状态变了、B 没变 │ 命令落到了激活文档 A，document target 被忽略                │
 *   │ F1/F2/F3/F4 任一 NO-MASK │ 通道切回可行；比较「激活后 activeDocument.id 是否等于 B」    │
 *   │ F 系 activeDocument.id 仍等于 A │ `app.activeDocument = B` 尚未生效就发了 batchPlay → 需等待 │
 *   │ 全部仍 MASK-ACTIVE      │ 才需要考虑延迟修复 / 降级                                    │
 *   └────────┴──────────────────────────────────────────────────────────────────────┘
 *
 * 附带事件探针（默认开启，30 秒后自动移除）：
 *   只监听 select，打印 documentID、_offset、回调发生时 app.activeDocument.id，
 *   并在第一次回调里尝试一次「空操作 executeAsModal」，验证回调内能否进入 modal。
 *   若不想测，把 WATCH_EVENTS 改成 false。
 *
 * 用法：整段粘贴到 rocxps 插件 DevTools Console。日志前缀 [R2] / [EVT]。
 */

(async () => {
  if (typeof require !== "function") {
    console.error("[R2] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
    return;
  }

  const ps = require("photoshop");
  const { app, core, action, constants } = ps;
  const BP = { synchronousExecution: true, dialogOptions: "dontDisplay" };
  const log = (...a) => console.log("[R2]", ...a);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isErr = (r) => Array.isArray(r) && r.some((x) => x && x._obj === "error");
  const errText = (r) => JSON.stringify(r);

  const WATCH_EVENTS = true;

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

  /** 完整快照：不做任何 PASS/FAIL 推断，只输出原始事实。 */
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

  // ---------------------------------------------------------------
  // 文档对准备 / 清理
  // ---------------------------------------------------------------
  const setupPair = async () => {
    const docA = await app.documents.add({
      width: 64,
      height: 64,
      resolution: 72,
      mode: "RGBColorMode",
      fill: "white",
    });
    const docB = await app.documents.add({
      width: 128,
      height: 128,
      resolution: 72,
      mode: "RGBColorMode",
      fill: "white",
    });
    if (!docA || !docB) throw new Error("建临时文档失败");

    app.activeDocument = docA;
    const layer = await docB.createLayer(constants.LayerKind.NORMAL, { name: "MASK-TEST" });
    if (!layer) throw new Error("在后台文档建图层失败");

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

  // ---------------------------------------------------------------
  // 变体
  // ---------------------------------------------------------------
  const variants = [
    {
      id: "V0a",
      desc: "DOM activeChannels = compositeChannels（B 后台）",
      run: async ({ docB }) => {
        const before = snapshot(docB, "V0a BEFORE");
        docB.activeChannels = docB.compositeChannels;
        const after = snapshot(docB, "V0a AFTER");
        return { before: stateWord(before), after: stateWord(after) };
      },
    },
    {
      id: "V0b",
      desc: "DOM activeChannels = componentChannels（B 后台）",
      run: async ({ docB }) => {
        const before = snapshot(docB, "V0b BEFORE");
        docB.activeChannels = docB.componentChannels;
        const after = snapshot(docB, "V0b AFTER");
        return { before: stateWord(before), after: stateWord(after) };
      },
    },
    {
      id: "V1",
      desc: "AM select：channel 在前、document 在后（B 后台）",
      run: async ({ docA, docB }) => {
        const before = snapshot(docB, "V1 BEFORE");
        const activeBefore = safe(() => app.activeDocument.id, null);
        let runError = null;
        try {
          const r = await action.batchPlay(
            [
              {
                _obj: "select",
                _target: [
                  { _ref: "channel", _enum: "channel", _value: "RGB" },
                  { _ref: "document", _id: docB.id },
                ],
              },
            ],
            BP,
          );
          if (isErr(r)) runError = errText(r);
        } catch (e) {
          runError = e.message;
        }
        const afterB = snapshot(docB, "V1 AFTER B");
        const afterA = snapshot(docA, "V1 AFTER A（用于判断命令是否落到激活文档）");
        return {
          activeBefore,
          runError,
          B: stateWord(afterB),
          A: stateWord(afterA),
        };
      },
    },
    {
      id: "F0",
      desc: "临时激活 B → DOM activeChannels = compositeChannels（控制组）",
      run: async ({ docA, docB }) => {
        const before = snapshot(docB, "F0 BEFORE");
        const activeBefore = safe(() => app.activeDocument.id, null);
        try {
          app.activeDocument = docB;
          const activeAfterSet = safe(() => app.activeDocument.id, null);
          docB.activeChannels = docB.compositeChannels;
          const whileActive = snapshot(docB, "F0 WHILE B ACTIVE");
          return {
            activeBefore,
            activeAfterSet,
            activated: activeAfterSet === docB.id,
            before: stateWord(before),
            whileActive: stateWord(whileActive),
          };
        } finally {
          try {
            app.activeDocument = docA;
          } catch (e) {
            /* 忽略 */
          }
        }
      },
    },
    {
      id: "F1",
      desc: "临时激活 B → 立刻 select RGB（无 document target）→ 检查 → 切回",
      run: async ({ docA, docB }) => {
        const before = snapshot(docB, "F1 BEFORE");
        const activeBefore = safe(() => app.activeDocument.id, null);
        let runError = null;
        let activeAfterSet = null;
        let whileActive = null;
        try {
          app.activeDocument = docB;
          activeAfterSet = safe(() => app.activeDocument.id, null);
          const r = await action.batchPlay([selectRgbNoTarget], BP);
          if (isErr(r)) runError = errText(r);
          whileActive = snapshot(docB, "F1 WHILE B ACTIVE");
        } catch (e) {
          runError = e.message;
        } finally {
          try {
            app.activeDocument = docA;
          } catch (e) {
            /* 忽略 */
          }
        }
        const afterBack = snapshot(docB, "F1 AFTER SWITCH BACK");
        return {
          activeBefore,
          activeAfterSet,
          activated: activeAfterSet === docB.id,
          runError,
          before: stateWord(before),
          whileActive: whileActive ? stateWord(whileActive) : null,
          afterBack: stateWord(afterBack),
        };
      },
    },
    {
      id: "F2",
      desc: "临时激活 B → 等 50ms → select RGB → 检查 → 切回",
      run: async ({ docA, docB }) => {
        const before = snapshot(docB, "F2 BEFORE");
        const activeBefore = safe(() => app.activeDocument.id, null);
        let runError = null;
        let activeAfterSet = null;
        let activeAfterWait = null;
        let whileActive = null;
        try {
          app.activeDocument = docB;
          activeAfterSet = safe(() => app.activeDocument.id, null);
          await sleep(50);
          activeAfterWait = safe(() => app.activeDocument.id, null);
          const r = await action.batchPlay([selectRgbNoTarget], BP);
          if (isErr(r)) runError = errText(r);
          whileActive = snapshot(docB, "F2 WHILE B ACTIVE");
        } catch (e) {
          runError = e.message;
        } finally {
          try {
            app.activeDocument = docA;
          } catch (e) {
            /* 忽略 */
          }
        }
        const afterBack = snapshot(docB, "F2 AFTER SWITCH BACK");
        return {
          activeBefore,
          activeAfterSet,
          activeAfterWait,
          activated: activeAfterWait === docB.id,
          runError,
          before: stateWord(before),
          whileActive: whileActive ? stateWord(whileActive) : null,
          afterBack: stateWord(afterBack),
        };
      },
    },
    {
      id: "F3",
      desc: "临时激活 B → redrawDocument → select RGB → 检查 → 切回",
      run: async ({ docA, docB }) => {
        const before = snapshot(docB, "F3 BEFORE");
        const activeBefore = safe(() => app.activeDocument.id, null);
        let runError = null;
        let whileActive = null;
        try {
          app.activeDocument = docB;
          await core.redrawDocument({ documentID: docB.id });
          const r = await action.batchPlay([selectRgbNoTarget], BP);
          if (isErr(r)) runError = errText(r);
          whileActive = snapshot(docB, "F3 WHILE B ACTIVE");
        } catch (e) {
          runError = e.message;
        } finally {
          try {
            app.activeDocument = docA;
          } catch (e) {
            /* 忽略 */
          }
        }
        const afterBack = snapshot(docB, "F3 AFTER SWITCH BACK");
        return {
          activeBefore,
          runError,
          before: stateWord(before),
          whileActive: whileActive ? stateWord(whileActive) : null,
          afterBack: stateWord(afterBack),
        };
      },
    },
    {
      id: "F4",
      desc: "临时激活 B → batchPlay(sync:false) → 等 300ms → 检查 → 切回",
      run: async ({ docA, docB }) => {
        const before = snapshot(docB, "F4 BEFORE");
        const activeBefore = safe(() => app.activeDocument.id, null);
        let runError = null;
        let returned = null;
        let whileActive = null;
        try {
          app.activeDocument = docB;
          returned = await action.batchPlay([selectRgbNoTarget], {
            synchronousExecution: false,
            dialogOptions: "dontDisplay",
          });
          await sleep(300);
          whileActive = snapshot(docB, "F4 WHILE B ACTIVE（等待 300ms 后）");
        } catch (e) {
          runError = e.message;
        } finally {
          try {
            app.activeDocument = docA;
          } catch (e) {
            /* 忽略 */
          }
        }
        const afterBack = snapshot(docB, "F4 AFTER SWITCH BACK");
        return {
          activeBefore,
          runError,
          returned: safe(() => JSON.stringify(returned), null),
          before: stateWord(before),
          whileActive: whileActive ? stateWord(whileActive) : null,
          afterBack: stateWord(afterBack),
        };
      },
    },
  ];

  await core.executeAsModal(
    async () => {
      log("开始 v2 变体：打印完整 JSON，不做集合相等判定");
      for (const v of variants) {
        let pair = null;
        try {
          pair = await setupPair();
          const result = await v.run(pair);
          log("[" + v.id + "] " + v.desc + " => " + JSON.stringify(result, null, 2));
        } catch (e) {
          log("[" + v.id + "] SETUP/RUN 失败 - " + v.desc, e.message);
        } finally {
          teardown(pair);
          await sleep(30);
        }
      }
      log("v2 变体结束（临时文档均已无保存关闭）");
    },
    { commandName: "rocxps 通道恢复判定 v2" },
  );

  // ---------------------------------------------------------------
  // 事件探针：select 事件的 documentID / app.activeDocument.id / 回调内能否进 modal
  // ---------------------------------------------------------------
  if (WATCH_EVENTS) {
    let modalTested = false;
    const onSelect = (eventName, descriptor) => {
      const activeId = safe(() => app.activeDocument && app.activeDocument.id, null);
      log(
        "[EVT] " +
          eventName +
          " | descriptor=" +
          safe(() => JSON.stringify(descriptor), "<无法序列化>") +
          " | 回调时 activeDocument.id=" +
          activeId,
      );

      if (!modalTested) {
        modalTested = true;
        core
          .executeAsModal(async () => {}, { commandName: "probe 回调内空操作 modal" })
          .then(() => log("[EVT] 回调内 executeAsModal 成功（空操作）"))
          .catch((e) => log("[EVT] 回调内 executeAsModal 失败:", e.message));
      }
    };

    try {
      await action.addNotificationListener(["select"], onSelect);
      log("已注册 select 监听：30 秒内请切换文档，观察 documentID 与 activeDocument.id 的对应关系");
    } catch (e) {
      log("注册 select 监听失败:", e.message);
    }

    setTimeout(async () => {
      try {
        await action.removeNotificationListener(["select"], onSelect);
      } catch (e) {
        /* 忽略 */
      }
      log("select 监听已移除（30 秒到期）");
    }, 30000);
  }
})();
