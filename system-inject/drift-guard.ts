import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";

// 防漂移·动态部件:checkpoint 工具 + 节拍器 + 转向确认。
// 与 index.ts(preamble + 锚)同包不同文件:事件钩子是多槽叠加,
// 不存在 systemPrompt 返回值的单槽覆盖问题。
// 设计与决策记录见同目录 README.md。PI_DRIFT_GUARD=off 时全部静默。

const STATE_FILE = "PROGRESS.md";
const STATUS_EVERY = 10;  // 轻检查间隔(轮)
const REVIEW_EVERY = 20;  // 深度回顾间隔(轮)
const BRIEF_AFTER = 15;   // 无文档时,工具调用达到此次数提醒建文档(仅一次)
const REVIEWS_KEPT = 3;   // 回顾史限留段数

const enabled = () => process.env.PI_DRIFT_GUARD !== "off";

// —— 运行状态(before_agent_start 复位;reviewCount 为任务级,跨运行连续)
let turnCount = 0, toolCalls = 0;
let lastStatusTurn = 0, lastReviewTurn = 0, lastNudgedTurn = -1;
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

// 回顾块解析:行首锚定,避免 reflect 文本中内联的 "### 回顾" 字样切出幻影块
function parseReviews(c: string): string[] {
  const blocks: string[] = [];
  const re = /^### 回顾[^\n]*/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(c)) !== null) {
    const rest = c.slice(m.index + 1);
    const next = rest.search(/\n(## |### 回顾)/);
    const end = next === -1 ? c.length : m.index + 1 + next;
    blocks.push(c.slice(m.index, end).trim());
  }
  return blocks;
}

function flatten(s: string): string {
  return s.replace(/\s*\n\s*/g, " ").trim();
}

function buildNow(status: string): string {
  const lines = status.trim().split("\n").map((l) => "- " + l.trim()).join("\n");
  return `## Now\n${lines}`;
}

// checkpoint 落盘核心:每次调用都全文件重建(格式归位),
// 保留 title/Goal 与最近回顾,Now 以本次汇报覆盖。
function executeCheckpoint(params: { kind: "status" | "review"; status: string; reflect?: string; adjust?: string }): void {
  const exists = existsSync(STATE_FILE);
  // 读失败 ≠ 不存在:文件在但读不了时中止,绝不用占位符覆写它
  const current = exists ? readNav() : null;
  if (exists && current === null) throw new Error(`${STATE_FILE} 存在但读取失败,已中止本次落盘以保护原内容`);
  const title = current ? extractTitle(current) : "(任务标题)";
  const goal = current ? extractGoal(current) : "(待补充)";
  const oldReviews = current ? parseReviews(current) : [];
  // 文档顺序即最新在前:保住最近的 (REVIEWS_KEPT-1) 个旧块
  const kept = oldReviews.slice(0, Math.max(0, REVIEWS_KEPT - 1));

  const doc = [`# ${title}`, `## Goal\n${goal}`, buildNow(params.status)].join("\n\n") + "\n";
  let out = doc;
  if (params.kind === "review") {
    reviewCount += 1;
    out += `\n### 回顾 #${reviewCount}(约第 ${turnCount} 轮)\n` +
      `- 自省: ${flatten(params.reflect ?? "-")}\n` +
      `- 调整: ${flatten(params.adjust ?? "-")}\n`;
  }
  if (kept.length > 0) out += "\n" + kept.join("\n\n") + "\n";
  writeFileSync(STATE_FILE, out);

  lastStatusTurn = turnCount;
  if (params.kind === "review") lastReviewTurn = turnCount;
}

const STEER_HINT =
  "[转向提示] 有新的用户输入已注入。若它改变了任务的目标或方向,建议调用 checkpoint " +
  "更新导航(Now 反映新意图;目标变了则更新 Goal 并记一句变更原因)。" +
  "若只是对当前工作的细化或补充,忽略本提示即可。";

const DOC_HINT =
  `[系统观察] 本任务已进行约 ${BRIEF_AFTER} 次工具调用,规模不小了。` +
  "建议建立 PROGRESS.md 导航文件(目标+当前状态)——它会在每次新对话时自动带回。" +
  "若认为无必要,忽略即可。";

function statusHint(): string {
  return `[检查点 · 第 ${turnCount} 轮] 建议调用 checkpoint(kind="status")简要汇报当前进展。`;
}

function reviewHint(): string {
  return `[回顾点 · 第 ${turnCount} 轮] 建议调用 checkpoint(kind="review"):` +
    "回顾方向是否仍对准任务导航,哪些工作有效、哪些无效,是否需要调整路线。";
}

// 提示追加在工具结果之后,绝不替换——当轮工具输出是模型刚要的事实
function appendHint(event: { content?: unknown[] }, hint: string) {
  return { content: [...(event.content ?? []), { type: "text", text: hint }] };
}

// 节拍器:优先级 转向确认 > 建文档提醒(仅一次) > review(20) > status(10);
// 同轮去重:lastNudgedTurn 守卫;提示即消费时钟,避免逐轮轰炸。
function onToolResult(event: { isError?: boolean; content?: unknown[] }) {
  if (!enabled()) return undefined;
  if (event.isError) return undefined;
  toolCalls++;

  if (nudgeSteerNext) {
    nudgeSteerNext = false;
    lastNudgedTurn = turnCount;
    return appendHint(event, STEER_HINT);
  }

  if (!existsSync(STATE_FILE)) {
    if (!docReminded && toolCalls >= BRIEF_AFTER) {
      docReminded = true;
      return appendHint(event, DOC_HINT);
    }
    return undefined;
  }

  const dueReview = turnCount - lastReviewTurn >= REVIEW_EVERY;
  const dueStatus = turnCount - lastStatusTurn >= STATUS_EVERY;
  if ((dueReview || dueStatus) && lastNudgedTurn !== turnCount) {
    lastNudgedTurn = turnCount;
    if (dueReview) lastReviewTurn = turnCount;
    if (dueStatus) lastStatusTurn = turnCount;
    return appendHint(event, dueReview ? reviewHint() : statusHint());
  }
  return undefined;
}

export default function (pi) {
  pi.registerTool({
    name: "checkpoint",
    description:
      "阶段性导航维护工具。两种模式:\n" +
      'kind="status":简要汇报当前进展与最新成果(约每 10 轮一次)。\n' +
      'kind="review":深度回顾——对照任务导航自省:方向是否对准、哪些工作有效、' +
      "哪些无效、路线是否需要调整(约每 20 轮一次)。\n" +
      "汇报会自动同步进 PROGRESS.md(不存在则按标准骨架自动创建)。",
    parameters: Type.Object({
      kind: Type.String({ enum: ["status", "review"], description: "回顾类型:status=现状汇报,review=深度自省" }),
      status: Type.String({ description: "现状:正在做什么、已有成果(可核对的事实优先:路径/命令/测试结果)" }),
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

  pi.on("tool_result", onToolResult);
}
