/**
 * Snapshot formatting for per-run system-prompt injection.
 *
 * The snapshot is rebuilt from stored state on every agent run, so compaction
 * (which prunes provider context, never session storage) cannot break it.
 */

import { type PlanState, STATUS_MARKS, hasUnfinishedSteps } from "./state.ts";

/**
 * Render the plan as the body of the system-prompt `plan_state` section.
 * A fully completed plan carries the retirement instruction.
 */
export function formatPlanSnapshot(plan: PlanState): string {
	const lines: string[] = [`Goal: ${plan.goal}`];
	for (const [i, step] of plan.steps.entries()) {
		lines.push(`${i + 1}. ${STATUS_MARKS[step.status]} ${step.content}`);
	}
	if (!hasUnfinishedSteps(plan)) {
		lines.push("");
		lines.push(
			"All steps complete - report the result to the user, then clear the plan by sending write_plan with an empty steps list.",
		);
	}
	return lines.join("\n");
}
