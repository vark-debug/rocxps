// 探针：验证当前 PS 里 viewTransform / viewInfo.activeView.globalBounds 是否可用
// 背景：浮条跟随选区依赖 canvasView.ts 的两个私有 batchPlay 属性，
//       部分文档类型上可能不可读导致浮条回退固定定位。本脚本用于真机排查。
// 用法：PS 菜单 文件 > 脚本 > 浏览… 选择本文件，看弹窗结果；
//       在「失效文档」和「生效文档」上各跑一次作对照。
// 注意：本脚本走 ExtendScript executeActionGet，与插件内的 UXP batchPlay
//       是不同代码路径——本脚本失败不代表 UXP batchPlay 也失败。
//       权威判据是插件日志：UXP DevTool 控制台搜 [canvasView]。
function probeViewTransform() {
    try {
        var ref = new ActionReference();
        ref.putProperty(stringIDToTypeID("viewTransform"), stringIDToTypeID("document"));
        ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
        var d = executeActionGet(ref);
        var list = d.getList(stringIDToTypeID("viewTransform"));
        var parts = [];
        for (var i = 1; i <= list.count; i++) {
            parts.push(list.getDouble(i));
        }
        return "VT_OK [" + parts.join(", ") + "]";
    } catch (e) {
        return "VT_FAIL " + e.message;
    }
}

function probeViewInfo() {
    try {
        var ref = new ActionReference();
        ref.putProperty(stringIDToTypeID("viewInfo"), stringIDToTypeID("document"));
        ref.putEnumerated(stringIDToTypeID("document"), stringIDToTypeID("ordinal"), stringIDToTypeID("targetEnum"));
        var d = executeActionGet(ref);
        var vi = d.getObjectValue(stringIDToTypeID("viewInfo"));
        var av = vi.getObjectValue(stringIDToTypeID("activeView"));
        var gb = av.getObjectValue(stringIDToTypeID("globalBounds"));
        function num(o, k) { return o.getUnitDoubleValue(stringIDToTypeID(k)); }
        return "VI_OK L=" + num(gb, "left") + " T=" + num(gb, "top") + " R=" + num(gb, "right") + " B=" + num(gb, "bottom");
    } catch (e) {
        return "VI_FAIL " + e.message;
    }
}

function main() {
    var docCount = 0;
    try { docCount = app.documents.length; } catch (e) {}
    if (docCount === 0) return "NO_DOC（请先打开一个文档）";
    return probeViewTransform() + "\n" + probeViewInfo();
}
alert("PS " + app.version + " 探针结果：\n\n" + main());
