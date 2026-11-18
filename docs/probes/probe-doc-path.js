/**
 * rocxps 探针 #4：Document 的路径字段在「另存为 / 重开」后的真实值
 *
 * 背景（已实测）：
 *   上一轮探针里 saveAs.png(file, {}, true) 之后 doc.path 仍是空串。
 *   怀疑原因是 asCopy=true：它只写副本，不会把文档与文件关联，所以 path 不更新。
 *   本探针用 asCopy=true / asCopy=false 两种保存方式来验证这个判断，
 *   并对比 path / title / name / 画布尺寸 / nativePath。
 *
 * 验证内容（日志前缀 [PATH]）：
 *   1) 新建未保存文档：path / title / name
 *   2) saveAs.png(file1, {}, true)  → path 是否仍为空（对照组，解释上一轮结果）
 *   3) saveAs.png(file2, {}, false) → path 是否变成 file2 的真实路径
 *   4) 关闭后 app.open(file2)        → 重开文档的 path / title / name
 *   5) 路径比较：doc.path vs file.nativePath（去掉 file:// 前缀后比较）
 *
 * 会创建什么：
 *   - UXP 临时目录下的两个 PNG：rocxps-path-copy.png、rocxps-path-save.png
 *   - 一个 64×64 白底临时文档（之后关闭，不保存）
 *
 * 会留下什么：
 *   - 正常结束：临时文档 closeWithoutSaving，两个临时文件尝试删除；
 *     删除失败时留在系统临时目录（系统清理临时目录时会消失）。
 *   - 脚本崩溃时可能残留文档和/或文件。
 *
 * 什么情况下会失败 / 不要跑：
 *   - 有未保存的工作时不要跑（会创建、另存、关闭文档并抢焦点）。
 *   - 正在使用 modal 工具（自由变换、裁剪、Camera Raw、文字编辑）时，
 *     executeAsModal 进不去，脚本整体失败。
 *   - UXP 临时目录不可写 / 文件被占用时，createFile 会失败（脚本会打印原因）。
 *
 * 判读表：
 *   ┌──────────────────────────────────────────────┬──────────────────────────────────┐
 *   │ 结果                                         │ 结论                             │
 *   ├──────────────────────────────────────────────┼──────────────────────────────────┤
 *   │ 2 的 path 为空                               │ asCopy=true 不关联文件（符合预期）│
 *   │ 3 的 path 为空                               │ path 不可靠，不能做次级匹配键    │
 *   │ 3 的 path 非空且 == nativePath               │ 已保存文档可用 path + 宽高匹配   │
 *   │ 4 的 path 非空                               │ 重开文档同样可用 path            │
 *   │ title/name 含文件名                          │ path 为空时可用 title + 宽高，  │
 *   │                                              │ 但必须唯一命中，否则转人工       │
 *   │ title 带额外装饰（缩放/颜色模式等）           │ 需要先规范化再比较，或不用 title │
 *   └──────────────────────────────────────────────┴──────────────────────────────────┘
 *
 * 用法：整段粘贴到 rocxps 插件 DevTools Console。
 */

(async () => {
  if (typeof require !== "function") {
    console.error("[PATH] 当前上下文没有 require，请在 rocxps 插件的 DevTools Console 里运行");
    return;
  }

  const ps = require("photoshop");
  const { app, core } = ps;
  const uxp = require("uxp");
  const fs = uxp.storage.localFileSystem;
  const log = (...a) => console.log("[PATH]", ...a);

  const stripFilePrefix = (p) => String(p == null ? "" : p).replace(/^file:\/\//, "");

  const snap = (label, doc) => {
    let info = null;
    try {
      info = {
        path: doc.path,
        title: doc.title,
        name: doc.name,
        width: doc.width,
        height: doc.height,
        saved: doc.saved,
      };
    } catch (e) {
      info = { error: e.message };
    }
    log(label, info);
    return info;
  };

  await core.executeAsModal(
    async () => {
      let doc = null;
      let reopened = null;
      let file1 = null;
      let file2 = null;

      try {
        const folder = await fs.getTemporaryFolder();
        file1 = await folder.createFile("rocxps-path-copy.png", { overwrite: true });
        file2 = await folder.createFile("rocxps-path-save.png", { overwrite: true });
        log("临时文件:", { file1: file1.nativePath, file2: file2.nativePath });

        doc = await app.documents.add({
          width: 64,
          height: 64,
          resolution: 72,
          mode: "RGBColorMode",
          fill: "white",
        });
        if (!doc) throw new Error("建临时文档失败");

        const s1 = snap("1 新建未保存:", doc);

        // asCopy=true：只写副本，不关联文档
        await doc.saveAs.png(file1, {}, true);
        const s2 = snap("2 saveAs asCopy=true（预期 path 仍为空）:", doc);

        // asCopy=false：把文档真正保存到 file2
        await doc.saveAs.png(file2, {}, false);
        const s3 = snap("3 saveAs asCopy=false（预期 path 变为 file2 路径）:", doc);

        const pathEqualsFile3 = stripFilePrefix(s3.path) === stripFilePrefix(file2.nativePath);
        log("3 路径比较:", {
          docPath: s3.path,
          fileNativePath: file2.nativePath,
          pathEqualsFile: pathEqualsFile3,
        });

        doc.closeWithoutSaving();

        reopened = await app.open(file2);
        if (!reopened) throw new Error("重新打开临时文件失败");
        const s4 = snap("4 重新打开后:", reopened);

        const pathEqualsFile4 = stripFilePrefix(s4.path) === stripFilePrefix(file2.nativePath);
        const nameEqualsFile = String(s4.name) === String(file2.name);
        const titleHasName = String(s4.title).indexOf(String(file2.name)) >= 0;
        log("5 路径/名称可用性:", {
          pathEqualsFile: pathEqualsFile4,
          docName: s4.name,
          fileName: file2.name,
          nameEqualsFile,
          docTitle: s4.title,
          titleHasName,
          width: s4.width,
          height: s4.height,
        });

        // 对照上一轮：asCopy=true 之后 path 为空是预期行为，不是 PS 异常
        log("对照结论:", {
          asCopyTrueKeepsPathEmpty: s2.path === "",
          asCopyFalseSetsPath: s3.path !== "",
          reopenKeepsPath: s4.path !== "",
        });
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
          if (file1) await file1.delete();
        } catch (e) {
          /* 忽略：临时文件删不掉时会留在系统临时目录 */
        }
        try {
          if (file2) await file2.delete();
        } catch (e) {
          /* 忽略：临时文件删不掉时会留在系统临时目录 */
        }
        log("已清理临时文档与临时文件（删不掉时会留在系统临时目录）");
      }
    },
    { commandName: "rocxps doc.path 字段实测" },
  );
})();
