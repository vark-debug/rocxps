import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  classifySilicontrolResult,
  findSiliconJobState,
  normalizeSiliconStatus,
  parseSilicontrolOutput,
  type SilicontrolCommandResult,
} from "./silicontrol";
import { ProviderError } from "../providers/http";

const result = (
  over: Partial<SilicontrolCommandResult>,
): SilicontrolCommandResult => ({
  ok: true,
  exitCode: 0,
  out: "",
  err: "",
  ...over,
});

const kindOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ProviderError, `期望 ProviderError，实际 ${String(err)}`);
    return err.kind;
  }
  throw new Error("期望抛出异常，但没有抛出");
};

const messageOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof Error);
    return err.message;
  }
  throw new Error("期望抛出异常，但没有抛出");
};

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof ProviderError);
    return err.code;
  }
  throw new Error("期望抛出异常，但没有抛出");
};

describe("parseSilicontrolOutput", () => {
  it("解析单行 status verdict", () => {
    const { lines, verdict } = parseSilicontrolOutput(
      '{"ok":true,"running":null,"queue":[]}\n',
    );
    assert.equal(lines.length, 1);
    assert.equal(verdict.ok, true);
  });

  it("解析 wait 的 type 行 + 末行 verdict", () => {
    const { lines, verdict } = parseSilicontrolOutput(
      [
        '{"type":"image","job":"t3","path":"/tmp/a.png"}',
        '{"type":"image","job":"t3","path":"/tmp/b.png"}',
        '{"ok":true,"count":2}',
      ].join("\n"),
    );
    assert.equal(lines.length, 3);
    assert.equal(lines[0].type, "image");
    assert.equal(lines[1].path, "/tmp/b.png");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.count, 2);
  });

  it("空输出 → terminal", () => {
    assert.equal(
      kindOf(() => parseSilicontrolOutput("  \n ")),
      "terminal",
    );
  });

  it("truncated → terminal", () => {
    const message = messageOf(() =>
      parseSilicontrolOutput('{"ok":true}', true),
    );
    assert.match(message, /截断/);
  });

  it("非法 JSON 行 → terminal 且指出行号", () => {
    const message = messageOf(() =>
      parseSilicontrolOutput('{"ok":true}\nnot-json\n{"ok":true}'),
    );
    assert.match(message, /第 2 行/);
  });

  it("末行缺少 ok verdict → terminal", () => {
    const message = messageOf(() =>
      parseSilicontrolOutput('{"type":"stage","stage":"denoising"}'),
    );
    assert.match(message, /verdict/);
  });
});

