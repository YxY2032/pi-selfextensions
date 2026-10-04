/**
 * Plan state types and branch reconstruction.
 *
 * The authoritative plan state is the `details` of the last write_plan tool
 * result on the current session branch (the todo.ts pattern): branch- and
 * fork-correct by construction, and unaffected by compaction, which prunes
 * provider context but never session storage.
 */

export const PLAN_TOOL_NAME = "write_plan";

/** CustomEntry type written by `/plan clear`; durable without an LLM round-trip. */
export const PLAN_CLEAR_ENTRY_TYPE = "plan.cleared";

export type PlanStepStatus = "pending" | "in_progress" | "completed";

export interface PlanStep {
	content: string;
	status: PlanStepStatus;
}

export interface PlanState {
	goal: string;
	steps: PlanStep[];
}

/** Details stored on every write_plan tool result. */
export interface PlanToolDetails {
	/** Plan before this write; used for diff rendering. Null when creating. */
	previous: PlanState | null;
	/** Plan after this write. Zero steps means the plan was cleared. */
	plan: PlanState;
}

const PLAN_STEP_STATUSES: ReadonlySet<string> = new Set<PlanStepStatus>(["pending", "in_progress", "completed"]);

/** Render mark per step status, shared by the snapshot and the diff renderer. */
export const STATUS_MARKS: Record<PlanStepStatus, string> = {
	pending: "[ ]",
	in_progress: "[>]",
	completed: "[x]",
};

export function countCompletedSteps(plan: PlanState): number {
	return plan.steps.filter((step) => step.status === "completed").length;
}

export function unfinishedSteps(plan: PlanState): PlanStep[] {
	return plan.steps.filter((step) => step.status !== "completed");
}

export function hasUnfinishedSteps(plan: PlanState): boolean {
	return unfinishedSteps(plan).length > 0;
}

/** Shared progress prefix, e.g. `plan 2/4`. */
export function progressLabel(plan: PlanState): string {
	return `plan ${countCompletedSteps(plan)}/${plan.steps.length}`;
}

export function isPlanState(value: unknown): value is PlanState {
	if (typeof value !== "object" || value === null) return false;
	const v = value as { goal?: unknown; steps?: unknown };
	if (typeof v.goal !== "string" || !Array.isArray(v.steps)) return false;
	return v.steps.every((step) => {
		if (typeof step !== "object" || step === null) return false;
		const s = step as { content?: unknown; status?: unknown };
		return typeof s.content === "string" && typeof s.status === "string" && PLAN_STEP_STATUSES.has(s.status);
	});
}

/** Minimal structural shape of a session branch entry; keeps reconstruction a pure function. */
export interface PlanBranchEntryLike {
	type: string;
	customType?: string;
	message?: { role?: string; toolName?: string; details?: unknown };
}

/**
 * Read the current plan from a session branch: writes and `/plan clear`
 * markers apply in branch order (last one wins); a write with zero steps
 * clears the plan (returns null).
 */
export function readPlanFromBranch(entries: readonly PlanBranchEntryLike[]): PlanState | null {
	let plan: PlanState | null = null;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === PLAN_CLEAR_ENTRY_TYPE) {
			plan = null;
			continue;
		}
		if (entry.type !== "message" || entry.message === undefined) continue;
		const msg = entry.message;
		if (msg.role !== "toolResult" || msg.toolName !== PLAN_TOOL_NAME) continue;
		const details = msg.details;
		if (details === null || details === undefined) continue;
		const written = (details as PlanToolDetails).plan;
		if (!isPlanState(written)) continue;
		plan = written.steps.length > 0 ? written : null;
	}
	return plan;
}
