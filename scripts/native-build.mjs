/**
 * native 桥接层编译入口（native:build:mac / dev / build / ccx / zip 共用）。
 *
 * hybrid 源码已移出版本库（见 7202199：native/ 不上传），仓库只保留
 * public-hybrid/{mac,win}/<arch>/SiliconedBridge.uxpaddon 产物，vite 打包
 * （vite-uxp-plugin copyHybridBinaries）直接取该产物，不依赖本地编译。
 *
 * 因此：
 * - 源码在（本地开发者）：照常 cmake 编译；
 * - 源码不在（普通克隆 / CI）：跳过编译并提示，不阻塞后续 vite 构建。
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

const SRC = "native/SiliconedBridge";

if (!existsSync(`${SRC}/CMakeLists.txt`)) {
  console.log(
    "[native] 未找到 native/SiliconedBridge/CMakeLists.txt（hybrid 源码不上传），"
      + "跳过编译，打包使用 public-hybrid/ 内置产物",
  );
  process.exit(0);
}

for (const args of [
  ["-B", `${SRC}/build`, "-S", SRC, "-DCMAKE_BUILD_TYPE=Release"],
  ["--build", `${SRC}/build`, "--config", "Release"],
]) {
  const r = spawnSync("cmake", args, { stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
