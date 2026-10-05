// drift-guard 单元测试
// 运行:node drift-guard.test.mjs(Node >= 23.6;22.x 加 --experimental-strip-types)
//
// 导入策略:drift-guard.ts 依赖裸导入 "typebox"(运行时由 pi 的虚拟模块提供宿主
// 同一份实例)。单测环境没有宿主,因此把源文件拷贝进带 typebox 桩(Plain-Object
// 最小实现)的临时目录再导入——真实扩展目录保持零 node_modules,避免物理副本
// 遮蔽虚拟模块(见 pi-web-access 的 peerDependencies 告警同类问题)。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// fileURLToPath:Windows 上 URL.pathname 是 "/E:/..." 形态,join 后产生 "E:\E:\..." 无效路径
const SRC = join(dirname(fileURLToPath(import.meta.url)), "drift-guard.ts");

// ── 搭建带桩的运行目录并导入 ─────────────────────────────────
const RUN = mkdtempSync(join(tmpdir(), "dg-run-"));
mkdirSync(join(RUN, "node_modules", "typebox"), { recursive: true });
writeFileSync(join(RUN, "node_modules", "typebox", "package.json"),
  JSON.stringify({ name: "typebox", type: "module", main: "index.js" }));
writeFileSync(join(RUN, "node_modules", "typebox", "index.js"),
  `export const Type = {
    Object: (properties = {}) => ({ type: "object", properties }),
    String: (o = {}) => ({ type: "string", ...(o || {}) }),
    Optional: (t) => t,
  };\n`);
copyFileSync(SRC, join(RUN, "drift-guard.ts"));
const mod = await import(pathToFileURL(join(RUN, "drift-guard.ts")).href);

// ── 加载器(模块级状态跨用例残留 → 每例先 fire 复位)──────────
function load(envOff = false) {
  if (envOff) process.env.PI_DRIFT_GUARD = "off";
  else delete process.env.PI_DRIFT_GUARD;
  const handlers = {};
  let tool = null;
  mod.default({
    on: (e, h) => { (handlers[e] ??= []).push(h); },
    registerTool: (t) => { tool = t; },
  });
  const fire = async (evt, payload = {}, opts = {}) => {
    let out;
    for (const h of handlers[evt] ?? []) out = await h(payload, opts.ctx ?? {});
    return out;
  };
  const reset = () => fire("before_agent_start", { systemPrompt: "BASE" });
  return { tool, fire, reset };
}