describe("classifySilicontrolResult", () => {
  it("退出码 0 + ok:true → 返回解析结果", () => {
    const parsed = classifySilicontrolResult(
      result({ out: '{"ok":true,"job":"t3","position":0}' }),
      "提交",
    );
    assert.equal(parsed.verdict.job, "t3");
  });

  it("退出码 3（app 不可达）→ retryable", () => {
    const message = messageOf(() =>
      classifySilicontrolResult(
        result({ exitCode: 3, err: "connect failed" }),
        "状态查询",
      ),
    );
    assert.equal(
      kindOf(() =>
        classifySilicontrolResult(
          result({ exitCode: 3, err: "connect failed" }),
          "状态查询",
        ),
      ),
      "retryable",
    );
    assert.match(message, /无法连接 Siliconed/);
  });

  it("退出码 2 + format 错误 → terminal 且给出尺寸提示", () => {
    const message = messageOf(() =>
      classifySilicontrolResult(
        result({
          exitCode: 2,
          out: '{"ok":false,"error":"format","message":"bad format"}',
        }),
        "提交",
      ),
    );
    assert.equal(
      kindOf(() =>
        classifySilicontrolResult(
          result({
            exitCode: 2,
            out: '{"ok":false,"error":"format","message":"bad format"}',
          }),
          "提交",
        ),
      ),
      "terminal",
    );
    assert.match(message, /32 的倍数/);
  });

  it("退出码 2 且无 JSON → terminal，保留 stderr", () => {
    const message = messageOf(() =>
      classifySilicontrolResult(
        result({ exitCode: 2, err: "usage: silicontrol add ..." }),
        "提交",
      ),
    );
    assert.match(message, /usage/);
  });

  it("退出码 1 + license_not_accepted → terminal 且提示接受许可", () => {
    const res = result({
      exitCode: 1,
      out: '{"ok":false,"error":"license_not_accepted","message":"license required"}',
    });
    assert.equal(
      kindOf(() => classifySilicontrolResult(res, "等待任务")),
      "terminal",
    );
    assert.match(
      messageOf(() => classifySilicontrolResult(res, "等待任务")),
      /接受/,
    );
  });

  it("退出码 1 + queue_full → retryable", () => {
    const res = result({
      exitCode: 1,
      out: '{"ok":false,"error":"queue_full","message":"queue is full"}',
    });
    assert.equal(kindOf(() => classifySilicontrolResult(res, "提交")), "retryable");
  });

  it("退出码 1 + 渲染失败（jobs.outcome）→ terminal 且带任务明细", () => {
    const res = result({
      exitCode: 1,
      out: JSON.stringify({
        ok: false,
        error: "render",
        jobs: [
          {
            job: "t3",
            outcome: "error",
            code: "insufficient_memory",
            message: "out of memory",
          },
        ],
      }),
    });
    const message = messageOf(() => classifySilicontrolResult(res, "等待任务"));
    assert.match(message, /t3/);
    assert.match(message, /out of memory/);
    assert.match(message, /内存不足/);
  });

  it("退出码 3 带 exitNotes（upscale）→ 覆盖默认的「app 不可达」语义", () => {
    const res = result({ exitCode: 3, err: "weights missing" });
    const note = { 3: { message: "权重缺失或内存不足" } };
    assert.equal(
      kindOf(() => classifySilicontrolResult(res, "超分", 15_000, false, note)),
      "terminal",
    );
    assert.match(
      messageOf(() => classifySilicontrolResult(res, "超分", 15_000, false, note)),
      /权重缺失/,
    );
  });

  it("退出码 4 / 5 带 exitNotes 时给出可操作提示", () => {
    const notes = {
      3: { message: "权重缺失或内存不足" },
      4: { message: "目标尺寸超过本机画布上限" },
      5: { message: "预计耗时超过 10 分钟" },
    };
    assert.match(
      messageOf(() =>
        classifySilicontrolResult(
          result({ exitCode: 4 }),
          "超分",
          15_000,
          false,
          notes,
        ),
      ),
      /画布上限/,
    );
    assert.match(
      messageOf(() =>
        classifySilicontrolResult(
          result({ exitCode: 5 }),
          "超分",
          15_000,
          false,
          notes,
        ),
      ),
      /10 分钟/,
    );
  });

  it("allowVerdictError：取消后的 wait verdict 保留 outcome，不直接抛错", () => {
    const res = result({
      exitCode: 1,
      out: JSON.stringify({
        ok: false,
        error: "render",
        jobs: [{ job: "t3", outcome: "stopped" }],
      }),
    });
    const parsed = classifySilicontrolResult(res, "等待任务", 15_000, true);
    assert.equal(parsed.verdict.ok, false);
    assert.equal(
      (parsed.verdict.jobs?.[0] as { outcome?: string })?.outcome,
      "stopped",
      "取消必须能读到 stopped / removed，不能当成普通失败",
    );
  });

  it("addon 超时 → timeout", () => {
    const res = result({ exitCode: -1, error: "timeout" });
    assert.equal(kindOf(() => classifySilicontrolResult(res, "状态查询", 5000)), "timeout");
  });

  it("addon spawn 失败 → terminal 且提示路径", () => {
    const res = result({ exitCode: -1, error: "spawn failed" });
    assert.equal(kindOf(() => classifySilicontrolResult(res, "提交")), "terminal");
    assert.match(
      messageOf(() => classifySilicontrolResult(res, "提交")),
      /silicontrol/,
    );
  });

  it("退出码 0 但 verdict ok:false → terminal", () => {
    const res = result({
      out: '{"ok":false,"error":"model","message":"model missing"}',
    });
    assert.equal(kindOf(() => classifySilicontrolResult(res, "提交")), "terminal");
  });
});

