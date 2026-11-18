/**
 * rocxps 探针 #2：Photoshop 的 Document.id 生命周期（另存为 / 关闭重开）
 *
 * 验证内容（结果打印为 [ID]）：
 *   a) 新建文档时的 doc.id（idCreate）
 *   b) 执行 saveAs.png(asCopy=true) 后的 doc.id（idAfterSaveAs）
 *   c) 关闭该文档、再用 app.open() 打开同一文件后的 id（idReopened）
 *   d) doc.path 在已保存文档上是什么形态（本地文件全路径 / 云文档标识符）
 *
 * 会创建什么：
 *   - UXP 临时目录下的文件 bg-id-test.png（64×64 白底）
 *   - 一个临时文档（之后关闭、不保存）
 *
 * 会留下什么：
 *   - 正常结束时，临时文档 closeWithoutSaving，临时文件尝试删除；
 *     若删除失败，文件留在系统临时目录（重启/清理临时目录会自动消失）。
 *   - 若脚本中途崩溃，可能残留一个未保存文档和/或临时 PNG。
 *
 * 什么情况下会失败 / 不要跑：
 *   - 有未保存的工作时不要跑：会创建、另存、关闭文档并抢焦点。
 *   - 当前处于 modal 工具中（自由变换、裁剪、Camera Raw、文字编辑等）时，
 *     executeAsModal 进不去，脚本直接失败；先结束工具再跑。
 *   - UXP 存储权限异常 / 临时目录不可写时，创建文件这一步会失败。
 *   - 若目标临时文件名被其他进程占用，createFile 可能失败（脚本会报出来）。
 *
 * 跑完怎么看（判读表）：
 *   ┌────────────────────────────────────┬─────────────────────────────────────────────┐
 *   │ 结果                               │ 结论 / 对贴回设计的影响                      │
 *   ├────────────────────────────────────┼─────────────────────────────────────────────┤
 *   │ idCreate === idAfterSaveAs         │ 另存为不改变 id → 文档仍打开时按 id 仍能找到  │
 *   │                                    │ （改名/另存场景可继续用原 docId 贴回）        │
 *   │ idCreate !== idAfterSaveAs         │ 另存为会重建文档对象 → 贴回必须容忍 id 变化， │
 *   │                                    │ 需要「路径 + 画布尺寸」次级匹配               │
 *   │ idReopened !== idCreate            │ 关闭重开必然是新 id（预期）→ 旧 docId 失效，  │
 *   │                                    │ 只能走次级匹配或让用户手动重贴                │
 *   │ path 是非空绝对路径                │ 可用 path 作为次级匹配键（本地文件）          │
 *   │ path 为空 / 是标识符               │ 未保存文档或云文档，不适合做自动匹配          │
 *   └────────────────────────────────────┴─────────────────────────────────────────────┘
 *
 * 用法：在 rocxps 插件的 DevTools Console 里整段粘贴回车。日志前缀统一为 [ID]。
 */

  (async () => {
    if (typeof require !== "function") {
      console.error("[ID] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
      return;
    }
  
    const ps = require("photoshop");
    const { app, core } = ps;
    const uxp = require("uxp");
    const fs = uxp.storage.localFileSystem;
    const log = (...a) => console.log("[ID]", ...a);
  
    await core.executeAsModal(
      async () => {
        let doc = null;
        let reopened = null;
        let file = null;
  
        try {
          const folder = await fs.getTemporaryFolder();
          file = await folder.createFile("bg-id-test.png", { overwrite: true });
  
          doc = await app.documents.add({
            width: 64,
            height: 64,
            resolution: 72,
            mode: "RGBColorMode",
            fill: "white",
          });
          if (!doc) throw new Error("建临时文档失败");
  
          const idCreate = doc.id;
          const pathBeforeSave = doc.path;
  
          // asCopy=true：另存为副本，文档本身保持打开
          await doc.saveAs.png(file, {}, true);
          const idAfterSaveAs = doc.id;
          const pathAfterSave = doc.path;
  
          log("路径:", { pathBeforeSave, pathAfterSave });
  
          doc.closeWithoutSaving();
  
          reopened = await app.open(file);
          if (!reopened) throw new Error("重新打开临时文件失败");
          const idReopened = reopened.id;
  
          const result = {
            idCreate,
            idAfterSaveAs,
            idReopened,
            sameAfterSaveAs: idCreate === idAfterSaveAs,
            sameAfterReopen: idCreate === idReopened,
            pathAfterSave,
          };
          log("结论:", result);
  
          // 对照判读表，把最关键的两条也直接打成人话
          log(
            "另存为后 id " + (result.sameAfterSaveAs ? "未变（可继续按 id 贴回）" : "已变（需要次级匹配）"),
          );
          log(
            "关闭重开后 id " +
              (result.sameAfterReopen ? "仍然相同（与预期不符，需进一步确认）" : "已变（旧 docId 失效，需次级匹配）"),
          );
        } catch (e) {
          log("失败:", e.message);
        } finally {
          try {
            if (reopened) reopened.closeWithoutSaving();
          } catch (e) {
            /* 忽略 */
          }
          try {
            if (doc) doc.closeWithoutSaving();
          } catch (e) {
            /* 忽略 */
          }
          try {
            if (file) await file.delete();
          } catch (e) {
            /* 忽略：临时目录文件删不掉也不影响结论 */
          }
          log("已清理临时文档与临时文件（删不掉时会留在系统临时目录）");
        }
      },
      { commandName: "rocxps docId 生命周期实测" },
    );
  })();
