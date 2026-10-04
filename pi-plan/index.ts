/**
 * Plan extension: the agent's in-session execution working memory.
 *
 * Wires the write_plan tool (full rewrite, ADR 0002), reconstructs state from
 * the session branch, injects the current plan snapshot into the system
 * prompt on every agent run, lights a footer marker when a run settles with
 * unfinished steps (never auto-continues), and surfaces the plan to the user
 * (above-editor widget + `/plan show`). See DESIGN.md and the pi monorepo's
 * CONTEXT.md glossary.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatPlanSnapshot } from "./inject.ts";
import { PLAN_CLEAR_ENTRY_TYPE, PLAN_TOOL_NAME, readPlanFromBranch, type PlanState } from "./state.ts";
import { formatIncompleteStatus, shouldFlagIncomplete } from "./settle.ts";
import { createPlanToolDefinition } from "./tool.ts";
import { PlanViewComponent, planWidgetLines } from "./view.ts";

const REPLAN_MESSAGE =
	"Write or rewrite the execution plan for the current task now, before doing any further work: call write_plan with the goal and the complete step list.";

const WIDGET_KEY = "plan";

export default function planExtension(pi: ExtensionAPI): void {
	let plan: PlanState | null = null;
	let lastStopReason: string | undefined;

	const refreshWidget = (ctx: ExtensionContext): void => {
		const lines = planWidgetLines(plan);
		ctx.ui.setWidget(WIDGET_KEY, lines.length > 0 ? lines : undefined, { placement: "aboveEditor" });
	};

	const reconstruct = (ctx: ExtensionContext): void => {
		plan = readPlanFromBranch(ctx.sessionManager.getBranch());
		refreshWidget(ctx);
	};

	pi.on("session_start", (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", (_event, ctx) => reconstruct(ctx));

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName === PLAN_TOOL_NAME) {
			refreshWidget(ctx);
		}
	});

	pi.on("agent_end", (event) => {
		// The run's final assistant stopReason, fresh per run; undefined when the
		// run produced no assistant message.
		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message && message.role === "assistant") {
				lastStopReason = message.stopReason;
				return;
			}
		}
		lastStopReason = undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		const text =
			plan !== null && shouldFlagIncomplete(plan, lastStopReason)
				? ctx.ui.theme.fg("warning", formatIncompleteStatus(plan))
				: undefined;
		ctx.ui.setStatus("plan", text);
	});

	pi.registerTool(
		createPlanToolDefinition({
			getPlan: () => plan,
			setPlan: (next) => {
				plan = next;
			},
		}),
	);

	pi.registerCommand("plan", {
		description: "Execution plan: '/plan' rewrites it, '/plan show' displays it, '/plan clear' retires it",
		getArgumentCompletions: (prefix) => {
			const completions = [
				{ value: "show", label: "show", description: "Display the current plan" },
				{ value: "clear", label: "clear", description: "Retire the current plan" },
			].filter((item) => item.value.startsWith(prefix));
			return completions.length > 0 ? completions : null;
		},
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (arg === "clear") {
				plan = null;
				pi.appendEntry(PLAN_CLEAR_ENTRY_TYPE);
				ctx.ui.setStatus("plan", undefined);
				ctx.ui.notify("Plan cleared.", "info");
				refreshWidget(ctx);
				return;
			}
			if (arg === "show") {
				if (plan === null) {
					ctx.ui.notify("No active plan.", "info");
					return;
				}
				if (ctx.mode !== "tui") {
					ctx.ui.notify(formatPlanSnapshot(plan), "info");
					return;
				}
				const current = plan;
				await ctx.ui.custom<void>((_tui, theme, _keybindings, done) => {
					return new PlanViewComponent(current, theme, () => done());
				});
				return;
			}
			if (arg !== "") {
				ctx.ui.notify("Unknown argument. Use /plan, /plan show, or /plan clear.", "warning");
				return;
			}
			pi.sendMessage({ customType: "plan-replan", content: REPLAN_MESSAGE, display: true }, { triggerTurn: true });
		},
	});

	pi.on("before_agent_start", (event) => {
		if (plan === null) return;
		event.systemPromptOptions.sections.plan_state = formatPlanSnapshot(plan);
	});
}