describe("normalizeSiliconStatus / findSiliconJobState", () => {
  const status = normalizeSiliconStatus({
    ok: true,
    running: {
      job: "t3",
      stage: "denoising",
      step: 3,
      steps_total: 8,
      fraction: 0.375,
      remaining_s: 12,
      model: "qwen-image-2.1",
    },
    queue: [{ job: "t4", estimate_s: 20 }],
    waiting_for_license: [],
    installing: null,
    queue_remaining_s: 20,
    remaining_complete: true,
  });

  it("snake_case 字段转 camelCase", () => {
    assert.equal(status.running?.fraction, 0.375);
    assert.equal(status.running?.stepsTotal, 8);
    assert.equal(status.running?.remainingS, 12);
    assert.equal(status.queue[0].estimateS, 20);
    assert.equal(status.queueRemainingS, 20);
  });

  it("computing_on → computingOn；缺失（0.18/0.19）→ null", () => {
    assert.equal(status.computingOn, null);
    const remote = normalizeSiliconStatus({
      ok: true,
      computing_on: "A 的 Mac Studio",
    });
    assert.equal(remote.computingOn, "A 的 Mac Studio");
  });

  it("running / queued / waiting-license / gone 四种状态", () => {
    assert.equal(findSiliconJobState(status, "t3").state, "running");
    assert.equal(findSiliconJobState(status, "t4").state, "queued");
    assert.equal(findSiliconJobState(status, "t4").queueIndex, 0);

    const waiting = normalizeSiliconStatus({
      ok: true,
      waiting_for_license: [{ job: "t5" }],
    });
    assert.equal(findSiliconJobState(waiting, "t5").state, "waiting-license");
    assert.equal(findSiliconJobState(status, "t9").state, "gone");
  });
});

describe("0.20 跨机错误码", () => {
  const failed = (error: string, exitCode = 1) =>
    result({
      exitCode,
      out: JSON.stringify({ ok: false, error, message: `${error} happened` }),
    });

  it("unknown_job → retryable 且提示短重试", () => {
    assert.equal(kindOf(() => classifySilicontrolResult(failed("unknown_job"), "等待任务")), "retryable");
    assert.match(
      messageOf(() => classifySilicontrolResult(failed("unknown_job"), "等待任务")),
      /短重试/,
    );
    assert.equal(
      codeOf(() => classifySilicontrolResult(failed("unknown_job"), "等待任务")),
      "unknown_job",
    );
  });

  it("link（与远端会话断开）→ retryable 且提示重连", () => {
    assert.equal(kindOf(() => classifySilicontrolResult(failed("link"), "提交")), "retryable");
    assert.match(
      messageOf(() => classifySilicontrolResult(failed("link"), "提交")),
      /会话已断开/,
    );
  });

  it("remote（跨机时 install 类命令被拒）→ terminal 且提示切回本机", () => {
    assert.equal(kindOf(() => classifySilicontrolResult(failed("remote"), "安装模型")), "terminal");
    assert.match(
      messageOf(() => classifySilicontrolResult(failed("remote"), "安装模型")),
      /Compute On|切回本机/,
    );
  });

  it("accelerators → 提示先自测 / 检查加速器", () => {
    assert.match(
      messageOf(() => classifySilicontrolResult(failed("accelerators"), "提交")),
      /自测|加速器/,
    );
  });

  it("faster_rendering → 提示先开 Beta 总开关", () => {
    assert.equal(
      kindOf(() => classifySilicontrolResult(failed("faster_rendering"), "设置")),
      "terminal",
    );
    assert.match(
      messageOf(() => classifySilicontrolResult(failed("faster_rendering"), "设置")),
      /set beta faster-rendering on/,
    );
  });

  it("退出码 2 且无 JSON → code=usage（供 macs 在 0.18/0.19 降级）", () => {
    assert.equal(
      codeOf(() =>
        classifySilicontrolResult(
          result({ exitCode: 2, err: "unknown subcommand: macs" }),
          "Siliconed 已配对 Mac 查询",
        ),
      ),
      "usage",
    );
  });
});
