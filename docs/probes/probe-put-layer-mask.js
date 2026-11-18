/**
 * rocxps 探针 #7：imaging.putLayerMask 会不会把**后台文档**的活动通道留在蒙版上
 *
 * 为什么只剩这一项：
 *   上一轮（probe-composite-baseline.js）已实测：
 *     P1：后台 createLayer + make channel/mask → 激活 B 后立刻读 → activeChannels = [红,绿,蓝]（NO-MASK）
 *     P4：B 激活时建蒙版 → 读 → ERR（蒙版态 DOM 读不出）；再 select RGB → NO-MASK
 *   但 P1 只覆盖了「建蒙版」，没有覆盖往蒙版里写像素的 putLayerMask。
 *   本探针只跑这一条，不重跑 P0-P4。
 *
 * 用例（单一流程）：
 *   1) 建 A（64×64，保持前台）、建 B（128×128，后台）
 *   2) 在后台 B 上 createLayer + make channel/mask（document+layer target，已实测可用）
 *   3) 对后台 B 调 imaging.putLayerMask：
 *        documentID = docB.id、layerID、kind:"user"、replace:true、
 *        targetBounds = 整画布、imageData = 左半白(255) / 右半黑(0) 的灰度图
 *      （故意不全白，用来区分「写进去了」和「写空了」）
 *   4) app.activeDocument = docB，紧接着读 activeChannels（唯一可靠的读法：
 *      实测只有「刚执行完 app.activeDocument = X」或「刚执行过通道 select」时 getter 才可读）
 *   5) 若第 4 步读不到：发一次 select RGB（无 document target），再读一次作对照
 *   6) 回读蒙版像素（imaging.getLayerMask + imageData.getData({chunky:true})），
 *      统计非零像素数、左右两半均值、min/max，确认图案真的写进去了
 *   7) closeWithoutSaving 两个文档
 *
 * 判读表：
 *   ┌──────────────────────────────┬────────────────────────────────────────────────────────┐
 *   │ 输出                          │ 含义                                                   │
 *   ├────────────────────────────────┼────────────────────────────────────────────────────────┤
 *   │ 第 4 步 = NO-MASK            │ putLayerMask 也不会切通道 → 后台路径完全不需要恢复步骤 │
 *   │                              │ （restoreCompositeView 里切通道/quickMask/redraw 可删） │
 *   │ 第 4 步 = ERR，第 5 步后     │ putLayerMask 会把活动通道停在蒙版 → 需要补一次 select  │
 *   │   = NO-MASK                  │ RGB：后台立刻发不可靠（已知 -32005 风险），应延迟到激活 │
 *   │ 第 4 步 = ERR，第 5 步仍 ERR │ select RGB 也救不回来 → 需要重新评估恢复方式            │
 *   │ 回读 nzRatio ≈ 0 / max = 0   │ putLayerMask 在后台写空了（与通道状态无关的另一个问题） │
 *   │ 回读 leftMean≈255,rightMean≈0│ 图案写入正确，可以拿它作为「写进去了」的证据            │
 *   │ 回读报错 / 没有 getLayerMask │ 该 PS 版本不支持读回（24.4+ 才有），单独报               │
 *   └──────────────────────────────┴────────────────────────────────────────────────────────┘
 *
 * 说明：
 *   - 第 4 步读到的 ERR 不能直接等同于「蒙版在用」——上一轮 P0 证明过，非紧邻激活的
 *     文档（哪怕没有蒙版）也读成 ERR。所以第 5 步的对照是必需的。
 *   - 本探针不写磁盘、不改源码；临时文档全部无保存关闭。
 *   - 需要 PS 24.4+（imaging.getLayerMask / putLayerMask）。
 *   - 有未保存工作时不要跑（会抢焦点、创建/关闭文档）；正在用 modal 工具时进不去 modal。
 *
 * 用法：整段粘贴到 rocxps 插件 DevTools Console。日志前缀 [R4]。
 */

