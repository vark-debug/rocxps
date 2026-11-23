import React from "react";

import { uxp } from "./globals";
import { RedrawPanel } from "./components/RedrawPanel";
import { SelectionPanel } from "./components/SelectionPanel";
import { SettingsPanel } from "./components/SettingsPanel";

const id = uxp.entrypoints._pluginInfo.id;

// React 19 的 JSX 命名空间位于 react 模块下，自定义元素需在此增强
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "uxp-panel": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { panelid?: string },
        HTMLElement
      >;
    }
  }
}

export const App = () => {
  return (
    <>
      <RedrawPanel />
      {/* 设置二级面板（manifest 已注册 `${id}.settings`） */}
      <uxp-panel panelid={`${id}.settings`}>
        <SettingsPanel />
      </uxp-panel>
      {/* 选区浮层实验面板（manifest 已注册 `${id}.selection`） */}
      <uxp-panel panelid={`${id}.selection`}>
        <SelectionPanel />
      </uxp-panel>
    </>
  );
};
