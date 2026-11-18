/**
 * rocxps 探针 #1：Photoshop 能否对「非激活文档」执行贴回所需的结构与像素操作
 *
 * 验证内容（每一项都会打印 [BG] 结果）：
 *   1) DOM  doc.createLayer()            在非激活文档 B 上能否建图层
 *   1b) 兜底 batchPlay make layer        显式 _target document 能否在 B 上建图层
 *   2) Imaging putPixels(documentID)     能否向后台文档 B 的图层写像素
 *   3) Imaging getPixels(documentID)     回读校验写入是否真的落到 B（且 A 仍激活）
 *   4) batchPlay make channel/mask       带 document + layer target 能否给 B 的图层加蒙版
 *   5) Imaging putLayerMask(documentID)  能否向后台文档 B 的图层蒙版写整画布灰度
 *   6) batchPlay select composite        带 document target 能否把 B 的活动通道切回 RGB
 *   7) DOM  layer.delete()               在非激活文档 B 上能否删除图层
 *
 * 会创建什么：
 *   - 临时文档 A（64×64，白底）
 *   - 临时文档 B（128×128，白底），B 上一个名为 BG-TEST 的测试图层（可能带蒙版）
 *
 * 会留下什么：
 *   - 正常情况下 finally 会把 A、B 都 closeWithoutSaving（不留文件、不留图层）。
 *   - 若脚本中途崩溃或 PS 被强杀，可能残留 A/B 两个未保存文档，手动关掉即可。
 *   - 不在磁盘写任何文件。
 *
 * 什么情况下会失败 / 不要跑：
 *   - 有未保存的工作时不要跑：脚本会抢焦点、创建/关闭文档，容易误操作。
 *   - 当前处于 modal 工具中（自由变换、裁剪、Camera Raw、文字编辑等）时，
 *     executeAsModal 会进不去，整个脚本直接失败；先结束这些工具再跑。
 *   - PS < 24.4：imaging API 不存在，第 2/3/5 步无法测（脚本会提示并退出）。
 *   - 此脚本只改内存中的临时文档，不改 rocxps 源码、不改用户文档。
 *
 * 跑完怎么看（判读表）：
 *   ┌───────────────────────────────┬──────────────────────────────────────────────┐
 *   │ 结果                          │ 结论 / 下一步                                 │
 *   ├───────────────────────────────┼──────────────────────────────────────────────┤
 *   │ 2 与 3 均 OK                  │ Imaging 后台写入成立。像素传输可完全脱离激活文档 │
 *   │ 4 也 OK                       │ batchPlay 结构操作可后台执行，贴回可彻底后台化    │
 *   │ 4 FAIL，其余 OK               │ 只有「加蒙版」需要激活：把激活窗口压缩到建图层   │
 *   │                               │ +加蒙版（毫秒级），putPixels/putLayerMask 仍后台 │
 *   │ 1 FAIL 但 1b OK               │ createLayer 需换成 batchPlay make layer（带文档）│
 *   │ 7 FAIL                        │ 删除图层需换成 batchPlay delete（带文档 target） │
 *   │ 2 FAIL                        │ Imaging 也不支持后台写 → 只能临时激活整个贴回链路 │
 *   │ 5 FAIL 但 4 OK                │ 蒙版能建但不能写 → 激活态下写蒙版，或降级为合成  │
 *   │ 6 FAIL                        │ 视图收尾失败只影响观感，不影响图层内容，可忽略   │
 *   └───────────────────────────────┴──────────────────────────────────────────────┘
 *
 * 用法：在 rocxps 插件的 DevTools Console 里整段粘贴回车。日志前缀统一为 [BG]。
 */

