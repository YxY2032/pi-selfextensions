import { appendFileSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

// 追踪探针(开发工具,只有显式 -e 加载才生效,不进 package.json 的 pi.extensions)。
// 目的:让"模型真正收到了什么"可观测。before_provider_request 在 forced-prompt
// projection 之后、HTTP 之前触发,是锚/preamble/plan_state 是否真的到达模型的
// 唯一观测点(会话 JSONL 记录的是 sections 形态,看不到 projection 的结果)。
// 其余钩子记录调用时间线(input 的 steer/followUp、消息边界、每次工具调用)。
// 全部钩子只记录不修改,恒返回 undefined。

const TRACE_DIR = "/tmp/pi-trace";
const KEEP = 20; // 滚动清理:只保留最新 N 份 trace 文件

const MARKERS: ReadonlyArray<readonly [string, string]> = [
  ["anchor", "## 任务导航"],
  ["preamble", "sandbox task executor"],
  ["plan_state", "<plan_state>"],
  ["nowSection", "## Now"],
];

const tracePath = `${TRACE_DIR}/trace-${Date.now()}-${process.pid}.jsonl`;
const dumpedSystem = new Set<string>();
let reqSeq = 0;
let toolSeq = 0;

function log(entry: Record<string, unknown>): void {
  appendFileSync(tracePath, JSON.stringify({ t: new Date().toISOString(), ...entry }) + "\n");
}

// 从 provider payload 里提取 system 文本(形状随 provider 而异,做宽容提取;
// 提取不到时 sysExtract:"miss",标记判定视为不可用而不是误报)
function extractSystem(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const p = payload as Record<string, unknown>;
  if (typeof p.system === "string") return p.system;
  if (Array.isArray(p.messages)) {
    const parts: string[] = [];
    for (const m of p.messages) {
      const msg = m as Record<string, unknown>;
      if (msg && msg.role === "system") {
        parts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""));
      }
    }
    return parts.join("\n");
  }
  return "";
}

function initDir(): void {
  mkdirSync(TRACE_DIR, { recursive: true });
  const traces = readdirSync(TRACE_DIR).filter((f) => /^trace-.*\.jsonl$/.test(f)).sort();
  for (const f of traces.slice(0, Math.max(0, traces.length - KEEP))) {
    rmSync(`${TRACE_DIR}/${f}`);
  }
}

export default function (pi) {
  initDir();
  log({ type: "probe_start", pid: process.pid, cwd: process.cwd() });

  pi.on("before_agent_start", async (event) => {
    log({ type: "run", promptHead: String(event.prompt ?? "").slice(0, 60) });
    return undefined;
  });

  pi.on("input", async (event) => {
    log({ type: "input", behavior: event.streamingBehavior ?? "(idle)", textHead: String(event.text ?? "").slice(0, 40) });
    return undefined;
  });

  pi.on("message_start", async (event) => {
    log({ type: "msg_start", role: event.message?.role });
    return undefined;
  });

  pi.on("turn_end", async () => {
    log({ type: "turn_end" });
    return undefined;
  });

  pi.on("tool_result", async (event) => {
    toolSeq++;
    log({ type: "tool", seq: toolSeq, name: event.toolName, isError: event.isError === true });
    return undefined;
  });

  pi.on("before_provider_request", async (event) => {
    try {
      reqSeq++;
      const system = extractSystem(event.payload);
      const payload = event.payload as Record<string, unknown> | undefined;
      const messages = payload && Array.isArray(payload.messages) ? (payload.messages as unknown[]).length : undefined;
      if (system === "") {
        log({ type: "request", seq: reqSeq, sysExtract: "miss", msgCount: messages });
        return undefined;
      }
      const hash = createHash("sha1").update(system).digest("hex").slice(0, 8);
      const markers: Record<string, boolean> = {};
      for (const [name, needle] of MARKERS) markers[name] = system.includes(needle);
      // 引导形态的骨架本身就含 "## Now" 字样,不算泄漏;只有非引导形态出现才是真泄漏
      markers.nowLeak = markers.nowSection && !system.includes("当前没有导航文件");
      delete markers.nowSection;
      log({ type: "request", seq: reqSeq, sysLen: system.length, sysHash: hash, markers, msgCount: messages });
      if (!dumpedSystem.has(hash)) {
        dumpedSystem.add(hash);
        writeFileSync(`${TRACE_DIR}/systemdump-${hash}.txt`, system);
      }
    } catch (e) {
      log({ type: "request", seq: reqSeq, error: (e as Error).message });
    }
    return undefined;
  });
}
