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
function load(envOff = false, channel) {
  if (envOff) process.env.PI_DRIFT_GUARD = "off";
  else delete process.env.PI_DRIFT_GUARD;
  if (channel) process.env.PI_DRIFT_HINT_CHANNEL = channel;
  else delete process.env.PI_DRIFT_HINT_CHANNEL;
  const handlers = {};
  const sent = []; // 捕获 sendMessage(消息通道的提示)
  let tool = null;
  mod.default({
    on: (e, h) => { (handlers[e] ??= []).push(h); },
    registerTool: (t) => { tool = t; },
    sendMessage: (message, options) => { sent.push({ message, options }); },
  });
  const fire = async (evt, payload = {}, opts = {}) => {
    let out;
    for (const h of handlers[evt] ?? []) out = await h(payload, opts.ctx ?? {});
    return out;
  };
  const reset = () => fire("before_agent_start", { systemPrompt: "BASE" });
  return { tool, fire, reset, sent };
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

await withCase("T7 第 50 轮轻检查:消息通道投递 + 同轮去重 + 消费后不顺延 + 三要素", async () => {
  const { fire, reset, sent } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 50; i++) await fire("turn_end");
  const first = await fire("tool_result", { isError: false, content: [{ type: "text", text: "工具真实输出" }] });
  assert.equal(first, undefined, "消息通道下工具结果保持原样(无尾巴)");
  assert.equal(sent.length, 1, "提示经轮边界消息送出");
  assert.equal(sent[0].message.customType, "drift-guard-hint", "customType 自证身份");
  assert.equal(sent[0].options.triggerTurn, true, "轮边界投递(triggerTurn)");
  const hint = sent[0].message.content[0].text;
  assert.ok(hint.includes("[导航状态]"), "应为导航状态提示");
  assert.ok(hint.includes("已 50 轮未更新"), "数字事实(节拍首次到期,事实基准仍为 0)");
  assert.ok(hint.includes("(50 轮前)"), "Now 引用应标注轮距作对照锚");
  assert.ok(hint.includes("进行中"), "应引用 Now 对照物");
  assert.ok(hint.includes(':"G"') && hint.includes("Goal"), "应引用 Goal 对照物");
  assert.ok(hint.includes("压缩后可能丢失"), "应含后果事实");
  assert.ok(hint.includes("先 read PROGRESS.md") && hint.includes("回顾此前的进展与现状"), "先读=回顾任务进展,再更新(非为记而记)");
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 1, "同轮去重");
  await fire("turn_end");
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 1, "提示已消费节拍时钟,下一轮不应立即再响");
});

await withCase("T8 第 100 轮 review 优先于 status", async () => {
  const { fire, reset, sent } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 100; i++) await fire("turn_end");
  const r = await fire("tool_result", { isError: false, content: [{ type: "text", text: "OUT" }] });
  assert.equal(r, undefined, "消息通道,无尾巴");
  const hint = sent[0].message.content[0].text;
  assert.ok(hint.includes("[回顾状态]"), "100 轮应为深度回顾");
  assert.ok(hint.includes("未深度回顾"), "应含回顾陈旧事实");
  assert.ok(hint.includes("先 read PROGRESS.md") && hint.includes("回顾此前"), "review 同样先回顾再检视");
  assert.ok(hint.includes("通向 Goal"), "回顾仍指向方向问题");
});

await withCase("T9 无文档 15 次提醒:消息通道 + 位置写死 + 仅一次", async () => {
  const { fire, reset, sent } = load();
  await reset();
  for (let i = 0; i < 14; i++) await fire("tool_result", { isError: false });
  const before = await fire("tool_result", { isError: false });
  assert.equal(before, undefined, "消息通道下工具结果保持原样");
  assert.equal(sent.length, 1, "建档提醒经消息通道送出");
  const hint = sent[0].message.content[0].text;
  assert.ok(hint.includes("没有 PROGRESS.md"), "分类器锚词在(trace-report 按此识别建档提示,改文案须两处同步)");
  assert.ok(hint.includes("工作目录根") && hint.includes(process.cwd()), "位置写死(含绝对路径,ADR-0005)");
  assert.ok(hint.includes("只从运行目录读取"), "读取位置声明在");
  const after = await fire("tool_result", { isError: false });
  assert.equal(after, undefined, "只提醒一次");
  assert.equal(sent.length, 1, "不重发(红线:仅一次)");
});