(async () => {
  if (typeof require !== "function") {
    console.error("[BG] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
    return;
  }

  const ps = require("photoshop");
  const { app, core, action, imaging, constants } = ps;
  const BP = { synchronousExecution: true, dialogOptions: "dontDisplay" };
  const log = (...a) => console.log("[BG]", ...a);
  const isErr = (r) => Array.isArray(r) && r.some((x) => x && x._obj === "error");

  if (!imaging || typeof imaging.putPixels !== "function") {
    console.error("[BG] 当前 Photoshop 没有 imaging.putPixels（需要 PS 24.4+），无法继续");
    return;
  }

  // 生成一张纯色 RGBA 的 imageData（用于 putPixels）
  const solid = async (w, h, rgba) => {
    const buf = new Uint8Array(w * h * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = rgba[0];
      buf[i + 1] = rgba[1];
      buf[i + 2] = rgba[2];
      buf[i + 3] = rgba[3];
    }
    return imaging.createImageDataFromBuffer(buf, {
      width: w,
      height: h,
      components: 4,
      colorSpace: "RGB",
      colorProfile: "sRGB IEC61966-2.1",
    });
  };

  await core.executeAsModal(
    async () => {
      let docA = null;
      let docB = null;
      let layer = null;

      try {
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

        // 关键前提：让 A 成为激活文档，所有后续操作都针对后台的 B
        app.activeDocument = docA;
        log("准备：active =", app.activeDocument.id, "| A =", docA.id, "| B =", docB.id);

        // 1) DOM createLayer 作用于非激活文档 B
        try {
          layer = await docB.createLayer(constants.LayerKind.NORMAL, { name: "BG-TEST" });
          log("1 docB.createLayer():", layer ? "OK id=" + layer.id : "返回 null");
        } catch (e) {
          log("1 docB.createLayer(): FAIL", e.message);
        }

        // 1b) 兜底：batchPlay make layer，显式 target 文档 B
        if (!layer) {
          try {
            const r = await action.batchPlay(
              [
                {
                  _obj: "make",
                  _target: [{ _ref: "document", _id: docB.id }],
                  new: { _obj: "layer", name: "BG-TEST-AM" },
                },
              ],
              BP,
            );
            log(
              "1b make layer w/ document target:",
              isErr(r) ? "ERROR " + JSON.stringify(r) : "OK",
            );
          } catch (e) {
            log("1b make layer w/ document target: FAIL", e.message);
          }
        }

        // 2) 指定 documentID 写像素（B 不是激活文档）
        const targetLayerId = layer ? layer.id : docB.layers[0].id;
        let pix = null;
        try {
          pix = await solid(8, 8, [255, 0, 0, 255]);
          await imaging.putPixels({
            documentID: docB.id,
            layerID: targetLayerId,
            imageData: pix,
            replace: true,
            targetBounds: { left: 0, top: 0, width: 8, height: 8 },
          });
          log("2 putPixels(documentID, 后台文档): OK");
        } catch (e) {
          log("2 putPixels(documentID, 后台文档): FAIL", e.message);
        } finally {
          if (pix) {
            try {
              await pix.dispose();
            } catch (e) {
              /* 忽略 */
            }
          }
        }

        // 3) 回读校验（仍不切激活）
        try {
          const r = await imaging.getPixels({
            documentID: docB.id,
            layerID: targetLayerId,
            sourceBounds: { left: 0, top: 0, right: 8, bottom: 8 },
          });
          const d = await r.imageData.getData({});
          log(
            "3 回读像素:",
            d[0],
            d[1],
            d[2],
            d[3],
            "| active 仍是 A:",
            app.activeDocument.id === docA.id,
          );
          await r.imageData.dispose();
        } catch (e) {
          log("3 回读: FAIL", e.message);
        }

        if (layer) {
          // 4) batchPlay 给后台文档的图层加蒙版（显式 document + layer target）
          try {
            const r = await action.batchPlay(
              [
                {
                  _obj: "make",
                  _target: [
                    { _ref: "document", _id: docB.id },
                    { _ref: "layer", _id: layer.id },
                  ],
                  new: { _obj: "channel" },
                  at: { _ref: "channel", _enum: "channel", _value: "mask" },
                  using: { _enum: "userMaskEnabled", _value: "revealAll" },
                },
              ],
              BP,
            );
            log(
              "4 make layer mask w/ document+layer target:",
              isErr(r) ? "ERROR " + JSON.stringify(r) : "OK",
            );
          } catch (e) {
            log("4 make layer mask: FAIL", e.message);
          }

          // 5) 对后台文档 putLayerMask（整画布全白蒙版）
          let m = null;
          try {
            m = await imaging.createImageDataFromBuffer(new Uint8Array(128 * 128).fill(255), {
              width: 128,
              height: 128,
              components: 1,
              colorSpace: "Grayscale",
              colorProfile: "Gray Gamma 2.2",
            });
            await imaging.putLayerMask({
              documentID: docB.id,
              layerID: layer.id,
              kind: "user",
              replace: true,
              imageData: m,
              targetBounds: { left: 0, top: 0, width: 128, height: 128 },
            });
            log("5 putLayerMask(documentID, 后台文档): OK");
          } catch (e) {
            log("5 putLayerMask: FAIL", e.message);
          } finally {
            if (m) {
              try {
                await m.dispose();
              } catch (e) {
                /* 忽略 */
              }
            }
          }
        }

        // 6) 视图收尾：带 document target 的 select（切回复合通道）
        try {
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
          log(
            "6 select composite w/ document target:",
            isErr(r) ? "ERROR " + JSON.stringify(r) : "OK",
          );
        } catch (e) {
          log("6 select composite: FAIL", e.message);
        }

        // 7) 非激活文档删图层
        if (layer) {
          try {
            layer.delete();
            log("7 layer.delete() 后台: OK");
          } catch (e) {
            log("7 layer.delete() 后台: FAIL", e.message);
          }
        }
      } catch (e) {
        log("整体失败:", e.message);
      } finally {
        // 无论成功失败都把临时文档无保存关闭，避免污染用户会话
        try {
          if (docA) docA.closeWithoutSaving();
        } catch (e) {
          /* 忽略 */
        }
        try {
          if (docB) docB.closeWithoutSaving();
        } catch (e) {
          /* 忽略 */
        }
        log("已清理测试文档（A/B 均未保存关闭）");
      }
    },
    { commandName: "rocxps 后台贴回能力实测" },
  );
})();
