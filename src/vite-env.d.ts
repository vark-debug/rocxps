/// <reference types="vite/client" />

// TODO - not working in Svelte
import { HTMLWebViewElement as UXPHTMLWebViewElement } from "@adobe/cc-ext-uxp-types/uxp/index";
import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare global {
  interface Window {
    webview: UXPHTMLWebViewElement;
  }
}

// UXP 内置 Spectrum 组件（sp-* 自定义元素）的 JSX 类型声明：
// 组件属性较宽泛且无官方 TS 类型，统一用宽松类型承接（具体属性以 UXP 文档为准）。
// 小写原生事件须显式声明为带参函数类型：若只靠索引签名（属性解析为 any），
// 回调参数拿不到上下文类型，会在 noImplicitAny 下报 TS7006。
type SpectrumElementProps = DetailedHTMLProps<
  HTMLAttributes<HTMLElement>,
  HTMLElement
> & {
  oninput?: (event: any) => void;
  onchange?: (event: any) => void;
  onblur?: (event: any) => void;
  onclick?: (event: any) => void;
  [key: string]: any;
};

// React 19 起全局 JSX 命名空间已迁至 React.JSX，须以模块增强方式扩展
declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "sp-heading": SpectrumElementProps;
      "sp-label": SpectrumElementProps;
      "sp-detail": SpectrumElementProps;
      "sp-body": SpectrumElementProps;
      "sp-divider": SpectrumElementProps;
      "sp-button": SpectrumElementProps;
      "sp-action-button": SpectrumElementProps;
      "sp-icon": SpectrumElementProps;
      "sp-textfield": SpectrumElementProps;
      "sp-textarea": SpectrumElementProps;
      "sp-picker": SpectrumElementProps;
      "sp-menu": SpectrumElementProps;
      "sp-menu-item": SpectrumElementProps;
      "sp-checkbox": SpectrumElementProps;
      "sp-radio-group": SpectrumElementProps;
      "sp-radio": SpectrumElementProps;
    }
  }
}
