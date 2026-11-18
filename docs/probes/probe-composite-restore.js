/**
 * rocxps 探针 #3：后台文档的「活动通道切回复合通道」变体矩阵
 *
 * 背景（已实测）：
 *   后台建图层 / putPixels(documentID) / make channel-mask / putLayerMask(documentID) /
 *   layer.delete() 全部成功；唯一失败的是：
 *     select + _target:[{document,_id},{channel,channel,RGB}] → -32005「程序错误」
 *   失败后果：目标文档的活动通道停在图层蒙版上，用户切回该文档会看到黑屏。
 *
 * 本探针验证“还能怎么把活动通道切回 RGB”，每个变体都使用**全新的一对临时文档**：
 *   A（64×64，激活）+ B（128×128，后台），B 上新建图层并加图层蒙版，
 *   然后执行一种恢复写法，最后读取 B 的 activeChannels 判断是否回到复合视图。
 *
 * 会创建什么：
 *   - 每个变体一对临时文档（A 激活、B 后台、B 上一个 MASK-TEST 图层 + 图层蒙版）
 *   - 全部 closeWithoutSaving；不写磁盘文件
 *
 * 会留下什么：
 *   - 正常结束不留任何东西。
 *   - 若脚本中途崩溃/PS 被强杀，可能残留若干未保存的临时文档，手动关掉即可。
 *
 * 什么情况下会失败 / 不要跑：
 *   - 有未保存的工作时不要跑（会抢焦点、创建/关闭文档）。
 *   - 正在使用 modal 工具（自由变换、裁剪、Camera Raw、文字编辑）时，
 *     executeAsModal 进不去，脚本整体失败；先结束工具。
 *   - PS < 24.4 没有 imaging API（本脚本不直接用 imaging，但后续贴回链路依赖它）。
 *   - V0 系依赖 DOM `Document.activeChannels` 的 setter（类型声明 minVersion 23.0，
 *     但 24.6 有 bugfix 记录），24.4/24.5 上的行为属于「未验证」。
 *
 * 判读表（每个变体会打印 PASS / FAIL / UNKNOWN + 前后通道状态）：
 *   ┌────────┬─────────────────────────────────────────────┬────────────────────────────┐
 *   │ 变体   │ 含义                                        │ 成立时怎么用                │
 *   ├────────┼─────────────────────────────────────────────┼────────────────────────────┤
 *   │ V0a    │ DOM activeChannels = compositeChannels      │ 首选：后台直接恢复，零打扰  │
 *   │ V0b    │ DOM activeChannels = componentChannels      │ 首选：同上（多数情况下等价）│
 *   │ V0c    │ DOM activeChannels = [channels[0]]（控制组）│ 仅用于理解 channels 索引    │
 *   │ V1     │ AM select：channel 在前、document 在后      │ 次选：改描述符顺序即可      │
 *   │ V2     │ AM select：document 在前、channel 在后      │ 已知失败控制组（-32005）    │
 *   │ V3/V4  │ AM select：channel 用 _index 0/1 + document │ 次选：换成数字索引          │
 *   │ V5     │ AM select：枚举 composite + document        │ 次选：换枚举值              │
 *   │ V6     │ AM select + makeVisible:true                │ 次选：补可见性参数          │
 *   │ V7     │ AM set colorChannels（探索性）              │ 若 PASS 可替代 select      │
 *   │ V8     │ AM select document + null（探索性，清选择） │ 与通道无关，预期不成立      │
 *   │ F      │ 临时激活 → select RGB → 切回（计时）        │ 兜底：只在这一步激活        │
 *   └────────┴─────────────────────────────────────────────┴────────────────────────────┘
 *
 * 结论怎么用：
 *   - 任一个 V0x 或 V1/V3/V4/V5/V6 PASS → 贴回链路可以完全后台化，不需要激活文档。
 *   - 全部 AM 变体 FAIL、只有 F PASS → 说明“通道切回”必须激活文档；
 *     优先考虑「脏标记 + 下次该文档被激活时修复」，其次才是临时激活。
 *   - 所有变体都 FAIL（含 F）→ 记录 PS 版本，改用延迟修复或降级为非图层蒙版模式。
 *
 * 附带的「事件探针」（默认开启，30 秒后自动移除）：
 *   验证 action.addNotificationListener 支持哪些事件名、切换文档时是否有事件、
 *   描述符里能否拿到 document id。跑完请在 30 秒内手动切换一下文档看 [EVT] 输出。
 *   若不想测，把下面 WATCH_EVENTS 改成 false。
 *
 * 用法：整段粘贴到 rocxps 插件 DevTools Console。日志前缀 [RESTORE] / [EVT]。
 */

