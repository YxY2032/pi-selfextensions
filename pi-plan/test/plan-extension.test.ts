import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import planExtension from "../index.ts";
import { formatPlanSnapshot } from "../inject.ts";
import { formatIncompleteStatus, shouldFlagIncomplete } from "../settle.ts";
import { diffPlans, renderPlanCall, renderPlanResult, summarizeDiff } from "../render.ts";
import { PlanViewComponent, planWidgetLines } from "../view.ts";
import {
	hasUnfinishedSteps,
	isPlanState,
	PLAN_TOOL_NAME,
	type PlanBranchEntryLike,
	type PlanState,
	type PlanToolDetails,
	readPlanFromBranch,
} from "../state.ts";
import {
	applyWritePlan,
	createPlanToolDefinition,
	MAX_PLAN_STEPS,
	MAX_STEP_CONTENT_CHARS,
	type WritePlanInput,
} from "../tool.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";

function writeEntry(details: unknown): PlanBranchEntryLike {
	return { type: "message", message: { role: "toolResult", toolName: PLAN_TOOL_NAME, details } };
}

function plan(goal: string, ...contents: string[]): PlanState {
	return { goal, steps: contents.map((content) => ({ content, status: "pending" })) };
}

function detailsOf(next: PlanState, previous: PlanState | null = null): PlanToolDetails {
	return { previous, plan: next };
}

describe("isPlanState", () => {
	it("accepts a valid plan", () => {
		expect(isPlanState(plan("goal", "a"))).toBe(true);
	});

	it("accepts a plan with zero steps (cleared plan)", () => {
		expect(isPlanState({ goal: "", steps: [] })).toBe(true);
	});

	it("rejects non-objects and missing fields", () => {
		expect(isPlanState(null)).toBe(false);
		expect(isPlanState("plan")).toBe(false);
		expect(isPlanState({ steps: [] })).toBe(false);
		expect(isPlanState({ goal: "g", steps: "many" })).toBe(false);
	});

	it("rejects steps with invalid shape or status", () => {
		expect(isPlanState({ goal: "g", steps: [{ content: "a", status: "blocked" }] })).toBe(false);
		expect(isPlanState({ goal: "g", steps: [{ content: 1, status: "pending" }] })).toBe(false);
		expect(isPlanState({ goal: "g", steps: [null] })).toBe(false);
	});
});

describe("readPlanFromBranch", () => {
	it("returns null for an empty branch", () => {
		expect(readPlanFromBranch([])).toBeNull();
	});

	it("ignores entries that are not write_plan tool results", () => {
		const entries: PlanBranchEntryLike[] = [
			{ type: "usage" },
			{ type: "message", message: { role: "user" } },
			{ type: "message", message: { role: "assistant" } },
			{ type: "message", message: { role: "toolResult", toolName: "bash", details: detailsOf(plan("g", "a")) } },
		];
		expect(readPlanFromBranch(entries)).toBeNull();
	});

	it("returns the plan from a single write", () => {
		const written = plan("add feature", "step one", "step two");
		expect(readPlanFromBranch([writeEntry(detailsOf(written))])).toEqual(written);
	});

	it("lets the last write win", () => {
		const first = plan("old goal", "a");
		const second = plan("new goal", "b", "c");
		const entries = [
			writeEntry(detailsOf(first)),
			{ type: "message", message: { role: "assistant" } },
			writeEntry(detailsOf(second, first)),
		];
		expect(readPlanFromBranch(entries)).toEqual(second);
	});

	it("treats a zero-step write as clearing the plan", () => {
		const entries = [writeEntry(detailsOf(plan("goal", "a"))), writeEntry(detailsOf({ goal: "", steps: [] }))];
		expect(readPlanFromBranch(entries)).toBeNull();
	});

	it("applies clear markers and writes in branch order", () => {
		const written = plan("goal", "a");
		expect(
			readPlanFromBranch([writeEntry(detailsOf(written)), { type: "custom", customType: "plan.cleared" }]),
		).toBeNull();
		expect(
			readPlanFromBranch([{ type: "custom", customType: "plan.cleared" }, writeEntry(detailsOf(written))]),
		).toEqual(written);
	});

	it("skips malformed details and falls back to the last valid write", () => {
		const first = plan("goal", "a");
		const entries = [
			writeEntry(undefined),
			writeEntry(detailsOf(first)),
			writeEntry({ previous: null, plan: { goal: "g", steps: [{ content: "x", status: "nope" }] } }),
			writeEntry(null),
		];
		expect(readPlanFromBranch(entries)).toEqual(first);
	});
});

