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
const compliance = args.includes("--compliance");
const navFlag = args.includes("--nav");
const target = args.filter((a) => a !== "--compliance" && a !== "--nav")[0];

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
const navUpdates = [];
const toolCounts = {};
let assistantTurns = 0;

// 新前缀(ADR-0002)+ 旧前缀(向后兼容,便于对历史会话复算基线)
const HINT_PREFIXES = ["[导航状态", "[回顾状态", "[转向提示]", "[检查点", "[回顾点", "[系统观察]"];
const COMPLIANCE_WINDOW = 25; // 遵从窗口:提示后 N 轮内发生导航更新(ADR-0002 判据)

function hintKind(text) {
  // 顺序敏感:空文档事实复用 [回顾状态] 前缀,须先判;新旧建档文案兼容(ADR-0005)
  if (text.includes("仍未建立")) return "empty";
  if (text.includes("[回顾状态") || text.includes("[回顾点")) return "review";
  if (text.includes("[转向提示]")) return "steer";
  if (text.includes("无导航文件") || text.includes("没有 PROGRESS.md")) return "doc";
  return "status"; // [导航状态] / [检查点] / [系统观察]
}

for (const e of entries) {
  // 消息通道的提示(ADR-0004:custom_message 条目,不在工具结果里)——须在 message 守卫前处理
  if (e.type === "custom_message" && e.customType === "drift-guard-hint") {
    const text = (e.content ?? []).map((c) => c.text ?? "").join(" ");
    hints.push({ ts: e.timestamp, turn: assistantTurns, tool: "(轮边界消息)", kind: hintKind(text), via: "message" });
    continue;
  }
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
        let text = `Now ← "${String(c.arguments?.status ?? "")}"`;
        if (c.arguments?.kind === "review") {
          text += `;回顾块 ← 自省:"${c.arguments?.reflect ?? ""}" 调整:"${c.arguments?.adjust ?? ""}"`;
        }
        navUpdates.push({ ts: e.timestamp, turn: assistantTurns, via: "checkpoint", text });
      }
      if (c.type === "toolCall" && (c.name === "write" || c.name === "edit")) {
        if (JSON.stringify(c.arguments ?? {}).includes("PROGRESS.md")) {
          const a = c.arguments ?? {};
          const text = c.name === "write"
            ? `全文写入:\n${String(a.content ?? a.file_text ?? JSON.stringify(a))}`
            : `编辑:"${String(a.old_string ?? "")}" → "${String(a.new_string ?? "")}"`;
          navUpdates.push({ ts: e.timestamp, turn: assistantTurns, via: c.name, text });
        }
      }
    }
  } else if (m.role === "toolResult") {
    toolCounts[m.toolName] = (toolCounts[m.toolName] ?? 0) + 1;
    for (const c of m.content ?? []) {
      const hit = HINT_PREFIXES.find((p) => typeof c.text === "string" && c.text.includes(p));
      if (hit) hints.push({ ts: e.timestamp, turn: assistantTurns, tool: m.toolName, kind: hintKind(c.text), via: "tail" });
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
for (const h of hints) console.log(`  ${h.ts} 第${h.turn}轮 [${h.kind}] ${h.via === "message" ? "(轮边界消息)" : `(附于 ${h.tool} 结果)`}`);

// ── 导航演化回放(--nav):内容质量审计 ────────────────────────
if (navFlag) {
  console.log(`\n[导航演化] 共 ${navUpdates.length} 次写入(checkpoint ${checkpoints.length} + 直接写 ${navUpdates.length - checkpoints.length})`);
  for (const u of navUpdates) {
    const text = String(u.text ?? "");
    const shown = text.length > 800 ? text.slice(0, 800) + "\n…(截断;全文在会话 JSONL 或探针快照)" : text;
    console.log(`  ── 第${u.turn}轮 [${u.via}] ${u.ts}`);
    console.log(shown.split("\n").map((l) => "     " + l).join("\n"));
  }
  console.log(`  审阅四项:①四要素覆盖(缺"下一步"?) ②可核对事实密度(路径/命令/结果) ③对上一版的增量性 ④与时间线一致性`);
}

// ── 遵从率(ADR-0002 判据;--compliance)──────────────────────
if (compliance) {
  const measured = hints.filter((h) => h.kind === "status" || h.kind === "review");
  let complied = 0;
  console.log(`\n[遵从率] 窗口=提示后 ${COMPLIANCE_WINDOW} 轮内发生导航更新(checkpoint 或直接写 PROGRESS.md)`);
  for (const h of measured) {
    const ok = navUpdates.some((u) => u.turn > h.turn && u.turn <= h.turn + COMPLIANCE_WINDOW);
    if (ok) complied++;
    console.log(`  第${h.turn}轮 [${h.kind}] → ${ok ? "遵从" : "未遵从"}`);
  }
  const rate = measured.length > 0 ? Math.round((complied / measured.length) * 100) : null;
  console.log(`  合计: ${complied}/${measured.length}${rate !== null ? ` = ${rate}%` : ""}` +
    ` | 导航更新共 ${navUpdates.length} 次(checkpoint ${checkpoints.length} + 直接写 ${navUpdates.length - checkpoints.length})` +
    ` | 建档提示 ${hints.filter((h) => h.kind === "doc").length} 次、空文档事实 ${hints.filter((h) => h.kind === "empty").length} 次、转向提示 ${hints.filter((h) => h.kind === "steer").length} 次(均不计入遵从率)`);
  console.log(`  判据(ADR-0002): ≥40% 有效 / 10%~40% 调参再测 / <10% 措辞回滚` +
    `${rate === null ? "\n  (本会话无可测提示——节拍未触发或旧前缀不匹配)" : ""}`);
}

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
  const navs = trace.filter((t) => t.type === "nav_write" && t.file);
  if (navs.length) {
    console.log(`\n  [探针导航快照·地面真值] ${navs.length} 份(哈希去重,含 bash 绕路写入),在 ${traceFile.replace(/[^/\\]+$/, "")}:`);
    for (const n of navs) console.log(`    ${n.t} ${n.file} (${n.bytes}B hash=${n.hash})`);
  }
  const any = (k) => reqs.some((r) => r.markers[k]);
  console.log(`\n  判定: 锚到达=${any("anchor")} preamble到达=${any("preamble")} plan_state到达=${any("plan_state")} Now泄漏=${any("nowLeak")}`);
} else {
  console.log(`\n(未给 --trace:锚/preamble 经 projection 注入,不出现在会话文件,需探针日志才能判定"模型实收")`);
}
