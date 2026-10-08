import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

// 防漂移·动态部件:checkpoint 工具 + 节拍器 + 转向确认。
// 与 index.ts(preamble + 锚)同包不同文件:事件钩子是多槽叠加,
// 不存在 systemPrompt 返回值的单槽覆盖问题。
// 设计与决策记录见同目录 README.md。PI_DRIFT_GUARD=off 时全部静默。

const STATE_FILE = "PROGRESS.md";
const STATUS_EVERY = 50;  // 轻检查间隔(轮)——ADR-0002:贴近实测自然维护节奏(≈140 轮/次),降噪约 78%
const REVIEW_EVERY = 100; // 深度回顾间隔(轮)
const BRIEF_AFTER = 15;   // 无文档时,工具调用达到此次数提醒建文档(仅一次)
const REVIEWS_KEPT = 3;   // 回顾史限留段数
const QUOTE_MAX = 80;     // 提示中 Now/Goal 引用截断
const REVIEW_QUOTE_MAX = 60; // 提示中回顾自省截断

const enabled = () => process.env.PI_DRIFT_GUARD !== "off";

// 提示投递通道(ADR-0004):message=轮边界独立消息(pi.sendMessage,默认)——实测以
// user 角色落在请求消息末尾,模型必读的位置;tail=旧通道(工具结果尾巴,对照实验用)。
// status/review 与建档提醒走此开关(ADR-0004/0005);转向提示维持尾巴通道(事件驱动,跟随原始 steer)。
const hintViaMessage = () => process.env.PI_DRIFT_HINT_CHANNEL !== "tail";

// —— 运行状态(before_agent_start 复位;reviewCount 为任务级,跨运行连续)
// 双时钟分离(ADR-0002):lastStatusTurn/lastReviewTurn 是节拍时钟(提示即消费,防逐轮轰炸);
// lastNavWriteTurn/lastActualReviewTurn 是陈旧事实基准——只有真实导航更新(checkpoint
// 或直接写文件)才推进,"已 X 轮未更新"的 X 由它计算,提示本身绝不重置事实。
let turnCount = 0, toolCalls = 0;
let lastStatusTurn = 0, lastReviewTurn = 0, lastNudgedTurn = -1;
let lastNavWriteTurn = 0, lastActualReviewTurn = 0;
let docReminded = false, reviewCount = 0;
let seenInitialUser = false, steerArmed = false, nudgeSteerNext = false;

function readNav(): string | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return readFileSync(STATE_FILE, "utf8").replace(/\r\n/g, "\n");
  } catch (e) {
    console.error(`[drift-guard] 读取 ${STATE_FILE} 失败: ${(e as Error).message}`);
    return null;
  }
}

