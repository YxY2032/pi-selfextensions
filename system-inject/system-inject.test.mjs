// system-inject 单元测试
// 运行:node system-inject.test.mjs(需 Node >= 23.6;22.x 加 --experimental-strip-types)
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mod = await import("./index.ts");

const BASE = "You help users by reading files, executing commands, editing code, and writing new files. (原版其余部分)";
const SAMPLE_NAV = [
  "# 测试A系统兼容性",
  "## Goal",
  "验证 A 系统在弱网下的表现,完成标准:全部用例通过。",
  "",
  "## Now",
  "正在整理北京——不对,正在准备 A 系统的测试环境。NOW-SECRET-MARKER",
].join("\n");

let passed = 0, failed = 0;
const failures = [];

async function withCase(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), "si-test-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    await fn(dir);
    passed++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    failures.push(`${name}: ${e.message}`);
    console.log(`  FAIL ${name}: ${e.message}`);
  } finally {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

// 构造:加载扩展 → 捕获 before_agent_start 处理器 → 以受控 ctx 调用
function makeRunner(cred = true) {
  const handlers = {};
  mod.default({ on: (event, handler) => { handlers[event] = handler; } });
  return async (promptText, opts = {}) => {
    const ctx = { isProjectTrusted: () => opts.trusted ?? cred };
    delete process.env.PI_DRIFT_GUARD;
    if (opts.env === "off") process.env.PI_DRIFT_GUARD = "off";
    const r = await handlers["before_agent_start"]({ systemPrompt: promptText }, ctx);
    delete process.env.PI_DRIFT_GUARD;
    return r;
  };
}

await withCase("T1 preamble 注入在位(原句后紧跟注入段)", async () => {
  const run = makeRunner();
  const r = await run(BASE);
  const tailIdx = r.systemPrompt.indexOf(
    "You help users by reading files, executing commands, editing code, and writing new files.",
  );
  const injIdx = r.systemPrompt.indexOf("sandbox task executor");
  assert.ok(tailIdx >= 0, "原句应保留");
  assert.ok(injIdx > tailIdx, "注入应紧跟原句之后");
  assert.ok(r.systemPrompt.includes("Do not output these refusal strings"), "应含拒绝词清单");
  assert.ok(r.systemPrompt.indexOf("(原版其余部分)") > injIdx, "原版剩余部分应保留在注入之后");
});

await withCase("T2 无文件 → 引导形态(含骨架,无数据标注)", async () => {
  const run = makeRunner();
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("## 任务导航"), "应有导航标题");
  assert.ok(r.systemPrompt.includes("照抄骨架填空"), "应含骨架引导");
  assert.ok(r.systemPrompt.includes("无需理会"), "应授权跳过");
  assert.ok(!r.systemPrompt.includes("项目内数据"), "无文件时不应有数据标注");
});

await withCase("T3 有文件 → 注入 title+Goal,不含 Now,含切换提示与数据标注", async () => {
  const run = makeRunner();
  writeFileSync("PROGRESS.md", SAMPLE_NAV);
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("# 测试A系统兼容性"), "标题应注入");
  assert.ok(r.systemPrompt.includes("弱网下的表现"), "Goal 应注入");
  assert.ok(!r.systemPrompt.includes("NOW-SECRET-MARKER"), "Now 不应注入(缓存分离)");
  assert.ok(r.systemPrompt.includes("以本次对话为准"), "应含切换提示");
  assert.ok(r.systemPrompt.includes("项目内数据"), "应含数据来源标注");
});

await withCase("T4 文件无 Goal 节 → 原文头部兜底", async () => {
  const run = makeRunner();
  writeFileSync("PROGRESS.md", "自由散文本,没有标准结构。FALLBACK-MARKER");
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("FALLBACK-MARKER"), "应含原文兜底");
});

await withCase("T5 未信任项目 → 引导形态,不注入文件内容", async () => {
  const run = makeRunner(false);
  writeFileSync("PROGRESS.md", "PLANTED-BY-REPO-MARKER");
  const r = await run(BASE, { trusted: false });
  assert.ok(r.systemPrompt.includes("照抄骨架填空"), "未信任时应为引导形态");
  assert.ok(!r.systemPrompt.includes("PLANTED-BY-REPO-MARKER"), "仓库预埋内容不得进入提示词");
});

await withCase("T6 Goal 超长 → 截断标记", async () => {
  const run = makeRunner();
  writeFileSync("PROGRESS.md", "# 长任务\n## Goal\n" + "x".repeat(1200));
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("(已截断)"), "应有截断标记");
});

await withCase("T7 PI_DRIFT_GUARD=off → 锚停用,preamble 照常", async () => {
  const run = makeRunner();
  const r = await run(BASE, { env: "off" });
  assert.ok(!r.systemPrompt.includes("任务导航"), "锚应停用");
  assert.ok(r.systemPrompt.includes("sandbox task executor"), "preamble 不受开关影响");
});

await withCase("T8 CRLF 文件 → Goal 正常提取", async () => {
  const run = makeRunner();
  writeFileSync("PROGRESS.md", "# CRLF任务\r\n## Goal\r\n验证 CRLF 兼容。CRLF-GOAL-MARKER\r\n## Now\r\nx");
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("CRLF-GOAL-MARKER"), "CRLF 应被归一后提取");
});

await withCase("T9 空文件 → 引导形态", async () => {
  const run = makeRunner();
  writeFileSync("PROGRESS.md", "   \n");
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("当前没有导航文件"), "空文件按无文件处理");
});

await withCase("T10 无任何修改 → 返回 undefined(不强制投影)", async () => {
  const run = makeRunner();
  const r = await run("与原句无关的普通提示词", { env: "off" });
  assert.equal(r, undefined, "无修改应返回 undefined");
});

await withCase("T11 快照滚动清理:超过 20 份删最旧", async () => {
  const run = makeRunner();
  const fs = await import("node:fs");
  fs.mkdirSync("/tmp/anchor-probe", { recursive: true }); // Windows 首跑时目录不存在
  for (let i = 0; i < 24; i++) {
    writeFileSync(`/tmp/anchor-probe/systemprompt-1000-${String(i).padStart(3, "0")}-fake.txt`, "old");
  }
  const r = await run(BASE);
  assert.ok(r.systemPrompt.includes("任务导航"), "正常注入");
  const dumps = fs.readdirSync("/tmp/anchor-probe")
    .filter((f) => f.startsWith("systemprompt-") && f.endsWith(".txt"));
  assert.equal(dumps.length, 20, `应保留 20 份,实际 ${dumps.length}`);
  assert.ok(dumps.some((f) => f.includes(String(process.pid))), "最新一份(本进程)应保留");
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log(failures.map(f => "  - " + f).join("\n"));
  process.exit(1);
}