(async () => {
  if (typeof require !== "function") {
    console.error("[RESTORE] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
    return;
  }

  const ps = require("photoshop");
  const { app, core, action, constants } = ps;
  const BP = { synchronousExecution: true, dialogOptions: "dontDisplay" };
  const log = (...a) => console.log("[RESTORE]", ...a);
  const isErr = (r) => Array.isArray(r) && r.some((x) => x && x._obj === "error");
  const errText = (r) => JSON.stringify(r);

  // 是否在变体跑完后附带事件监听探针（30 秒）
  const WATCH_EVENTS = true;

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

  const chList = (getter) => {
    try {
      const list = getter();
      return (list || []).map((c) => c.name + ":" + c.kind);
    } catch (e) {
      return ["<读取失败:" + e.message + ">"];
    }
  };

  const state = (doc) => ({
    active: chList(() => doc.activeChannels),
    composite: chList(() => doc.compositeChannels),
    component: chList(() => doc.componentChannels),
    all: chList(() => doc.channels),
  });

  const sameSet = (a, b) =>
    a.length === b.length && a.every((x) => b.indexOf(x) >= 0);

  const hasMaskChannel = (arr) =>
    arr.some((x) => x.indexOf("maskedAreas") >= 0 || x.indexOf("selectedAreas") >= 0);

  /** 判断“是否回到复合视图”：活动通道里没有蒙版/alpha，且等于 composite 或 component 集合。 */
  const verdict = (s) => {
    const ref = s.composite.length ? s.composite : s.component;
    if (!ref.length) return "UNKNOWN";
    if (hasMaskChannel(s.active)) return "FAIL";
    return sameSet(s.active, ref) ? "PASS" : "FAIL";
  };

  const variants = [
    {
      id: "V0a",
      desc: "DOM activeChannels = doc.compositeChannels（后台文档）",
      run: async ({ docB }) => {
        docB.activeChannels = docB.compositeChannels;
      },
    },
    {
      id: "V0b",
      desc: "DOM activeChannels = doc.componentChannels（后台文档）",
      run: async ({ docB }) => {
        docB.activeChannels = docB.componentChannels;
      },
    },
    {
      id: "V0c",
      desc: "DOM activeChannels = [doc.channels[0]]（后台文档，控制组）",
      run: async ({ docB }) => {
        docB.activeChannels = [docB.channels[0]];
      },
    },
    {
      id: "V1",
      desc: "AM select：channel 在前、document 在后",
      run: async ({ docB }) => {
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
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V2",
      desc: "AM select：document 在前、channel 在后（已知失败控制组）",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "select",
              _target: [
                { _ref: "document", _id: docB.id },
                { _ref: "channel", _enum: "channel", _value: "RGB" },
              ],
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V3",
      desc: "AM select：channel _index:1 + document",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "select",
              _target: [
                { _ref: "channel", _index: 1 },
                { _ref: "document", _id: docB.id },
              ],
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V4",
      desc: "AM select：channel _index:0 + document",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "select",
              _target: [
                { _ref: "channel", _index: 0 },
                { _ref: "document", _id: docB.id },
              ],
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V5",
      desc: "AM select：channel 枚举 composite + document",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "select",
              _target: [
                { _ref: "channel", _enum: "channel", _value: "composite" },
                { _ref: "document", _id: docB.id },
              ],
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V6",
      desc: "AM select：channel + document + makeVisible:true",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "select",
              _target: [
                { _ref: "channel", _enum: "channel", _value: "RGB" },
                { _ref: "document", _id: docB.id },
              ],
              makeVisible: true,
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V7",
      desc: "AM set colorChannels（探索性写法）",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "set",
              _target: [
                { _ref: "channel", _property: "colorChannels" },
                { _ref: "document", _id: docB.id },
              ],
              to: { _ref: "channel", _enum: "channel", _value: "RGB" },
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "V8",
      desc: "AM select document + null（探索性，清选择）",
      run: async ({ docB }) => {
        const r = await action.batchPlay(
          [
            {
              _obj: "select",
              _target: [{ _ref: "document", _id: docB.id }],
              null: true,
            },
          ],
          BP,
        );
        if (isErr(r)) throw new Error(errText(r));
      },
    },
    {
      id: "F",
      desc: "临时激活 → select RGB（无 document target）→ 切回，计时",
      run: async ({ docA, docB }) => {
        const t0 = Date.now();
        try {
          app.activeDocument = docB;
          const r = await action.batchPlay(
            [
              {
                _obj: "select",
                _target: [{ _ref: "channel", _enum: "channel", _value: "RGB" }],
              },
            ],
            BP,
          );
          if (isErr(r)) throw new Error(errText(r));
        } finally {
          app.activeDocument = docA;
        }
        return "耗时 " + (Date.now() - t0) + " ms";
      },
    },
  ];

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

  await core.executeAsModal(
    async () => {
      log("开始变体矩阵：每个变体使用全新临时文档对（A 激活 / B 后台）");

      for (const v of variants) {
        let pair = null;
        try {
          pair = await setupPair();
          const before = state(pair.docB);

          let runError = null;
          let extra = null;
          try {
            extra = await v.run(pair);
          } catch (e) {
            runError = e && e.message ? e.message : String(e);
          }

          const after = state(pair.docB);
          const result = verdict(after);

          log(
            "[" + v.id + "] " + result + " - " + v.desc,
            { before, after, runError, extra },
          );
        } catch (e) {
          log("[" + v.id + "] SETUP/FAIL - " + v.desc, e.message);
        } finally {
          teardown(pair);
          await new Promise((resolve) => setTimeout(resolve, 30));
        }
      }

      log("矩阵结束（所有临时文档已无保存关闭）");
    },
    { commandName: "rocxps 通道恢复变体矩阵" },
  );

  // ---------------------------------------------------------------
  // 附带：文档事件监听探针（验证 addNotificationListener 的可用事件名）
  // ---------------------------------------------------------------
  if (WATCH_EVENTS) {
    const EVENT_NAMES = ["open", "close", "select", "make", "set", "save", "activate", "show"];
    const onEvent = (eventName, descriptor) => {
      let body = "";
      try {
        body = JSON.stringify(descriptor);
      } catch (e) {
        body = "<无法序列化>";
      }
      console.log("[EVT]", eventName, body.slice(0, 900));
    };

    log("开始注册事件监听（逐个尝试，失败会打印原因）");
    for (const name of EVENT_NAMES) {
      try {
        await action.addNotificationListener([name], onEvent);
        log("监听注册成功:", name);
      } catch (e) {
        log("监听注册失败:", name, e.message);
      }
    }
    log("接下来 30 秒内请手动切换/打开/关闭文档，观察 [EVT] 输出（重点看切换文档是否触发 select）");

    setTimeout(async () => {
      for (const name of EVENT_NAMES) {
        try {
          await action.removeNotificationListener([name], onEvent);
        } catch (e) {
          /* 忽略 */
        }
      }
      log("事件监听已移除（30 秒到期）");
    }, 30000);
  }
})();