function input(goal: string, steps: [string, "pending" | "in_progress" | "completed"][]): WritePlanInput {
	return { goal, steps: steps.map(([content, status]) => ({ content, status })) };
}

function resultText(outcome: { result: { content: { type: string; text?: string }[] } }): string {
	const first = outcome.result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

describe("applyWritePlan", () => {
	it("creates a plan when none exists", () => {
		const outcome = applyWritePlan(
			null,
			input("add feature", [
				["step one", "pending"],
				["step two", "pending"],
			]),
		);
		expect(outcome.ok).toBe(true);
		expect(outcome.next).toEqual({
			goal: "add feature",
			steps: [
				{ content: "step one", status: "pending" },
				{ content: "step two", status: "pending" },
			],
		});
		expect(outcome.result.details.previous).toBeNull();
		expect(resultText(outcome)).toBe("Plan created (2 steps): add feature");
	});

	it("reports progress counts when updating an existing plan", () => {
		const current: PlanState = {
			goal: "add feature",
			steps: [{ content: "step one", status: "pending" }],
		};
		const outcome = applyWritePlan(
			current,
			input("add feature", [
				["step one", "completed"],
				["step two", "in_progress"],
			]),
		);
		expect(resultText(outcome)).toBe("Plan updated (1/2 done · +1 step · 1 updated): add feature");
		expect(outcome.result.details.previous).toBe(current);
	});

	it("clears the plan on an empty steps list", () => {
		const current = plan("goal", "a");
		const outcome = applyWritePlan(current, input("", []));
		expect(outcome.ok).toBe(true);
		expect(outcome.next).toBeNull();
		expect(resultText(outcome)).toBe("Plan cleared.");
	});

	it("accepts clearing when no plan exists", () => {
		const outcome = applyWritePlan(null, input("", []));
		expect(outcome.ok).toBe(true);
		expect(outcome.next).toBeNull();
	});

	it("rejects more than the step cap and leaves the plan unchanged", () => {
		const current = plan("goal", "a");
		const steps = Array.from(
			{ length: MAX_PLAN_STEPS + 1 },
			(_, i) => [`step ${i + 1}`, "pending"] as [string, "pending"],
		);
		const outcome = applyWritePlan(current, input("goal", steps));
		expect(outcome.ok).toBe(false);
		expect(outcome.next).toBe(current);
		expect(resultText(outcome)).toContain(`capped at ${MAX_PLAN_STEPS} steps`);
	});

	it("rejects empty or overlong step content with the step number", () => {
		const current = plan("goal", "a");
		const empty = applyWritePlan(
			current,
			input("goal", [
				["ok", "pending"],
				["  ", "pending"],
			]),
		);
		expect(empty.ok).toBe(false);
		expect(resultText(empty)).toContain("step 2 has empty content");

		const overlong = applyWritePlan(current, input("goal", [["x".repeat(MAX_STEP_CONTENT_CHARS + 1), "pending"]]));
		expect(overlong.ok).toBe(false);
		expect(resultText(overlong)).toContain(`step 1 exceeds ${MAX_STEP_CONTENT_CHARS} characters`);
	});

	it("rejects a non-empty plan without a goal", () => {
		const outcome = applyWritePlan(null, input("   ", [["step", "pending"]]));
		expect(outcome.ok).toBe(false);
		expect(resultText(outcome)).toContain("goal is required");
	});

	it("trims goal and step content", () => {
		const outcome = applyWritePlan(null, input("  goal  ", [["  step  ", "pending"]]));
		expect(outcome.next?.goal).toBe("goal");
		expect(outcome.next?.steps[0]?.content).toBe("step");
	});

	it("keeps error details state-neutral", () => {
		const current = plan("goal", "a");
		const outcome = applyWritePlan(current, input("", [["step", "pending"]]));
		expect(outcome.result.details.plan).toEqual(current);
		expect(readPlanFromBranch([writeEntry(outcome.result.details)])).toEqual(current);

		const fromNull = applyWritePlan(null, input("", [["step", "pending"]]));
		expect(readPlanFromBranch([writeEntry(fromNull.result.details)])).toBeNull();
	});
});

describe("createPlanToolDefinition", () => {
	it("updates state through the access object on a successful write", async () => {
		let current: PlanState | null = null;
		const setPlan = vi.fn((p: PlanState | null) => {
			current = p;
		});
		const tool = createPlanToolDefinition({ getPlan: () => current, setPlan });

		expect(tool.name).toBe(PLAN_TOOL_NAME);
		const result = await tool.execute("call-1", input("goal", [["a", "pending"]]), undefined, undefined, {
			mode: "json",
		} as unknown as ExtensionContext);
		expect(setPlan).toHaveBeenCalledOnce();
		expect(current).not.toBeNull();
		expect(result.details.plan.goal).toBe("goal");
	});

	it("does not touch state on a rejected write", async () => {
		const current = plan("goal", "a");
		const setPlan = vi.fn();
		const tool = createPlanToolDefinition({ getPlan: () => current, setPlan });

		await tool.execute("call-1", input("", [["bad", "pending"]]), undefined, undefined, {
			mode: "json",
		} as unknown as ExtensionContext);
		expect(setPlan).not.toHaveBeenCalled();
	});
});

describe("snapshot formatting", () => {
	it("detects unfinished steps", () => {
		expect(hasUnfinishedSteps(plan("g", "a"))).toBe(true);
		expect(hasUnfinishedSteps({ goal: "g", steps: [{ content: "a", status: "in_progress" }] })).toBe(true);
		expect(hasUnfinishedSteps({ goal: "g", steps: [{ content: "a", status: "completed" }] })).toBe(false);
		expect(hasUnfinishedSteps({ goal: "g", steps: [] })).toBe(false);
	});

	it("renders goal, numbering, and status marks", () => {
		const snapshot = formatPlanSnapshot({
			goal: "add feature X",
			steps: [
				{ content: "explore", status: "completed" },
				{ content: "implement", status: "in_progress" },
				{ content: "test", status: "pending" },
			],
		});
		expect(snapshot).toBe(["Goal: add feature X", "1. [x] explore", "2. [>] implement", "3. [ ] test"].join("\n"));
	});

	it("appends the retirement instruction only when all steps are complete", () => {
		const complete = formatPlanSnapshot({
			goal: "g",
			steps: [{ content: "a", status: "completed" }],
		});
		expect(complete).toContain("All steps complete");
		expect(formatPlanSnapshot(plan("g", "a"))).not.toContain("All steps complete");
	});
});

describe("plan extension wiring", () => {
	type Handler = (event: any, ctx: ExtensionContext) => Promise<unknown> | unknown;

	function setup(branch: PlanBranchEntryLike[] = []) {
		const tools: {
			name: string;
			execute: (id: string, params: WritePlanInput) => Promise<any>;
			promptGuidelines?: string[];
		}[] = [];
		const handlers = new Map<string, Handler>();
		const commands = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>();
		const completions = new Map<string, (prefix: string) => unknown>();
		const sendMessage = vi.fn();
		const appendEntry = vi.fn();
		const setStatus = vi.fn();
		const notify = vi.fn();
		const setWidget = vi.fn();
		const custom = vi.fn(async (factory: any) => {
			await factory(undefined, testTheme, undefined, () => {});
		});
		const api = {
			registerTool: (tool: any) => tools.push(tool),
			registerCommand: (
				name: string,
				command: {
					handler: (args: string, ctx: ExtensionContext) => Promise<void>;
					getArgumentCompletions?: (prefix: string) => unknown;
				},
			) => {
				commands.set(name, command.handler);
				if (command.getArgumentCompletions) completions.set(name, command.getArgumentCompletions);
			},
			on: (event: string, handler: Handler) => handlers.set(event, handler),
			sendMessage,
			appendEntry,
		} as unknown as ExtensionAPI;
		planExtension(api);

		const ctx = {
			mode: "tui" as const,
			sessionManager: { getBranch: () => branch },
			ui: { setStatus, notify, setWidget, custom, theme: { fg: (_name: string, text: string) => text } },
		} as unknown as ExtensionContext;
		return {
			tools,
			handlers,
			commands,
			completions,
			ctx,
			sendMessage,
			appendEntry,
			setStatus,
			notify,
			setWidget,
			custom,
		};
	}

	function agentStartEvent(): {
		type: "before_agent_start";
		systemPromptOptions: { sections: Record<string, string> };
	} {
		return { type: "before_agent_start", systemPromptOptions: { sections: {} } };
	}

	it("registers write_plan with prompt guidelines", () => {
		const { tools } = setup();
		expect(tools.map((t) => t.name)).toEqual([PLAN_TOOL_NAME]);
		expect(tools[0]?.promptGuidelines?.length).toBeGreaterThan(0);
	});

	it("injects nothing without a plan", () => {
		const { handlers } = setup();
		const event = agentStartEvent();
		handlers.get("before_agent_start")?.(event, {} as ExtensionContext);
		expect(event.systemPromptOptions.sections.plan_state).toBeUndefined();
	});

	it("reconstructs the plan on session_start and injects the snapshot", () => {
		const written = plan("add feature", "a", "b");
		const { handlers, ctx } = setup([writeEntry(detailsOf(written))]);

		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
		const event = agentStartEvent();
		handlers.get("before_agent_start")?.(event, ctx);
		expect(event.systemPromptOptions.sections.plan_state).toContain("Goal: add feature");
		expect(event.systemPromptOptions.sections.plan_state).toContain("2. [ ] b");
	});

	it("reconstructs on session_tree (branch navigation)", () => {
		const { handlers, ctx } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(agentStartInjected(handlers)).toBeUndefined();

		const branch = [writeEntry(detailsOf(plan("other branch", "x")))];
		const treeCtx = {
			sessionManager: { getBranch: () => branch },
			ui: { setWidget: vi.fn() },
		} as unknown as ExtensionContext;
		handlers.get("session_tree")?.({ type: "session_tree", newLeafId: "2", oldLeafId: "1" }, treeCtx);
		expect(agentStartInjected(handlers)).toContain("Goal: other branch");
	});

	it("closes the loop: tool write updates the next injected snapshot", async () => {
		const { tools, handlers, ctx } = setup();

		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(agentStartInjected(handlers)).toBeUndefined();

		await tools[0]?.execute(
			"call-1",
			input("goal", [
				["a", "pending"],
				["b", "pending"],
			]),
		);
		expect(agentStartInjected(handlers)).toContain("1. [ ] a");

		await tools[0]?.execute(
			"call-2",
			input("goal", [
				["a", "completed"],
				["b", "in_progress"],
			]),
		);
		expect(agentStartInjected(handlers)).toContain("1. [x] a");

		await tools[0]?.execute("call-3", input("", []));
		expect(agentStartInjected(handlers)).toBeUndefined();
	});

	function agentStartInjected(handlers: Map<string, Handler>): string | undefined {
		const event = agentStartEvent();
		handlers.get("before_agent_start")?.(event, {} as ExtensionContext);
		return event.systemPromptOptions.sections.plan_state;
	}

	it("flags unfinished plans in the footer on settle without continuing the run", async () => {
		const { tools, handlers, ctx, sendMessage, setStatus } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await tools[0]?.execute("call-1", input("goal", [["a", "completed"], ["b", "in_progress"]]));
		handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);

		expect(sendMessage).not.toHaveBeenCalled();
		expect(setStatus).toHaveBeenCalledWith("plan", "plan 1/2 · unfinished");
	});

	it("clears the marker on aborted or errored runs", async () => {
		const { tools, handlers, ctx, setStatus } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await tools[0]?.execute("call-1", input("goal", [["a", "pending"]]));
		handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(setStatus).toHaveBeenCalledWith("plan", undefined);
	});

	it("clears the marker when the plan is complete or absent", async () => {
		const { tools, handlers, ctx, setStatus } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(setStatus).toHaveBeenCalledWith("plan", undefined);

		await tools[0]?.execute("call-1", input("goal", [["a", "completed"]]));
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("plan", undefined);
	});

	it("'/plan <unknown>' notifies usage instead of replanning", async () => {
		const { commands, ctx, sendMessage, notify } = setup();
		await commands.get("plan")?.("shoe", ctx);
		expect(sendMessage).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("Unknown argument. Use /plan, /plan show, or /plan clear.", "warning");
	});

	it("completes show and clear arguments", () => {
		const { completions } = setup();
		const complete = completions.get("plan") as (prefix: string) => { value: string }[] | undefined;
		expect(complete).toBeDefined();
		expect(complete?.("").map((item) => item.value)).toEqual(["show", "clear"]);
		expect(complete?.("cl").map((item) => item.value)).toEqual(["clear"]);
		expect(complete?.("zz")).toBeNull();
	});

	it("does not reuse a previous run's stop reason (staleness regression)", async () => {
		const { tools, handlers, ctx, setStatus } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		await tools[0]?.execute("call-1", input("goal", [["a", "pending"]]));

		handlers.get("agent_end")?.({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("plan", "plan 0/1 · unfinished");

		handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, ctx);
		handlers.get("agent_settled")?.({ type: "agent_settled" }, ctx);
		expect(setStatus).toHaveBeenLastCalledWith("plan", undefined);
	});

	it("'/plan' sends a replan instruction that triggers a turn", async () => {
		const { commands, ctx, sendMessage } = setup();
		await commands.get("plan")?.("", ctx);
		expect(sendMessage).toHaveBeenCalledOnce();
		const [message, options] = sendMessage.mock.calls[0];
		expect(message.customType).toBe("plan-replan");
		expect(message.content).toContain("write_plan");
		expect(options).toEqual({ triggerTurn: true });
	});

	it("'/plan clear' wipes state durably and stops injection", async () => {
		const branch = [writeEntry(detailsOf(plan("goal", "a")))];
		const { commands, handlers, ctx, appendEntry, notify } = setup(branch);
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
		expect(agentStartInjected(handlers)).toContain("Goal: goal");

		await commands.get("plan")?.("clear", ctx);
		expect(appendEntry).toHaveBeenCalledWith("plan.cleared");
		expect(notify).toHaveBeenCalledWith("Plan cleared.", "info");
		expect(agentStartInjected(handlers)).toBeUndefined();

		// a later session_start reconstructs the cleared state from the branch
		const clearedBranch = [...branch, { type: "custom", customType: "plan.cleared" }];
		const clearedCtx = {
			sessionManager: { getBranch: () => clearedBranch },
			ui: { setWidget: vi.fn() },
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, clearedCtx);
		expect(agentStartInjected(handlers)).toBeUndefined();
	});

describe("widget and /plan show wiring", () => {
	it("refreshes the widget when session_start reconstructs a plan", () => {
		const branch = [writeEntry(detailsOf(plan("audit the machine", "a")))];
		const { handlers, ctx, setWidget } = setup(branch);
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
		expect(setWidget).toHaveBeenCalledWith("plan", ["plan 0/1 · audit the machine", "  [ ] a"], {
			placement: "aboveEditor",
		});
	});

	it("hides the widget when reconstruction finds no plan", () => {
		const { handlers, ctx, setWidget } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		expect(setWidget).toHaveBeenCalledWith("plan", undefined, { placement: "aboveEditor" });
	});

	it("refreshes the widget after write_plan tool results only", async () => {
		const { tools, handlers, ctx, setWidget } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);
		setWidget.mockClear();

		handlers.get("tool_result")?.({ type: "tool_result", toolName: "bash" }, ctx);
		expect(setWidget).not.toHaveBeenCalled();

		await tools[0]?.execute("call-1", input("goal", [["a", "in_progress"]]));
		handlers.get("tool_result")?.({ type: "tool_result", toolName: "write_plan" }, ctx);
		expect(setWidget).toHaveBeenCalledWith("plan", ["plan 0/1 · goal", "  [>] a"], {
			placement: "aboveEditor",
		});
	});

	it("hides the widget after '/plan clear'", async () => {
		const branch = [writeEntry(detailsOf(plan("goal", "a")))];
		const { commands, handlers, ctx, setWidget } = setup(branch);
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
		expect(setWidget).not.toHaveBeenCalledWith("plan", undefined, { placement: "aboveEditor" });

		await commands.get("plan")?.("clear", ctx);
		expect(setWidget).toHaveBeenLastCalledWith("plan", undefined, { placement: "aboveEditor" });
	});

	it("'/plan show' opens the overlay with the current plan", async () => {
		const branch = [writeEntry(detailsOf(plan("audit the machine", "a", "b")))];
		const { commands, handlers, ctx, custom } = setup(branch);
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);

		await commands.get("plan")?.("show", ctx);
		expect(custom).toHaveBeenCalledOnce();
	});

	it("'/plan show' without a plan notifies instead", async () => {
		const { commands, handlers, ctx, custom, notify } = setup();
		handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, ctx);

		await commands.get("plan")?.("show", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith("No active plan.", "info");
	});

	it("'/plan show' outside tui notifies with the snapshot text", async () => {
		const branch = [writeEntry(detailsOf(plan("goal", "a")))];
		const { commands, handlers, ctx, custom, notify } = setup(branch);
		handlers.get("session_start")?.({ type: "session_start", reason: "resume" }, ctx);
		(ctx as unknown as { mode: string }).mode = "json";

		await commands.get("plan")?.("show", ctx);
		expect(custom).not.toHaveBeenCalled();
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Goal: goal"), "info");
	});
});
});

