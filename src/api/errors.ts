/** Temporary polyfill Global Error Handler until Adobe adds it natively to UXP
 *  Must be manually triggered with safe() or safeAsync() function
 * @param {function} callback optional callback to send error reports to an error tracking or logging service
 *  */

/** 在面板顶部渲染可见的错误横幅（PS 内看不到 console，靠它暴露运行时错误）。 */
const showBanner = (message: string, stack?: string) => {
  try {
    let banner = document.getElementById("uxp-error-banner") as
      | HTMLDivElement
      | null;
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "uxp-error-banner";
      banner.style.cssText =
        "position:fixed;left:0;right:0;bottom:0;z-index:99999;" +
        "max-height:40%;overflow:auto;background:#c9382e;color:#fff;" +
        "padding:8px 10px;font-size:11px;white-space:pre-wrap;" +
        "border-top:2px solid #8f231c;";
      document.body?.appendChild(banner);
    }
    banner.textContent = `⚠ ${message}${stack ? `\n${stack.split("\n").slice(0, 4).join("\n")}` : ""}`;
  } catch {
    // document 未就绪时静默，避免二次抛错
  }
};

export const polyFillGlobalErrorHandler = (callback?: (error: any) => void) => {
  if (!Object.hasOwn(window, "onerror")) {
    //@ts-ignore
    window.onerror = (error: {
      message: string;
      name: string;
      stack: string;
    }) => {
      console.error(error);
      showBanner(
        error?.message ?? String(error),
        typeof error?.stack === "string" ? error.stack : undefined,
      );
      //* Add any Global actions for Handlers like Sentry / Logging here
      if (callback) callback(error);
      return true;
    };
  }
  // 未捕获的 Promise 拒绝同样上屏
  window.addEventListener?.("unhandledrejection", (event) => {
    const reason = (event as PromiseRejectionEvent).reason;
    console.error("Unhandled rejection:", reason);
    showBanner(
      `Unhandled rejection: ${reason?.message ?? String(reason)}`,
      typeof reason?.stack === "string" ? reason.stack : undefined,
    );
  });
};

/** Manually throw error to global error handler polyFillGlobalErrorHandler */
export const throwErr = (error: any) => {
  window.onerror!(error);
};

/** Run a sync function safely.
 * Errors will be caught and sent to the global error handler polyFillGlobalErrorHandler */
export const safe = <T>(func: () => T): T | Error => {
  try {
    return func();
  } catch (error: any) {
    throwErr(error);
    return error;
  }
};

/** Run an async function safely.
 * Errors will be caught and sent to the global error handler polyFillGlobalErrorHandler */
export const safeAsync = async <T>(
  func: () => Promise<T>,
): Promise<T | Error> => {
  try {
    return await func();
  } catch (error: any) {
    throwErr(error);
    return error;
  }
};