(async () => {
  if (typeof require !== "function") {
    console.error("[R4] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
    return;
  }

  const ps = require("photoshop");
  const { app, core, action, imaging, constants } = ps;
  const BP = { synchronousExecution: true, dialogOptions: "dontDisplay" };
  const log = (...a) => console.log("[R4]", ...a);
  const safe = (fn, fallback) => {
    try {
      return fn();
    } catch (e) {
      return "ERR:" + e.message;
    }
  };
  const isErr = (r) => Array.isArray(r) && r.some((x) => x && x._obj === "error");
  const errText = (r) => JSON.stringify(r);

  const chan = (c) => ({
    name: safe(() => c.name, null),
    kind: safe(() => c.kind, null),
    visible: safe(() => c.visible, null),
  });

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

  const toPx = (value) => {
    const raw =
      value && typeof value === "object" && "_value" in value ? value._value : value;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 0;
  };

  /** 蒙版回读统计：确认「写进去了」，而不是空蒙版。 */
  const maskStats = (data, width, height) => {
    const total = width * height;
    let nz = 0;
    let min = 255;
    let max = 0;
    let leftSum = 0;
    let leftN = 0;
    let rightSum = 0;
    let rightN = 0;
    for (let y = 0; y < height; y++) {
      const row = y * width;
      for (let x = 0; x < width; x++) {
        const v = Number(data[row + x]);
        if (v > 0) nz += 1;
        if (v < min) min = v;
        if (v > max) max = v;
        if (x < width / 2) {
          leftSum += v;
          leftN += 1;
        } else {
          rightSum += v;
          rightN += 1;
        }
      }
    }
    return {
      width,
      height,
      total,
      nonZero: nz,
      nonZeroRatio: total ? Number((nz / total).toFixed(3)) : 0,
      min,
      max,
      leftMean: leftN ? Number((leftSum / leftN).toFixed(1)) : null,
      rightMean: rightN ? Number((rightSum / rightN).toFixed(1)) : null,
    };
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

  let docA = null;
  let docB = null;

  await core.executeAsModal(
    async () => {
      // 1) 建 A（前台）、建 B（后台）
      docA = await app.documents.add({
        width: 64,
        height: 64,
        resolution: 72,
        mode: "RGBColorMode",
        fill: "white",
      });
      docB = await app.documents.add({
        width: 128,
        height: 128,
        resolution: 72,
        mode: "RGBColorMode",
        fill: "white",
      });
      if (!docA || !docB) throw new Error("建临时文档失败");
      app.activeDocument = docA;

      const width = toPx(docB.width);
      const height = toPx(docB.height);
      if (width <= 0 || height <= 0) throw new Error("读不到 B 的画布尺寸");

      // 2) 后台 B：建图层 + 用户蒙版
      const layer = await docB.createLayer(constants.LayerKind.NORMAL, { name: "MASK-PUT-TEST" });
      if (!layer) throw new Error("在后台文档建图层失败");

      const made = await action.batchPlay([maskDesc(docB.id, layer.id)], BP);
      if (isErr(made)) throw new Error("加蒙版失败：" + errText(made));
      log("已建蒙版：docB.id=" + docB.id + ", layer.id=" + layer.id + ", " + width + "×" + height);

      // 3) 后台 B：putLayerMask 写入左半白 / 右半黑的真实图案
      const buf = new Uint8Array(width * height);
      for (let y = 0; y < height; y++) {
        const row = y * width;
        for (let x = 0; x < width; x++) {
          buf[row + x] = x < width / 2 ? 255 : 0;
        }
      }
      const imageData = await imaging.createImageDataFromBuffer(buf, {
        width,
        height,
        components: 1,
        colorSpace: "Grayscale",
        colorProfile: "Gray Gamma 2.2",
      });

      let putError = null;
      const putStart = Date.now();
      try {
        await imaging.putLayerMask({
          documentID: docB.id,
          layerID: layer.id,
          kind: "user",
          replace: true,
          imageData,
          targetBounds: { left: 0, top: 0, width, height },
        });
      } catch (e) {
        putError = e.message;
      } finally {
        try {
          await imageData.dispose();
        } catch (e) {
          /* 忽略 */
        }
      }
      const putMs = Date.now() - putStart;
      log("putLayerMask 完成：error=" + JSON.stringify(putError) + "，耗时 " + putMs + "ms");

      // 4) 激活 B，紧接着读 activeChannels
      app.activeDocument = docB;
      const activeAfterSet = safe(() => app.activeDocument.id, null);
      const afterPut = snapshot(docB, "R4 STEP4 AFTER putLayerMask（B 激活后立刻读）");

      // 5) 读不到 → select RGB 再读一次作对照
      let selectError = null;
      let afterSelect = null;
      if (!Array.isArray(afterPut.activeChannels)) {
        try {
          const r = await action.batchPlay([selectRgbNoTarget], BP);
          if (isErr(r)) selectError = errText(r);
        } catch (e) {
          selectError = e.message;
        }
        afterSelect = snapshot(docB, "R4 STEP5 AFTER select RGB");
      }

      // 6) 回读蒙版像素，确认图案写进去了
      let readbackError = null;
      let stats = null;
      let sourceBounds = null;
      try {
        const got = await imaging.getLayerMask({
          documentID: docB.id,
          layerID: layer.id,
          kind: "user",
          sourceBounds: { left: 0, top: 0, right: width, bottom: height },
        });
        sourceBounds = safe(() => got.sourceBounds, null);
        const data = await got.imageData.getData({ chunky: true });
        stats = maskStats(data, got.imageData.width, got.imageData.height);
        try {
          await got.imageData.dispose();
        } catch (e) {
          /* 忽略 */
        }
      } catch (e) {
        readbackError = e.message;
      }

      log(
        "[R4] 结果 => " +
          JSON.stringify(
            {
              putError,
              putMs,
              activeAfterSet,
              activated: activeAfterSet === docB.id,
              step4: stateWord(afterPut),
              selectError,
              step5: afterSelect ? stateWord(afterSelect) : "未执行（第 4 步已可读）",
              readbackError,
              sourceBounds,
              maskStats: stats,
              maskWritten: stats ? stats.max > 0 && stats.nonZeroRatio > 0.1 : null,
            },
            null,
            2,
          ),
      );

      // 7) 清理
      app.activeDocument = docA;
    },
    { commandName: "rocxps putLayerMask 通道状态" },
  );

  for (const doc of [docA, docB]) {
    if (!doc) continue;
    try {
      doc.closeWithoutSaving();
    } catch (e) {
      /* 忽略 */
    }
  }
  log("结束：临时文档已无保存关闭");
})();
