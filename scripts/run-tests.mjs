/**
 * 单测运行器：用 esbuild 打包 src 下的 .test.ts 文件为 ESM，
 * 交给 Node 内置 test runner 执行（零额外依赖，绕开 npm git 依赖限制）。
 */
import { build } from "esbuild";
import { globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import process from "node:process";

const entries = globSync("src/**/*.test.ts");
if (entries.length === 0) {
  console.error("未找到任何 *.test.ts");
  process.exit(1);
}

const outDir = await mkdtemp(join(tmpdir(), "rocxps-test-"));
try {
  await build({
    entryPoints: entries,
    outdir: outDir,
    bundle: true,
    format: "esm",
    platform: "node",
    sourcemap: false,
    outExtension: { ".js": ".mjs" },
    logLevel: "warning",
  });
  const testFiles = globSync(join(outDir, "**/*.mjs"));
  const r = spawnSync(process.execPath, ["--test", ...testFiles], {
    stdio: "inherit",
  });
  process.exitCode = r.status ?? 1;
} finally {
  await rm(outDir, { recursive: true, force: true });
}