describe("settle check (unit)", () => {
	it("flags unfinished plans only for clean stops", () => {
		const unfinished: PlanState = { goal: "g", steps: [{ content: "a", status: "in_progress" }] };
		expect(shouldFlagIncomplete(unfinished, "stop")).toBe(true);
		expect(shouldFlagIncomplete(unfinished, undefined)).toBe(false);
		expect(shouldFlagIncomplete(unfinished, "aborted")).toBe(false);
		expect(shouldFlagIncomplete(unfinished, "error")).toBe(false);
		expect(shouldFlagIncomplete(null, "stop")).toBe(false);
		expect(shouldFlagIncomplete({ goal: "g", steps: [{ content: "a", status: "completed" }] }, "stop")).toBe(
			false,
		);
	});

	it("formats progress into the footer marker", () => {
		expect(
			formatIncompleteStatus({
				goal: "g",
				steps: [
					{ content: "a", status: "completed" },
					{ content: "b", status: "pending" },
					{ content: "c", status: "in_progress" },
				],
			}),
		).toBe("plan 1/3 · unfinished");
	});
});

const testTheme = {
	fg: (_name: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function renderLines(component: { render(width: number): string[] }): string {
	return component
		.render(120)
		.map((line) => line.trimEnd())
		.join("\n");
}

describe("diffPlans", () => {
	it("treats a create as a goal line plus all steps added", () => {
		const diff = diffPlans(null, plan("goal", "a", "b"));
		expect(diff).toEqual([
			{ kind: "goal", content: "goal" },
			{ kind: "added", number: 1, content: "a", status: "pending" },
			{ kind: "added", number: 2, content: "b", status: "pending" },
		]);
	});

	it("detects status changes with the previous status", () => {
		const previous: PlanState = { goal: "g", steps: [{ content: "a", status: "pending" }] };
		const next: PlanState = { goal: "g", steps: [{ content: "a", status: "completed" }] };
		expect(diffPlans(previous, next)).toEqual([
			{ kind: "status", number: 1, content: "a", status: "completed", previousStatus: "pending" },
		]);
	});

	it("shows a reworded step as removed plus added", () => {
		const previous = plan("g", "old wording");
		const next = plan("g", "new wording");
		const diff = diffPlans(previous, next);
		expect(diff.map((l) => l.kind)).toEqual(["removed", "added"]);
		expect(diff[0]).toMatchObject({ content: "old wording", status: "pending" });
		expect(diff[1]).toMatchObject({ content: "new wording", number: 1 });
	});

	it("pairs duplicate contents greedily", () => {
		const previous: PlanState = {
			goal: "g",
			steps: [
				{ content: "dup", status: "completed" },
				{ content: "dup", status: "pending" },
			],
		};
		const next: PlanState = {
			goal: "g",
			steps: [
				{ content: "dup", status: "completed" },
				{ content: "dup", status: "in_progress" },
			],
		};
		expect(diffPlans(previous, next)).toEqual([
			{ kind: "status", number: 2, content: "dup", status: "in_progress", previousStatus: "pending" },
		]);
	});

	it("returns only a goal line when only the goal changed", () => {
		const previous = plan("old goal", "a");
		const next = plan("new goal", "a");
		expect(diffPlans(previous, next)).toEqual([{ kind: "goal", content: "new goal" }]);
	});

	it("returns an empty diff for identical plans", () => {
		const p = plan("g", "a", "b");
		expect(diffPlans(p, p)).toEqual([]);
	});
});

describe("summarizeDiff", () => {
	it("summarizes a cleared plan", () => {
		expect(summarizeDiff([], { goal: "", steps: [] })).toBe("plan cleared");
	});

	it("starts from progress counts and appends non-zero changes", () => {
		const next: PlanState = {
			goal: "g",
			steps: [
				{ content: "a", status: "completed" },
				{ content: "b", status: "in_progress" },
				{ content: "c", status: "pending" },
			],
		};
		const diff = [
			{
				kind: "status" as const,
				number: 1,
				content: "a",
				status: "completed" as const,
				previousStatus: "in_progress" as const,
			},
			{ kind: "added" as const, number: 3, content: "c", status: "pending" as const },
		];
		expect(summarizeDiff(diff, next)).toBe("1/3 done · +1 step · 1 updated");
	});

	it("shows only counts when nothing changed", () => {
		const next: PlanState = { goal: "g", steps: [{ content: "a", status: "completed" }] };
		expect(summarizeDiff([], next)).toBe("1/1 done");
	});
});

describe("plan renderers", () => {
	it("renderCall shows step count and goal", () => {
		const text = renderLines(renderPlanCall({ goal: "add feature", steps: [1, 2, 3] }, testTheme));
		expect(text).toContain("plan");
		expect(text).toContain("3 steps");
		expect(text).toContain("add feature");
	});

	it("collapsed renderResult shows the one-line summary", () => {
		const previous = plan("goal", "a");
		const next: PlanState = { goal: "goal", steps: [{ content: "a", status: "completed" }] };
		const text = renderLines(
			renderPlanResult({ content: [], details: { previous, plan: next } }, { expanded: false }, testTheme),
		);
		expect(text).toBe("plan: 1/1 done · 1 updated");
	});

	it("expanded renderResult shows changed lines with markers", () => {
		const previous = plan("old goal", "a", "b");
		const next: PlanState = {
			goal: "new goal",
			steps: [
				{ content: "a", status: "completed" },
				{ content: "c", status: "pending" },
			],
		};
		const text = renderLines(
			renderPlanResult({ content: [], details: { previous, plan: next } }, { expanded: true }, testTheme),
		);
		expect(text).toContain("~ goal: new goal");
		expect(text).toContain("~ 1. [ ]->[x] a");
		expect(text).toContain("- [ ] b");
		expect(text).toContain("+ 2. [ ] c");
	});

	it("falls back to result content without details", () => {
		const text = renderLines(
			renderPlanResult(
				{
					content: [{ type: "text", text: "Plan cleared." }],
					details: undefined,
				} as unknown as AgentToolResult<any>,
				{ expanded: false },
				testTheme,
			),
		);
		expect(text).toContain("Plan cleared.");
	});
});

describe("plan widget lines", () => {
	it("returns no lines without a plan or with all steps complete", () => {
		expect(planWidgetLines(null)).toEqual([]);
		expect(
			planWidgetLines({ goal: "g", steps: [{ content: "a", status: "completed" }] }),
		).toEqual([]);
	});

	it("shows a progress header and the unfinished steps", () => {
		const lines = planWidgetLines({
			goal: "audit the machine",
			steps: [
				{ content: "done step", status: "completed" },
				{ content: "active step", status: "in_progress" },
				{ content: "later step", status: "pending" },
			],
		});
		expect(lines).toEqual(["plan 1/3 · audit the machine", "  [>] active step", "  [ ] later step"]);
	});

	it("caps at eight unfinished steps with a more line", () => {
		const steps = Array.from({ length: 10 }, (_, i) => ({
			content: `step ${i + 1}`,
			status: "pending" as const,
		}));
		const lines = planWidgetLines({ goal: "g", steps });
		expect(lines).toHaveLength(10);
		expect(lines[9]).toBe("  ... +2 more");
	});
});


describe("PlanViewComponent", () => {
	it("renders goal, progress, and every step", () => {
		const component = new PlanViewComponent(
			{
				goal: "audit the machine",
				steps: [
					{ content: "done step", status: "completed" },
					{ content: "active step", status: "in_progress" },
				],
			},
			testTheme,
			() => {},
		);
		const text = component
			.render(100)
			.map((line) => line.trimEnd())
			.join("\n");
		expect(text).toContain("1/2 · audit the machine");
		expect(text).toContain("[x] done step");
		expect(text).toContain("[>] active step");
		expect(text).toContain("Press Escape to close");
	});

	it("closes on escape", () => {
		const onClose = vi.fn();
		const component = new PlanViewComponent(plan("g", "a"), testTheme, onClose);
		component.handleInput("\x1b");
		expect(onClose).toHaveBeenCalledOnce();
	});
});
