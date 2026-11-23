/*
 * SiliconedBridge.h — Adobe UXP Hybrid Plugin addon 公共接口
 *
 * 只对外导出一个 native function:
 *   - runCommand(opts):执行命令并捕获 stdout/stderr
 *
 * 来源:复制自 RocX 仓库 native/RocXBridge（RocX LICENSE 为 MIT，
 * 原文件头部标注 Apache 2.0），裁剪为仅保留 runCommand。
 * 平台特定实现见 SiliconedBridgeCommand.mm。
 */
#ifndef SILICONED_BRIDGE_H
#define SILICONED_BRIDGE_H

#include <string>
#include <vector>

#include "UxpAddon.h"

/** 命令执行结果 */
struct CommandResult {
    bool ok = false;
    int exitCode = -1;
    std::string out;         // stdout
    std::string err;         // stderr
    std::string error;       // ok=false 时填人类可读原因(如 "timeout" / "spawn failed")
    bool truncated = false;  // 输出超过上限被截断
};

/**
 * 平台分发:执行命令并捕获输出
 * macOS:posix_spawn + pipe()
 *
 * @param exe 可执行文件绝对路径
 * @param args 参数列表(不含 argv[0])
 * @param cwd 工作目录,空字符串表示不切换
 * @param timeoutMs 超时毫秒数,<=0 表示不超时
 */
CommandResult RunCommandForPlatform(const std::string& exe,
                                    const std::vector<std::string>& args,
                                    const std::string& cwd,
                                    int timeoutMs);

/**
 * exports.runCommand 的 C++ 实现(JS 线程调用)
 * 入参:{ exe: string, args?: string[], cwd?: string, timeoutMs?: number }
 * 返回:Promise<{ ok, exitCode, out, err, error?, truncated }>
 */
addon_value RunCommandImpl(addon_env env, addon_callback_info info);

/**
 * 原生浮窗任务栏(SiliconedBridgeToolbar.mm):
 *   showToolbar({width?, height?})  — 无边框 NSPanel,创建即在目标位置(无闪烁),
 *                                     不抢 PS 焦点;重复调用重新显示并重定位。
 *   hideToolbar()                   — 收起浮窗(复用不销毁,可再 show)。
 *   setToolbarState(state)          — 推送 UI 状态:{mode,status?,statusError?,
 *                                     busy?,placeholder?,value?},字段缺省=不变。
 *   waitToolbarEvent()              — Promise<{raw: string} | null>,UI 事件 JSON
 *                                     (click{id} / input{value} / error{message})。
 * 实验性:hybrid 官方只承诺计算/逻辑,画 UI 属未支持路径,PS 大版本更新需复测。
 */
addon_value ShowToolbarImpl(addon_env env, addon_callback_info info);
addon_value HideToolbarImpl(addon_env env, addon_callback_info info);
addon_value SetToolbarStateImpl(addon_env env, addon_callback_info info);
addon_value WaitToolbarEventImpl(addon_env env, addon_callback_info info);

/**
 * addon init 入口 — 把 runCommand 挂到 exports 后返回 exports
 * 签名必须为 (addon_env, addon_value, const addon_apis&),由 UXP_ADDON_INIT 宏展开调用
 */
addon_value SiliconedBridgeInit(addon_env env, addon_value exports, const addon_apis& addonAPIs);

/**
 * addon terminate 入口 — 签名必须为 (addon_env),由 UXP_ADDON_TERMINATE 宏展开调用
 */
void SiliconedBridgeTerminate(addon_env env);

#endif /* SILICONED_BRIDGE_H */
