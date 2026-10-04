/**
 * The write_plan tool: full-rewrite plan updates (see ADR 0002).
 *
 * applyWritePlan is the pure core (validation + result shaping); the exported
 * factory only wires it to the extension's in-memory state. Validation errors
 * are returned as normal tool results with guidance text so the model can
 * correct the write, following the todo.ts example convention.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { PLAN_TOOL_DESCRIPTION, PLAN_TOOL_GUIDELINES } from "./prompts.ts";
import { diffPlans, renderPlanCall, renderPlanResult, summarizeDiff } from "./render.ts";
import { PLAN_TOOL_NAME, type PlanState, type PlanStepStatus, type PlanToolDetails } from "./state.ts";

export const MAX_PLAN_STEPS = 20;
export const MAX_STEP_CONTENT_CHARS = 200;

const PlanStepSchema = Type.Object({
	content: Type.String({ description: "Imperative, single verifiable outcome." }),
	status: StringEnum(["pending", "in_progress", "completed"] as const, {
		description: "pending | in_progress | completed",
	}),
});

export const WritePlanParams = Type.Object({
	goal: Type.String({ description: "One line: what this plan accomplishes." }),
	steps: Type.Array(PlanStepSchema, {
		description: "The COMPLETE step list in execution order (full rewrite, not a delta). Empty list clears the plan.",
	}),
});

export interface WritePlanInput {
	goal: string;
	steps: { content: string; status: PlanStepStatus }[];
}

export interface WritePlanOutcome {
	ok: boolean;
	/** Plan after the write; null when cleared. Unchanged (=== current) when !ok. */
	next: PlanState | null;
	result: AgentToolResult<PlanToolDetails>;
}

export function applyWritePlan(current: PlanState | null, input: WritePlanInput): WritePlanOutcome {
	const error = (text: string): WritePlanOutcome => ({
		ok: false,
		next: current,
		result: {
			content: [{ type: "text", text: `Error: ${text}` }],
			details: { previous: current, plan: current ?? { goal: "", steps: [] } },
		},
	});

	if (input.steps.length > MAX_PLAN_STEPS) {
		return error(`plans are capped at ${MAX_PLAN_STEPS} steps; merge related steps into one verifiable outcome`);
	}
	for (const [i, step] of input.steps.entries()) {
		const content = step.content.trim();
		if (content.length === 0) {
			return error(`step ${i + 1} has empty content`);
		}
		if (content.length > MAX_STEP_CONTENT_CHARS) {
			return error(
				`step ${i + 1} exceeds ${MAX_STEP_CONTENT_CHARS} characters; make each step one verifiable outcome`,
			);
		}
	}
	const goal = input.goal.trim();
	if (input.steps.length > 0 && goal.length === 0) {
		return error("goal is required while the plan has steps");
	}

	if (input.steps.length === 0) {
		return {
			ok: true,
			next: null,
			result: {
				content: [{ type: "text", text: "Plan cleared." }],
				details: { previous: current, plan: { goal: "", steps: [] } },
			},
		};
	}

	const next: PlanState = {
		goal,
		steps: input.steps.map((step) => ({ content: step.content.trim(), status: step.status })),
	};
	const text =
		current === null
			? `Plan created (${next.steps.length} steps): ${goal}`
			: `Plan updated (${summarizeDiff(diffPlans(current, next), next)}): ${goal}`;
	return {
		ok: true,
		next,
		result: { content: [{ type: "text", text }], details: { previous: current, plan: next } },
	};
}

export interface PlanToolStateAccess {
	getPlan: () => PlanState | null;
	setPlan: (plan: PlanState | null) => void;
}

export function createPlanToolDefinition(
	access: PlanToolStateAccess,
): ToolDefinition<typeof WritePlanParams, PlanToolDetails> {
	return {
		name: PLAN_TOOL_NAME,
		label: "Plan",
		description: PLAN_TOOL_DESCRIPTION,
		promptGuidelines: PLAN_TOOL_GUIDELINES,
		parameters: WritePlanParams,
		renderCall: renderPlanCall,
		renderResult: renderPlanResult,
		async execute(_toolCallId, params) {
			const outcome = applyWritePlan(access.getPlan(), params);
			if (outcome.ok) {
				access.setPlan(outcome.next);
			}
			return outcome.result;
		},
	};
}
