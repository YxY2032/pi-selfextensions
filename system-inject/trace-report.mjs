// 会话分析器:把一次 pi 会话里防漂移系统的全部行为证据整理成一条时间线。
// 用法:
//   node trace-report.mjs [会话.jsonl | 会话目录] [--trace 探针trace.jsonl]
// 不给参数时取 ~/.pi/agent/sessions 下最新一份 .jsonl(递归找)。
// 探针日志由 trace-probe.ts 产生(见 VERIFY.md),--trace 合并后能看到
// 模型每次请求真实收到的 system prompt 标记(会话 JSONL 只记 sections 形态,
// 看不到 forced-prompt projection 的结果,锚/preamble 只在探针里可见)。
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const traceIdx = args.indexOf("--trace");
const traceFile = traceIdx >= 0 ? args.splice(traceIdx, 2)[1] : undefined;
const target = args[0];

// ── 定位会话文件 ─────────────────────────────────────────────
function newestSession(root) {
  let newest = null;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".jsonl") && (!newest || st.mtimeMs > newest.mtimeMs)) newest = { path: p, mtimeMs: st.mtimeMs };
    }
  };
  walk(root);
  return newest?.path;
}

const sessionFile = !target
  ? newestSession(join(homedir(), ".pi", "agent", "sessions"))
  : statSync(target).isDirectory()
    ? newestSession(target)
    : target;
if (!sessionFile || !existsSync(sessionFile)) {
  console.error("找不到会话文件(可显式传路径)");
  process.exit(1);
}

const entries = readFileSync(sessionFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// ── 汇总统计 ─────────────────────────────────────────────────
const sysEntries = [];
const runs = [];
const checkpoints = [];
const hints = [];
const toolCounts = {};
let assistantTurns = 0;

const HINT_PREFIXES = ["[检查点", "[回顾点", "[系统观察]", "[转向提示]"];

for (const e of entries) {
  if (e.type !== "message") continue;
  const m = e.message;
  if (m.role === "system") {
    const text = Object.values(m.sections ?? {}).join("\n");
    sysEntries.push({
      ts: e.timestamp,
      keys: Object.keys(m.sections ?? {}),
      anchor: text.includes("## 任务导航"),
      plan_state: text.includes("<plan_state>"),
    });
  } else if (m.role === "user") {
    const text = (m.content ?? []).map((c) => c.text ?? "").join(" ");
    runs.push({ ts: e.timestamp, head: text.slice(0, 50).replace(/\n/g, " ") });
  } else if (m.role === "assistant") {
    assistantTurns++;
    for (const c of m.content ?? []) {
      if (c.type === "toolCall" && c.name === "checkpoint") {
        checkpoints.push({
          ts: e.timestamp,
          turn: assistantTurns,
          kind: c.arguments?.kind,
          status: String(c.arguments?.status ?? "").slice(0, 60).replace(/\n/g, " "),
        });
      }
    }
  } else if (m.role === "toolResult") {
    toolCounts[m.toolName] = (toolCounts[m.toolName] ?? 0) + 1;
    for (const c of m.content ?? []) {
      const hit = HINT_PREFIXES.find((p) => typeof c.text === "string" && c.text.includes(p));
      if (hit) hints.push({ ts: e.timestamp, tool: m.toolName, kind: hit });
    }
  }
}

// ── 输出 ─────────────────────────────────────────────────────
console.log(`会话: ${sessionFile}`);
console.log(`条目: ${entries.length} | 用户提问 ${runs.length} 次 | assistant 轮 ${assistantTurns}`);
console.log(`\n[system 条目] (会话侧 sections 形态;模型实收以 --trace 为准)`);
for (const s of sysEntries) {
  console.log(`  ${s.ts} 节:${s.keys.join(",") || "(无)"} | 会话侧锚=${s.anchor} plan_state=${s.plan_state}`);
}
if (!sysEntries.length) console.log("  (无)");

console.log(`\n[checkpoint 调用] 共 ${checkpoints.length} 次`);
for (const c of checkpoints) console.log(`  ${c.ts} 第${c.turn}轮 kind=${c.kind} | ${c.status}`);

console.log(`\n[节拍/转向提示送达] 共 ${hints.length} 次`);
for (const h of hints) console.log(`  ${h.ts} ${h.kind} (附于 ${h.tool} 结果)`);

const top = Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log(`\n[工具调用 Top] ${top.map(([n, c]) => `${n}=${c}`).join("  ")}`);

console.log(`\n[提问时间线]`);
for (const r of runs) console.log(`  ${r.ts} ${r.head}`);

// ── 探针日志合并 ────────────────────────────────────────────
if (traceFile) {
  if (!existsSync(traceFile)) {
    console.error(`\n探针日志不存在: ${traceFile}`);
    process.exit(1);
  }
  const trace = readFileSync(traceFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  console.log(`\n===== 探针(${traceFile})=====`);
  for (const t of trace) {
    if (t.type === "request" && t.markers) {
      const mk = Object.entries(t.markers).filter(([, v]) => v).map(([k]) => k).join(",");
      console.log(`  请求#${t.seq} ${t.t} sysLen=${t.sysLen} hash=${t.sysHash} msgCount=${t.msgCount} 命中:${mk || "(无)"}`);
      if (Array.isArray(t.tools)) console.log(`        工具声明(${t.tools.length}): ${t.tools.join(",")}`);
    } else if (t.type === "input") {
      console.log(`  输入 ${t.t} behavior=${t.behavior} | ${t.textHead}`);
    } else if (t.type === "run") {
      console.log(`  ── 新提问 ${t.t} "${t.promptHead}"`);
    }
  }
  const reqs = trace.filter((t) => t.type === "request" && t.markers);
  const any = (k) => reqs.some((r) => r.markers[k]);
  console.log(`\n  判定: 锚到达=${any("anchor")} preamble到达=${any("preamble")} plan_state到达=${any("plan_state")} Now泄漏=${any("nowLeak")}`);
} else {
  console.log(`\n(未给 --trace:锚/preamble 经 projection 注入,不出现在会话文件,需探针日志才能判定"模型实收")`);
}