await withCase("T10 checkpoint 复位时钟:回顾后不重复提示", async () => {
  const { tool, fire, reset } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 50; i++) await fire("turn_end");
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
await withCase("T12 转向全链:武装→送达→消费一次性(带 Goal 对照)", async () => {
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
  assert.ok(r.content[1].text.includes("细化"), "文案应含细化分支");
  assert.ok(r.content[1].text.includes(':"G"'), "应引用当前 Goal 作对照");
  assert.ok(r.content[1].text.includes("判断在你"), "判断权声明应在");
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
  const { tool, fire, reset, sent } = load(true);
  await reset();
  await seedDoc();
  for (let i = 0; i < 50; i++) await fire("turn_end");
  const r = await fire("tool_result", { isError: false });
  assert.equal(r, undefined, "节拍静默");
  assert.equal(sent.length, 0, "不发消息");
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

// —— ADR-0002:事实化提示家族 ─────────────────────────────────
await withCase("T20 哲学红线:全部提示文案零祈使句", async () => {
  const IMPERATIVE = /建议|请|必须|应该|务必/;
  const texts = [];
  { // status(消息通道)
    const { fire, reset, sent } = load();
    await reset(); await seedDoc();
    for (let i = 0; i < 50; i++) await fire("turn_end");
    await fire("tool_result", { isError: false });
    texts.push(sent[0].message.content[0].text);
  }
  { // review(消息通道)
    const { fire, reset, sent } = load();
    await reset(); await seedDoc();
    for (let i = 0; i < 100; i++) await fire("turn_end");
    await fire("tool_result", { isError: false });
    texts.push(sent[0].message.content[0].text);
  }
  { // doc(消息通道,ADR-0005;须清掉前面块种的文件,否则走不到建档分支)
    const { fire, reset, sent } = load();
    await reset();
    rmSync("PROGRESS.md", { force: true });
    for (let i = 0; i < 14; i++) await fire("tool_result", { isError: false });
    await fire("tool_result", { isError: false });
    texts.push(sent[0].message.content[0].text);
  }
  { // 空文档回顾事实(ADR-0005,亦入红线族)
    const { fire, reset, sent } = load();
    await reset();
    rmSync("PROGRESS.md", { force: true });
    for (let i = 0; i < 14; i++) await fire("tool_result", { isError: false });
    await fire("tool_result", { isError: false });
    for (let i = 0; i < 100; i++) await fire("turn_end");
    await fire("tool_result", { isError: false });
    texts.push(sent[1].message.content[0].text);
  }
  { // steer
    const { fire, reset } = load();
    await reset(); await seedDoc();
    await fire("message_start", { message: { role: "user" } });
    await fire("input", { streamingBehavior: "steer" });
    await fire("message_start", { message: { role: "user" } });
    texts.push((await fire("tool_result", { isError: false })).content[0].text);
  }
  assert.equal(texts.length, 5);
  for (const t of texts) {
    assert.ok(!IMPERATIVE.test(t), `提示含祈使标记: ${t}`);
  }
});

await withCase("T21 直接 write 重置陈旧事实:数字反映真实文件更新", async () => {
  const { fire, reset, sent } = load();
  await reset();
  await seedDoc();
  for (let i = 0; i < 25; i++) await fire("turn_end");
  await fire("tool_result", { isError: false, toolName: "write", input: { path: "PROGRESS.md", content: "..." } }); // 第25轮直接写
  for (let i = 0; i < 25; i++) await fire("turn_end"); // 至第50轮(status 到期,review 未到)
  await fire("tool_result", { isError: false, content: [{ type: "text", text: "O" }] });
  const hint = sent[0].message.content[0].text;
  assert.ok(hint.includes("已 25 轮未更新"), `应以直接写入轮为基准(50-25),实际: ${hint}`);
  assert.ok(!hint.includes("已 50 轮"), "不得以会话起点为事实基准");
});

await withCase("T22 读失败降级:纯数字事实,不引用对照物", async () => {
  const { fire, reset, sent } = load();
  await reset();
  mkdirSync("PROGRESS.md"); // EISDIR
  for (let i = 0; i < 50; i++) await fire("turn_end");
  await fire("tool_result", { isError: false, content: [{ type: "text", text: "O" }] });
  const hint = sent[0].message.content[0].text;
  assert.ok(hint.includes("[导航状态]") && hint.includes("读取失败"), "应声明读取失败");
  assert.ok(!hint.includes("上条 Now"), "不得伪造对照物");
});

await withCase("T23 review 对照物:引用最近回顾的自省", async () => {
  const { tool, fire, reset, sent } = load();
  await reset();
  await seedDoc();
  await tool.execute("id", { kind: "review", status: "S", reflect: "方向正确继续深入", adjust: "A" });
  for (let i = 0; i < 100; i++) await fire("turn_end");
  await fire("tool_result", { isError: false, content: [{ type: "text", text: "O" }] });
  const hint = sent[0].message.content[0].text;
  assert.ok(/最近回顾 #\d+/.test(hint), "应引用最近回顾编号(任务级连续)");
  assert.ok(hint.includes("(100 轮前)"), "回顾引用应标注轮距");
  assert.ok(hint.includes("方向正确继续深入"), "应引用自省内容");
  assert.ok(hint.includes("已 100 轮未深度回顾"), "回顾陈旧事实以实际回顾轮为基准");
});

await withCase("T24 转向提示无文档时降级:保留事件事实,无 Goal 引用", async () => {
  const { fire, reset } = load();
  await reset();
  await fire("message_start", { message: { role: "user" } });
  await fire("tool_result", { isError: false });
  await fire("input", { streamingBehavior: "steer" });
  await fire("message_start", { message: { role: "user" } });
  const r = await fire("tool_result", { isError: false, content: [{ type: "text", text: "O" }] });
  const hint = r.content[1].text;
  assert.ok(hint.includes("转向提示") && hint.includes("有新的用户输入"), "事件事实保留");
  assert.ok(!hint.includes("Goal"), "无文档时不得引用 Goal");
});

// —— ADR-0003:三区制(受管节/保留区/回顾) ─────────────────────
await withCase("T25 自定义节保留与归位(不再被重建删除)", async () => {
  const { tool, reset } = load();
  await reset();
  writeFileSync("PROGRESS.md", [
    "# 任务", "", "## Goal", "G", "",
    "## 已完成题目", "| 题 | 分 |", "|---|---|", "| c-06 | 100 |", "",
    "## Now", "- 旧状态", "",
    "## 关键经验", "HugeGraph 用 Unsafe 改线程名绕沙箱", "",
  ].join("\n"));
  await tool.execute("id", { kind: "status", status: "新状态" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("## 已完成题目") && doc.includes("| c-06 | 100 |"), "自定义表格必须原样保留");
  assert.ok(doc.includes("## 关键经验") && doc.includes("Unsafe 改线程名"), "自定义经验节必须保留");
  assert.ok(doc.includes("- 新状态") && !doc.includes("旧状态"), "Now 照常替换");
  const iNow = doc.indexOf("## Now"), iNext = doc.indexOf("## 下一步"), iCustom = doc.indexOf("## 已完成题目");
  assert.ok(iCustom > iNext && iNext > iNow, "顺序:Now → 下一步 → 自定义节(归位)");
});

await withCase("T26 改名容错:Now (最终) 视为本体,Now备忘 视为保留区", async () => {
  const { tool, reset } = load();
  await reset();
  writeFileSync("PROGRESS.md", "# t\n\n## Goal\nG\n\n## Now (最终)\n- 旧\n\n## Now备忘\n- 这不是 Now\n");
  await tool.execute("id", { kind: "status", status: "新" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.equal(doc.match(/^## Now(\s|$|（|\()/gm).length, 1, "只允许一个受管 Now 节(无双胞胎)");
  assert.ok(doc.includes("- 新") && !doc.includes("- 旧"), "改名 Now 被当作本体替换");
  assert.ok(doc.includes("## Now备忘") && doc.includes("这不是 Now"), "连续命名视为保留区");
});

await withCase("T27 results/next 参数:提供则替换,缺省保留原节", async () => {
  const { tool, reset } = load();
  await reset();
  writeFileSync("PROGRESS.md", "# t\n\n## Goal\nG\n\n## Now\n- a\n\n## 成果\n旧成果\n\n## 下一步\n旧计划\n");
  await tool.execute("id", { kind: "status", status: "S" }); // 不带 results/next
  let doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("旧成果") && doc.includes("旧计划"), "未提供参数时两节原样保留");
  await tool.execute("id", { kind: "status", status: "S2", results: "19 题 4750 分", next: "a-14 → a-17" });
  doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("19 题 4750 分") && !doc.includes("旧成果"), "results 整节替换");
  assert.ok(doc.includes("a-14 → a-17") && !doc.includes("旧计划"), "next 整节替换");
});

await withCase("T28 首建骨架含成果/下一步占位提示", async () => {
  const { tool, reset } = load();
  await reset();
  await tool.execute("id", { kind: "status", status: "起步" });
  const doc = readFileSync("PROGRESS.md", "utf8");
  assert.ok(doc.includes("## 成果") && doc.includes("可核对的事实"), "成果节占位提示在");
  assert.ok(doc.includes("## 下一步") && doc.includes("按优先级"), "下一步节占位提示在");
});

await withCase("T29 PI_DRIFT_HINT_CHANNEL=tail → 旧通道对照可用", async () => {
  const { fire, reset, sent } = load(false, "tail");
  await reset();
  await seedDoc();
  for (let i = 0; i < 50; i++) await fire("turn_end");
  const r = await fire("tool_result", { isError: false, content: [{ type: "text", text: "O" }] });
  assert.ok(r.content[0].text === "O" && r.content[1].text.includes("[导航状态]"), "旧尾巴通道照常");
  assert.equal(sent.length, 0, "不走消息通道");
});

await withCase("T30 空文档回顾事实:百轮一条非重发,建档即止,窗口中段静默", async () => {
  const { fire, reset, sent } = load();
  await reset();
  for (let i = 0; i < 14; i++) await fire("tool_result", { isError: false });
  await fire("tool_result", { isError: false });            // 建档提醒(docReminded=true)
  for (let i = 0; i < 100; i++) await fire("turn_end");      // 至第 100 轮
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 2, "回顾节点应送出空文档事实(非重发建档提醒)");
  const fact = sent[1].message.content[0].text;
  assert.ok(fact.includes("[回顾状态]") && fact.includes("仍未建立"), "应是回顾形态的空文档事实");
  assert.ok(!fact.includes("已 15 次工具调用"), "不是旧提醒的复读");
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 2, "同轮去重");
  for (let i = 0; i < 100; i++) await fire("turn_end");      // 又 100 轮
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 3, "再到期再一条(每 100 轮最多一条)");
  for (let i = 0; i < 50; i++) await fire("turn_end");       // 窗口中段(第 250 轮)
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 3, "窗口中段静默(未到期不响)");
  await seedDoc();                                           // 建档(ADR-0005:建档即止)
  for (let i = 0; i < 100; i++) await fire("turn_end");
  await fire("tool_result", { isError: false });
  assert.equal(sent.length, 4, "建档后节拍接管");
  assert.ok(!sent[3].message.content[0].text.includes("仍未建立"), "不再出现空文档事实");
  assert.ok(sent[3].message.content[0].text.includes("[回顾状态]") && sent[3].message.content[0].text.includes("未深度回顾"),
    "350 轮两钟皆到期,review 优先——钉死优先级(二轮审查:原'二者之一'使 status 分支永不可达)");
});

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed > 0) {
  console.log(failures.map(f => "  - " + f).join("\n"));
  process.exit(1);
}
rmSync(RUN, { recursive: true, force: true });
