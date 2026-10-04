// drift-guard A/B 行为基准
// 运行:node bench-drift.mjs   (需要 pi 可用且已配置模型;共 5 次 pi 调用)
// 判定全部基于可观测行为(回答标记/文件状态),无主观评分。
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
function record(id, desc, pass, evidence) {
  results.push({ id, desc, pass, evidence });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${desc}\n      ${evidence}`);
}

function pi(args, cwd, envOff = false) {
  const env = { ...process.env };
  if (envOff) env.PI_DRIFT_GUARD = "off";
  return execFileSync("pi", args, { cwd, env, encoding: "utf8", timeout: 240000 }).toString();
}

// ── B1: 锚遵循度(因果 A/B:开 vs 关)────────────────────────────
// 任务本身两种条件都知道(统计 docs/ 的 .md 文件);
// 但"完成标准:回答以 NAVOK-<数字> 结尾"只写在 PROGRESS.md 的 Goal 里。
// 开 → 回答应含 NAVOK-2;关 → 大概率不含(证明遵循来自锚)。
{
  const dir = mkdtempSync(join(tmpdir(), "dg-b1-"));
  join(dir, "docs") && (await import("node:fs")).mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.md"), "a");
  writeFileSync(join(dir, "docs", "b.md"), "b");
  writeFileSync(join(dir, "PROGRESS.md"),
    "# 文档统计\n## Goal\n统计 docs/ 目录下有多少个 .md 文件。\n完成标准:最终回答必须以单独一行 NAVOK-<数字> 结尾。\n## Now\n尚未开始\n");
  const out = pi(["-p", "统计 docs 目录下有多少个 .md 文件"], dir);
  const pass = /NAVOK-2\b/.test(out);
  record("B1-on", "锚遵循:回答含 NAVOK-2", pass, out.trim().split("\n").slice(-3).join(" | "));
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mkdtempSync(join(tmpdir(), "dg-b1off-"));
  (await import("node:fs")).mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "a.md"), "a");
  writeFileSync(join(dir, "docs", "b.md"), "b");
  writeFileSync(join(dir, "PROGRESS.md"),
    "# 文档统计\n## Goal\n统计 docs/ 目录下有多少个 .md 文件。\n完成标准:最终回答必须以单独一行 NAVOK-<数字> 结尾。\n## Now\n尚未开始\n");
  const out = pi(["-p", "统计 docs 目录下有多少个 .md 文件"], dir, true);
  const leaked = /NAVOK-2\b/.test(out);
  record("B1-off", "关闭后 NAVOK 标记消失(因果对照)", !leaked,
    leaked ? "意外:关闭后仍出现标记,对照失效" : out.trim().split("\n").slice(-2).join(" | "));
  rmSync(dir, { recursive: true, force: true });
}

// ── B2: 简单任务零干预 ─────────────────────────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "dg-b2-"));
  const out = pi(["-p", "1+1 等于几?只回答数字"], dir);
  const answered = out.trim().includes("2");
  const noDoc = !existsSync(join(dir, "PROGRESS.md"));
  record("B2", "简单任务:正确回答且零干预(无文档被创建)", answered && noDoc,
    `回答=${out.trim().slice(0, 40)} | 文档创建=${!noDoc}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── B3: 任务切换(同一会话 -c,两段运行)───────────────────────
{
  const dir = mkdtempSync(join(tmpdir(), "dg-b3-"));
  (await import("node:fs")).mkdirSync(join(dir, "docs"));
  (await import("node:fs")).mkdirSync(join(dir, "scripts"));
  writeFileSync(join(dir, "docs", "a.md"), "a");
  writeFileSync(join(dir, "scripts", "x.sh"), "x");
  writeFileSync(join(dir, "scripts", "y.sh"), "y");
  writeFileSync(join(dir, "scripts", "z.sh"), "z");
  writeFileSync(join(dir, "PROGRESS.md"),
    "# 文档统计\n## Goal\n统计 docs/ 目录下有多少个 .md 文件。\n## Now\n尚未开始\n");
  pi(["-p", "统计 docs 目录下有多少个 .md 文件"], dir);
  const out2 = pi(["-c", "-p", "方向变了:改为统计 scripts 目录下有多少个 .sh 文件"], dir);
  const nav = readFileSync(join(dir, "PROGRESS.md"), "utf8");
  const goalUpdated = /\.sh|scripts/.test(nav.split("## Now")[0] || "");
  const answered = out2.trim().includes("3");
  record("B3", "任务切换:Goal 已覆盖为 .sh 且回答正确", goalUpdated && answered,
    `Goal更新=${goalUpdated} | 回答含3=${answered}`);
  rmSync(dir, { recursive: true, force: true });
}

// ── 汇总 ───────────────────────────────────────────────────────
console.log("\n===== 基准汇总 =====");
for (const r of results) console.log(`${r.pass ? "✅" : "❌"} ${r.id}  ${r.desc}`);
const allPass = results.every((r) => r.pass);
console.log(allPass ? "\n全部通过" : "\n存在失败项");
process.exit(allPass ? 0 : 1);
