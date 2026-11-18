import "./app.css";
import "./index.scss";
import React from "react";
import ReactDOM from "react-dom/client";
import { flushSync } from "react-dom";

import { App } from "./main";
import { initUXP } from "./api/uxp";

console.clear(); // Clear logs on each reload

// UXP 中 <head> 里的脚本可能先于 <body> 解析执行，此时 #app 尚不存在，
// createRoot(null) 会抛错导致所有面板空白。这里等 DOM 就绪后再挂载。
let mounted = false;
const mount = () => {
  if (mounted) return;
  const el = document.getElementById("app");
  if (!el) return;
  mounted = true;
  const root = ReactDOM.createRoot(el);
  // 同步提交：UXP 初始化二级面板时要能在 DOM 中找到 <uxp-panel panelid>，
  // React 19 的 render() 默认异步提交会与之竞态（Settings 面板空白）
  flushSync(() =>
    root.render(
      <React.StrictMode>
        <App />
      </React.StrictMode>,
    ),
  );
  initUXP();
};

mount();
document.addEventListener?.("DOMContentLoaded", mount);
// 兜底：个别 UXP 版本 DOMContentLoaded 不可靠
setTimeout(mount, 50);
