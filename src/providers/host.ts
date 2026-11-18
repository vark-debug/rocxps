import { os } from "../globals";

/** 当前宿主是否 macOS（Siliconed 等本地能力的静态状态判断用）。 */
export const isMacHost = (): boolean => {
  const platform = (os as unknown as { platform: string | (() => string) })
    .platform;
  return typeof platform === "function"
    ? platform() === "darwin"
    : platform === "darwin";
};
