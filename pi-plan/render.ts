/**
 * Compact transcript rendering for write_plan: a one-line summary when
 * collapsed, changed lines only when expanded (DESIGN.md section 4).
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	countCompletedSteps,
	type PlanState,
	type PlanStepStatus,
	type PlanToolDetails,
	STATUS_MARKS,
} from "./state.ts";

export type PlanDiffLine =
	| { kind: "goal"; content: string }
	| { kind: "added"; number: number; content: string; status: PlanStepStatus }
	| { kind: "removed"; content: string; status: PlanStepStatus }
	| {
			kind: "status";
			number: number;
			content: string;
			status: PlanStepStatus;
			previousStatus: PlanStepStatus;
	  };

/**
 * Diff two plans by matching steps on exact content (multiset semantics, so
 * duplicate contents pair up greedily). Rewording a step therefore appears as
 * a removal plus an addition, which is exactly what the user should see.
 */
export function diffPlans(previous: PlanState | null, next: PlanState): PlanDiffLine[] {
	const lines: PlanDiffLine[] = [];
	if (previous === null || previous.goal !== next.goal) {
		lines.push({ kind: "goal", content: next.goal });
	}

	const pool = new Map<string, PlanStepStatus[]>();
	if (previous !== null) {
		for (const step of previous.steps) {
			const statuses = pool.get(step.content) ?? [];
			statuses.push(step.status);
			pool.set(step.content, statuses);
		}
	}

	const changes: PlanDiffLine[] = [];
	for (const [i, step] of next.steps.entries()) {
		const previousStatus = pool.get(step.content)?.shift();
		if (previousStatus === undefined) {
			changes.push({ kind: "added", number: i + 1, content: step.content, status: step.status });
		} else if (previousStatus !== step.status) {
			changes.push({
				kind: "status",
				number: i + 1,
				content: step.content,
				status: step.status,
				previousStatus,
			});
		}
	}

	const removals: PlanDiffLine[] = [];
	for (const [content, statuses] of pool) {
		for (const status of statuses) {
			removals.push({ kind: "removed", content, status });
		}
	}
	return [...lines, ...removals, ...changes];
}

/** Collapsed one-liner: progress counts plus non-zero change counts. */
export function summarizeDiff(diff: PlanDiffLine[], next: PlanState): string {
	if (next.steps.length === 0) {
		return "plan cleared";
	}
	let added = 0;
	let removed = 0;
	let statusChanges = 0;
	let goalChanged = false;
	for (const line of diff) {
		switch (line.kind) {
			case "goal":
				goalChanged = true;
				break;
			case "added":
				added += 1;
				break;
			case "removed":
				removed += 1;
				break;
			case "status":
				statusChanges += 1;
				break;
		}
	}
	const parts: string[] = [`${countCompletedSteps(next)}/${next.steps.length} done`];
	if (goalChanged) {
		parts.push("goal changed");
	}
	if (added > 0) {
		parts.push(`+${added} step${added > 1 ? "s" : ""}`);
	}
	if (removed > 0) {
		parts.push(`-${removed} step${removed > 1 ? "s" : ""}`);
	}
	if (statusChanges > 0) {
		parts.push(`${statusChanges} updated`);
	}
	return parts.join(" · ");
}

export function renderPlanCall(args: { goal: string; steps: unknown[] }, theme: Theme): Text {
	const goal = args.goal ? theme.fg("dim", ` · ${args.goal}`) : "";
	return new Text(
		theme.fg("toolTitle", theme.bold("plan ")) + theme.fg("muted", `${args.steps.length} steps`) + goal,
		0,
		0,
	);
}

export function renderPlanResult(
	result: AgentToolResult<PlanToolDetails>,
	options: { expanded: boolean },
	theme: Theme,
): Text {
	const details = result.details;
	if (details === undefined || details === null) {
		const first = result.content[0];
		return new Text(first?.type === "text" ? first.text : "", 0, 0);
	}

	const diff = diffPlans(details.previous, details.plan);
	if (!options.expanded) {
		return new Text(theme.fg("muted", `plan: ${summarizeDiff(diff, details.plan)}`), 0, 0);
	}

	const lines: string[] = [];
	for (const line of diff) {
		switch (line.kind) {
			case "goal":
				lines.push(theme.fg("accent", `~ goal: ${line.content}`));
				break;
			case "added":
				lines.push(theme.fg("success", `+ ${line.number}. ${STATUS_MARKS[line.status]} ${line.content}`));
				break;
			case "removed":
				lines.push(theme.fg("error", `- ${STATUS_MARKS[line.status]} ${line.content}`));
				break;
			case "status":
				lines.push(
					theme.fg(
						"accent",
						`~ ${line.number}. ${STATUS_MARKS[line.previousStatus]}->${STATUS_MARKS[line.status]} ${line.content}`,
					),
				);
				break;
		}
	}
	if (lines.length === 0) {
		lines.push(theme.fg("dim", summarizeDiff(diff, details.plan)));
	}
	return new Text(lines.join("\n"), 0, 0);
}