let passed = 0, failed = 0;
const failures = [];
async function withCase(name, fn) {
  const dir = mkdtempSync(join(tmpdir(), "dg-test-"));
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

// ── checkpoint 工具 ──────────────────────────────────────────
await withCase("T1 注册:名称/双模式/参数表", async () => {
  const { tool } = load();
  assert.equal(tool.name, "checkpoint");
  const props = tool.parameters.properties;
  assert.deepEqual(props.kind.enum, ["status", "review"]);
  assert.ok(props.status.type === "string", "status 参数存在");
  assert.ok(props.reflect, "reflect 参数存在");
  assert.ok(props.adjust, "adjust 参数存在");
});

await withCase("T2 首调自动建标准骨架", async () => {
  const { tool, reset } = load();
  await reset();
  await tool.execute("id1", { kind: "status", status: "正在排查" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("## Goal"), "应有 Goal 节");
  assert.ok(doc.includes("(待补充)"), "空 Goal 应留占位");
  assert.ok(doc.includes("- 正在排查"), "Now 应含汇报内容");
});

await withCase("T3 status 覆盖 Now,Goal 保留", async () => {
  const { tool, reset } = load();
  await reset();
  writeFileSync("PROGRESS.md", "# 修 bug\n\n## Goal\n保持目标 G1\n\n## Now\n- 旧状态\n");
  await tool.execute("id2", { kind: "status", status: "新状态 S" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("保持目标 G1"), "Goal 应穿越保留");
  assert.ok(doc.includes("- 新状态 S"), "Now 应更新");
  assert.ok(!doc.includes("旧状态"), "旧 Now 应被覆盖");
});

await withCase("T4 review:Now + 回顾块(自省/调整)落盘", async () => {
  const { tool, reset } = load();
  await reset();
  await tool.execute("id3", { kind: "review", status: "S2", reflect: "自省 R", adjust: "调整 A" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(/### 回顾 #\d+/.test(doc), "应有回顾块");
  assert.ok(doc.includes("- 自省: 自省 R"), "应含自省");
  assert.ok(doc.includes("- 调整: 调整 A"), "应含调整");
  assert.ok(doc.includes("- S2"), "Now 应刷新");
});

await withCase("T5 回顾折叠:限留最近 3 段且编号连续", async () => {
  const { tool, reset } = load();
  await reset();
  for (let i = 0; i < 5; i++) {
    await tool.execute("id", { kind: "review", status: `S${i}`, reflect: `R${i}`, adjust: `A${i}` });
  }
  const doc = readFileSync("PROGRESS.md", "utf8");
  const nums = [...doc.matchAll(/^### 回顾 #(\d+)/gm)].map((m) => Number(m[1]));
  assert.equal(nums.length, 3, `应只保留 3 段,实际 ${nums.length}`);
  assert.deepEqual(nums, [nums[0], nums[0] - 1, nums[0] - 2], "最新在最前且编号连续");
});

await withCase("T6 review 缺 reflect/adjust → 宽容占位", async () => {
  const { tool, reset } = load();
  await reset();
  await tool.execute("id4", { kind: "review", status: "只有现状" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("- 自省: -"), "缺省应占位");
});

// ── 节拍器 ───────────────────────────────────────────────────
async function seedDoc() {
  writeFileSync("PROGRESS.md", "# 任务\n## Goal\nG\n## Now\n- 进行中\n");
}

await withCase("T7 第 10 轮轻检查:同轮去重 + 消费后不顺延 + 追加不替换", async () => {
  const { fire, reset } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 10; i++) await fire("turn_end");
  const first = await fire("tool_result", { isError: false, content: [{ type: "text", text: "工具真实输出" }] });
  assert.equal(first.content[0].text, "工具真实输出", "原工具输出必须保留");
  assert.ok(first.content[1].text.includes('kind="status"'), "提示追加在其后");
  const second = await fire("tool_result", { isError: false });
  assert.equal(second, undefined, "同轮去重");
  await fire("turn_end");
  const third = await fire("tool_result", { isError: false });
  assert.equal(third, undefined, "提示已消费时钟,下一轮不应立即再响");
});

await withCase("T8 第 20 轮 review 优先于 status", async () => {
  const { fire, reset } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 20; i++) await fire("turn_end");
  const r = await fire("tool_result", { isError: false, content: [{ type: "text", text: "OUT" }] });
  assert.ok(r.content[0].text === "OUT", "原输出保留");
  assert.ok(r.content[1].text.includes('kind="review"'), "20 轮应为深度回顾");
});

await withCase("T9 无文档 15 次提醒:仅一次且 10/20 节拍不生效", async () => {
  const { fire, reset } = load();
  await reset();
  for (let i = 0; i < 14; i++) await fire("tool_result", { isError: false });
  const before = await fire("tool_result", { isError: false });
  assert.ok(before.content[0].text.includes("PROGRESS.md"), "第 15 次应提醒建文档");
  const after = await fire("tool_result", { isError: false });
  assert.equal(after, undefined, "只提醒一次");
});

await withCase("T10 checkpoint 复位时钟:回顾后不重复提示", async () => {
  const { tool, fire, reset } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 10; i++) await fire("turn_end");
  await fire("tool_result", { isError: false });            // 消费 status 窗口
  await tool.execute("id", { kind: "status", status: "汇报" }); // 时钟复位
  await fire("turn_end");
  const r = await fire("tool_result", { isError: false });
  assert.equal(r, undefined, "复位后不应立即再提示");
});

await withCase("T11 失败结果:不计数、不提示", async () => {
  const { fire, reset } = load();
  await reset();
  await seedDoc();
  const r = await fire("tool_result", { isError: true });
  assert.equal(r, undefined, "失败结果静默");
});

// ── 转向确认 ─────────────────────────────────────────────────
await withCase("T12 转向全链:武装→送达→消费一次性", async () => {
  const { fire, reset } = load();
  await reset();
  await seedDoc();
  await fire("message_start", { message: { role: "user" } });   // 首条=提问本人
  await fire("tool_result", { isError: false });
  await fire("input", { streamingBehavior: "steer" });           // 武装
  await fire("message_start", { message: { role: "user" } });   // 送达
  const r = await fire("tool_result", { isError: false, content: [{ type: "text", text: "OUT" }] });
  assert.ok(r.content[0].text === "OUT", "原输出保留");
  assert.ok(r.content[1].text.includes("转向提示"), "应搭转向提示");
  assert.ok(r.content[1].text.includes("细化或补充"), "文案应中性(覆盖细化场景)");
  const again = await fire("tool_result", { isError: false });
  assert.equal(again, undefined, "一次性消费");
});

await withCase("T13 首条 user 消息不误触", async () => {
  const { fire, reset } = load();
  await reset();
  await seedDoc();
  await fire("message_start", { message: { role: "user" } });
  const r = await fire("tool_result", { isError: false });
  assert.equal(r, undefined, "首条提问不触发转向提示");
});

await withCase("T14 followUp 不武装", async () => {
  const { fire, reset } = load();
  await reset();
  await seedDoc();
  await fire("input", { streamingBehavior: "followUp" });
  await fire("message_start", { message: { role: "user" } });
  const r = await fire("tool_result", { isError: false });
  assert.equal(r, undefined, "追加任务不触发转向确认");
});

// ── 开关 ─────────────────────────────────────────────────────
await withCase("T15 PI_DRIFT_GUARD=off → 全静默", async () => {
  const { tool, fire, reset } = load(true);
  await reset();
  await seedDoc();
  for (let i = 0; i < 10; i++) await fire("turn_end");
  const r = await fire("tool_result", { isError: false });
  assert.equal(r, undefined, "节拍静默");
  const ex = await tool.execute("id", { kind: "status", status: "s" });
  assert.ok(ex.content[0].text.includes("已停用"), "execute 应声明停用");
});

// ── 审查发现的缺口 ───────────────────────────────────────────
await withCase("T16 off 时无文档路径也静默(建档提醒不发出)", async () => {
  const { fire } = load(true);
  for (let i = 0; i < 20; i++) await fire("tool_result", { isError: false });
  const r = await fire("tool_result", { isError: false });
  assert.equal(r, undefined, "off 时 toolCalls 不计数,15 次阈值不触发");
});

await withCase("T17 Goal 标题行带尾随空格:不丢 Goal、不破坏性覆写", async () => {
  const { tool, reset } = load();
  await reset();
  writeFileSync("PROGRESS.md", "# 修 bug \n## Goal \n保持目标 G9\n## Now\n- 旧\n");
  await tool.execute("id", { kind: "status", status: "新" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("保持目标 G9"), "Goal 应穿越(尾随空格不至覆写)");
});

await withCase("T18 自省文本内联 '### 回顾' 不产生幻影块", async () => {
  const { tool, reset } = load();
  await reset();
  await tool.execute("id", { kind: "review", status: "S", reflect: "参照 ### 回顾 #99 的结论", adjust: "A" });
  await tool.execute("id", { kind: "status", status: "S2" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  const nums = [...doc.matchAll(/^### 回顾 #(\d+)/gm)].map((m) => Number(m[1]));
  assert.ok(!nums.includes(99), "内联字样不得成为切块边界");
  assert.equal(nums.length, 1, "真实回顾块仍在且仅一块");
});

await withCase("T19 文件存在但读失败:中止落盘,不覆写", async () => {
  const { tool, reset } = load();
  await reset();
  rmSync("PROGRESS.md", { force: true });
  mkdirSync("PROGRESS.md"); // 目录:existsSync=true 但 readFileSync 抛 EISDIR
  await assert.rejects(() => tool.execute("id", { kind: "status", status: "X" }),
    /读取失败|中止/, "应抛错而非覆写");
  assert.ok(statSync("PROGRESS.md").isDirectory(), "原路径未被破坏");
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log(failures.map(f => "  - " + f).join("\n"));
  process.exit(1);
}
rmSync(RUN, { recursive: true, force: true });
