/**
 * The settle check: after a run fully settles, unfinished plans light a
 * footer marker. The extension never auto-continues the agent — resuming
 * stays the user's decision (see docs/adr/0001-no-auto-continue.md).
 */

import { hasUnfinishedSteps, progressLabel, type PlanState } from "./state.ts";

/** Stop reasons that must not be flagged: user aborts and failed runs. */
const NON_FLAGGABLE_STOP_REASONS = new Set(["aborted", "error"]);

export function shouldFlagIncomplete(
	plan: PlanState | null,
	lastStopReason: string | undefined,
): boolean {
	if (plan === null || !hasUnfinishedSteps(plan)) {
		return false;
	}
	if (lastStopReason === undefined || NON_FLAGGABLE_STOP_REASONS.has(lastStopReason)) {
		return false;
	}
	return true;
}

export function formatIncompleteStatus(plan: PlanState): string {
	return `${progressLabel(plan)} · unfinished`;
}