function extractTitle(c: string): string {
  const m = c.match(/^#\s+(.+)$/m);
  return m ? m[1].trim() : "(任务标题)";
}

function extractGoal(c: string): string {
  const m = c.match(/## Goal[ \t]*\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() : "(待补充)";
}

function extractNow(c: string): string {
  const m = c.match(/## Now[ \t]*\n([\s\S]*?)(?=\n## |$)/);
  return m ? m[1].trim() : "";
}

// 引用裁剪:压成单行 + 截断——提示必须紧凑,变长就重新变成壁纸
function quote(text: string, max = QUOTE_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

// Goal 专用:首 60 + 尾 20——完成标准常写在 Goal 尾部,纯头部截断会砍掉衡量物
function quoteGoal(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= QUOTE_MAX) return t;
  return t.slice(0, 60) + "…" + t.slice(t.length - 20);
}

// —— 分节解析(ADR-0003:三区制——受管节/保留区/回顾)——
// 受管节:Goal/Now/成果/下一步(checkpoint 管辖);保留区:其余 ## 节原样穿越。
// 改名容错:名字后跟空格或括号的变体("Now (最终)")视为本体;"Now备忘"视为保留区。

interface NavSection {
  heading: string; // 不含 "## " 前缀
  body: string;
}

const isGoalHeading = (h: string) => /^Goal(\s|$|（|\()/.test(h);
const isNowHeading = (h: string) => /^Now(\s|$|（|\()/.test(h);
const isResultsHeading = (h: string) => /^成果(\s|$|（|\()/.test(h);
const isNextHeading = (h: string) => /^下一步(\s|$|（|\()/.test(h);

// 回顾块:行首锚定 + 强制编号(防自定义节正文里的 "### 回顾" 字样误切)
function reviewRanges(c: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const re = /^### 回顾 #\d+[^\n]*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    const rest = c.slice(m.index + 1);
    const next = rest.search(/\n(## |### 回顾 #\d+)/);
    const end = next === -1 ? c.length : m.index + 1 + next;
    ranges.push([m.index, end]);
  }
  return ranges;
}

function parseReviews(c: string): string[] {
  return reviewRanges(c).map(([s, e]) => c.slice(s, e).trim());
}

function stripReviews(c: string): string {
  let rest = c;
  for (const [s, e] of reviewRanges(c).reverse()) {
    rest = rest.slice(0, s) + rest.slice(e);
  }
  return rest;
}

function splitSections(c: string): NavSection[] {
  const out: NavSection[] = [];
  const re = /^## (.+)$/gm;
  const marks: Array<{ heading: string; start: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    marks.push({ heading: m[1].trim(), start: m.index });
  }
  for (let i = 0; i < marks.length; i++) {
    const bodyStart = c.indexOf("\n", marks[i].start) + 1;
    const bodyEnd = i + 1 < marks.length ? marks[i + 1].start : c.length;
    out.push({ heading: marks[i].heading, body: c.slice(bodyStart, bodyEnd).trim() });
  }
  return out;
}

function flatten(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function buildNow(status: string): string {
  const lines = status.trim().split("\n").map((l) => "- " + l.trim()).join("\n");
  return `## Now\n${lines}`;
}

const RESULTS_PLACEHOLDER = "(已验证的结论与拿到的结果:分数、通过的测试、确认可行的解法——写可核对的事实)";
const NEXT_PLACEHOLDER = "(接下来要做的事与候选思路,按优先级排列)";

// checkpoint 落盘核心:三区制重建(ADR-0003)——
// 受管节(Goal 穿越保留 / Now 与 成果/下一步 按参数替换、缺省保留)、
// 保留区(自定义节原样搬运)、回顾区(追加+折叠)。格式归位由代码保证,模型只交内容。
function executeCheckpoint(params: { kind: "status" | "review"; status: string; results?: string; next?: string; reflect?: string; adjust?: string }): void {
  const exists = existsSync(STATE_FILE);
  // 读失败 ≠ 不存在:文件在但读不了时中止,绝不用占位符覆写它
  const current = exists ? readNav() : null;
  if (exists && current === null) throw new Error(`${STATE_FILE} 存在但读取失败,已中止本次落盘以保护原内容`);

  const title = current ? extractTitle(current) : "(任务标题)";
  const sections = current ? splitSections(stripReviews(current)) : [];
  const sec = (pred: (h: string) => boolean) => sections.find((s) => pred(s.heading));
  const goal = sec(isGoalHeading)?.body.trim() || "(待补充)";
  const results = params.results?.trim() || sec(isResultsHeading)?.body.trim() || "";
  const next = params.next?.trim() || sec(isNextHeading)?.body.trim() || "";
  const customs = sections.filter(
    (s) => !isGoalHeading(s.heading) && !isNowHeading(s.heading) && !isResultsHeading(s.heading) && !isNextHeading(s.heading),
  );
  const kept = (current ? parseReviews(current) : []).slice(0, Math.max(0, REVIEWS_KEPT - 1));

  const parts: string[] = [
    `# ${title}`,
    `## Goal\n${goal}`,
    buildNow(params.status),
    `## 成果\n${results || RESULTS_PLACEHOLDER}`,
    `## 下一步\n${next || NEXT_PLACEHOLDER}`,
  ];
  for (const s of customs) parts.push(`## ${s.heading}\n${s.body}`);
  let out = parts.join("\n\n") + "\n";
  if (params.kind === "review") {
    reviewCount += 1;
    out += `\n### 回顾 #${reviewCount}(约第 ${turnCount} 轮)\n` +
      `- 自省: ${flatten(params.reflect ?? "-")}\n` +
      `- 调整: ${flatten(params.adjust ?? "-")}\n`;
  }
  if (kept.length > 0) out += "\n" + kept.join("\n\n") + "\n";
  writeFileSync(STATE_FILE, out);

  lastStatusTurn = turnCount;
  lastNavWriteTurn = turnCount;
  if (params.kind === "review") { lastReviewTurn = turnCount; lastActualReviewTurn = turnCount; }
}

// —— 事实化提示家族(ADR-0002):事实链 = 陈旧数字 + Goal/Now/回顾对照(标注轮距与来源)
// + 后果事实(未记入的进展压缩后可能丢失),收于恰一个判断权声明或疑问句。
// 全家族零祈使句(哲学红线,单测 T20 固化);status 问记录差距,review 问方向。
// 总结的内容形状不归提示管——在 checkpoint 工具的参数描述里(四要素)。

function steerHint(): string {
  const raw = readNav();
  const goal = raw !== null ? extractGoal(raw) : "";
  const goalClause = goal && goal !== "(待补充)"
    ? `当前 Goal(来自 ${STATE_FILE}):"${quoteGoal(goal)}";`
    : "";
  return `[转向提示] 有新的用户输入已注入;${goalClause}` +
    "新输入若改变任务目标→更新导航并记一句变更原因;若为细化→继续当前工作。判断在你。";
}

function docHint(): string {
  // 位置写死(ADR-0005):实测有模型把文件建进子目录(tsec/),系统只读运行目录——
  // 歧义的代价是一整场,所以直接带绝对路径
  return `[导航状态] 已 ${toolCalls} 次工具调用,工作目录根(${process.cwd()})没有 ${STATE_FILE}` +
    "——本系统只从运行目录读取。当前进展仅存在于对话历史中(上下文压缩后可能丢失)。是否建立由你判断。";
}

// 空文档回顾事实(ADR-0005,二轮审查修订):纯事实、不带问句——"要不要建档"已由
// 建档提醒问过一次并交出判断权,模型以百轮不建作答;此处重问即重开已决问题。
function emptyReviewHint(): string {
  return `[回顾状态] 已 ${turnCount} 轮,导航文件仍未建立。` +
    "此期间的进展只存在于对话历史中(上下文压缩后可能丢失)。";
}

function statusHint(): string {
  const stale = turnCount - lastNavWriteTurn;
  const raw = readNav();
  if (raw === null) return `[导航状态] 导航已 ${stale} 轮未更新。(${STATE_FILE} 读取失败)`;
  const now = extractNow(raw);
  const goal = extractGoal(raw);
  let s = `[导航状态] 导航已 ${stale} 轮未更新。`;
  if (goal && goal !== "(待补充)") s += `Goal:"${quoteGoal(goal)}"(来自 ${STATE_FILE})。`;
  if (now) s += `上条 Now(${stale} 轮前):"${quote(now)}"。`;
  s += "此后的进展未记入,压缩后可能丢失。是否记入、记什么,由你判断。";
  return s;
}

function reviewHint(): string {
  const stale = turnCount - lastActualReviewTurn;
  const raw = readNav();
  let s = `[回顾状态] 已 ${stale} 轮未深度回顾。`;
  if (raw !== null) {
    const goal = extractGoal(raw);
    if (goal && goal !== "(待补充)") s += `Goal:"${quoteGoal(goal)}"(来自 ${STATE_FILE})。`;
    const blocks = parseReviews(raw);
    if (blocks.length > 0) {
      const num = blocks[0].match(/^### 回顾 #(\d+)/)?.[1] ?? "?";
      const at = Number(blocks[0].match(/约第 (\d+) 轮/)?.[1] ?? NaN);
      const self = blocks[0].match(/- 自省: (.+)/m)?.[1] ?? "";
      const anchor = Number.isFinite(at) ? `(${turnCount - at} 轮前)` : "";
      s += `最近回顾 #${num}${anchor}:"自省: ${self ? quote(self, REVIEW_QUOTE_MAX) : "(无)"}"。`;
    } else {
      s += "最近回顾:无记录。";
    }
  }
  s += `这 ${stale} 轮的路线是否仍通向 Goal?`;
  return s;
}

// 提示追加在工具结果之后,绝不替换——当轮工具输出是模型刚要的事实
function appendHint(event: { content?: unknown[] }, hint: string) {
  return { content: [...(event.content ?? []), { type: "text", text: hint }] };
}

// 直接导航更新检测:模型绕过 checkpoint 直接 write/edit 导航文件也算真实更新
// (陈旧事实必须反映文件内容的新旧,而不是工具的选择——虚假的"已 X 轮未更新"比没有更糟)
function isDirectNavWrite(event: { toolName?: string; input?: unknown }): boolean {
  if (event.toolName !== "write" && event.toolName !== "edit") return false;
  try {
    return JSON.stringify(event.input ?? {}).includes(STATE_FILE);
  } catch {
    return false;
  }
}

// 通道分派:默认经消息通道送轮边界;PI_DRIFT_HINT_CHANNEL=tail 时回退工具结果尾巴
function deliver(event: { content?: unknown[] }, hint: string, sendHint?: (h: string) => void) {
  if (sendHint && hintViaMessage()) {
    sendHint(hint);
    return undefined;
  }
  return appendHint(event, hint);
}

// 节拍器:优先级 转向确认 > 空文档回顾事实 > 建档提醒(仅一次) > review > status;
// 同轮去重:lastNudgedTurn 守卫;提示即消费节拍时钟,避免逐轮轰炸。
// status/review 与建档提醒默认经轮边界消息通道投递(ADR-0004/0005);sendHint 由注册处注入。
function onToolResult(event: { isError?: boolean; content?: unknown[]; toolName?: string; input?: unknown }, sendHint?: (hint: string) => void) {
  if (!enabled()) return undefined;
  if (event.isError) return undefined;
  toolCalls++;

  if (isDirectNavWrite(event)) lastNavWriteTurn = turnCount;

  if (nudgeSteerNext) {
    nudgeSteerNext = false;
    lastNudgedTurn = turnCount;
    return appendHint(event, steerHint());
  }

  if (!existsSync(STATE_FILE)) {
    // 空文档期(ADR-0005):建档提醒(一次)+ 回顾节拍降级为空文档事实
    if (docReminded && turnCount - lastReviewTurn >= REVIEW_EVERY && lastNudgedTurn !== turnCount) {
      lastNudgedTurn = turnCount;
      lastReviewTurn = turnCount;
      return deliver(event, emptyReviewHint(), sendHint);
    }
    if (!docReminded && toolCalls >= BRIEF_AFTER) {
      docReminded = true;
      lastNudgedTurn = turnCount; // 防与空文档事实同轮背靠背
      return deliver(event, docHint(), sendHint);
    }
    return undefined;
  }

  const dueReview = turnCount - lastReviewTurn >= REVIEW_EVERY;
  const dueStatus = turnCount - lastStatusTurn >= STATUS_EVERY;
  if ((dueReview || dueStatus) && lastNudgedTurn !== turnCount) {
    lastNudgedTurn = turnCount;
    if (dueReview) lastReviewTurn = turnCount;
    if (dueStatus) lastStatusTurn = turnCount;
    return deliver(event, dueReview ? reviewHint() : statusHint(), sendHint);
  }
  return undefined;
}

export default function (pi) {
  pi.registerTool({
    name: "checkpoint",
    description:
      "阶段性导航维护工具。两种模式:\n" +
      'kind="status":简要汇报当前进展(约每 50 轮一次)。\n' +
      'kind="review":深度回顾——对照任务导航自省:方向是否对准、哪些工作有效、' +
      "哪些无效、路线是否需要调整(约每 100 轮一次)。\n" +
      "status→Now 节整节替换;可选 results→成果节、next→下一步节(提供才替换,不提供则保留原节)。\n" +
      "标题、Goal、回顾、以及你自己添加的其他小节(表格/清单/经验)一律原样保留。\n" +
      "导航文件固定为运行目录根的 PROGRESS.md——本系统只从运行目录读取。不存在则按标准骨架自动创建。",
    parameters: Type.Object({
      kind: Type.String({ enum: ["status", "review"], description: "回顾类型:status=现状汇报,review=深度自省" }),
      status: Type.String({ description: "现状汇报,四要素:正在做什么、已完成或已验证的成果、做过的关键工作、下一步打算。可核对的事实优先(路径/命令/测试结果);对照上一条 Now,只记增量。" }),
      results: Type.Optional(Type.String({ description: "成果节(可选,提供则整节替换):已验证的结论与拿到的结果——分数、通过的测试、确认可行的解法,写可核对的事实" })),
      next: Type.Optional(Type.String({ description: "下一步节(可选,提供则整节替换):接下来要做的事与候选思路,按优先级排列" })),
      reflect: Type.Optional(Type.String({ description: "仅 review:自省——方向正确性、有效与无效的工作" })),
      adjust: Type.Optional(Type.String({ description: "仅 review:调整决定(无需调整请明说)" })),
    }),
    execute: async (_toolCallId, params) => {
      if (!enabled()) {
        return { content: [{ type: "text", text: "(防漂移系统已停用)" }], details: {} };
      }
      executeCheckpoint(params);
      return {
        content: [{
          type: "text",
          text: params.kind === "review"
            ? "回顾已记录到导航文件。"
            : "已记录。",
        }],
        details: { kind: params.kind, turn: turnCount },
      };
    },
  });

  // 复位点:每次新提问把运行计数归零(只返回 undefined,不碰 systemPrompt 槽)
  pi.on("before_agent_start", async () => {
    if (!enabled()) return undefined;
    turnCount = 0; toolCalls = 0;
    lastStatusTurn = 0; lastReviewTurn = 0; lastNudgedTurn = -1;
    lastNavWriteTurn = 0; lastActualReviewTurn = 0;
    docReminded = false;
    seenInitialUser = false; steerArmed = false; nudgeSteerNext = false;
    return undefined;
  });

  pi.on("turn_end", async () => {
    if (enabled()) turnCount++;
  });

  pi.on("input", async (event) => {
    if (!enabled()) return { action: "continue" };
    if (event.streamingBehavior === "steer") steerArmed = true;
    return { action: "continue" };
  });

  pi.on("message_start", async (event) => {
    if (!enabled()) return undefined;
    if (event.message.role !== "user") return undefined;
    if (!seenInitialUser) { seenInitialUser = true; return undefined; } // 首条=提问本人
    if (steerArmed) { nudgeSteerNext = true; steerArmed = false; }      // 转向落地
    return undefined;
  });

  pi.on("tool_result", (event) =>
    onToolResult(event, (hint) => {
      pi.sendMessage(
        { customType: "drift-guard-hint", content: [{ type: "text", text: hint }], display: true },
        { triggerTurn: true },
      );
    }),
  );
}
