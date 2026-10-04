/**
 * User-facing views of the current plan: the persistent editor widget lines
 * and the `/plan show` overlay component (the todo.ts overlay pattern).
 */

import { Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { countCompletedSteps, progressLabel, STATUS_MARKS, unfinishedSteps, type PlanState } from "./state.ts";

/** Widget cap is 10 lines total (interactive-mode MAX_WIDGET_LINES). */
const MAX_WIDGET_STEPS = 8;

/**
 * Lines for the persistent above-editor widget: header (progress + goal) and
 * the unfinished steps. Returns [] when there is nothing to show, so callers
 * pass undefined to setWidget and hide the widget entirely.
 */
export function planWidgetLines(plan: PlanState | null): string[] {
	if (plan === null) {
		return [];
	}
	const unfinished = unfinishedSteps(plan);
	if (unfinished.length === 0) {
		return [];
	}
	const lines: string[] = [`${progressLabel(plan)} · ${plan.goal}`];
	for (const step of unfinished.slice(0, MAX_WIDGET_STEPS)) {
		lines.push(`  ${STATUS_MARKS[step.status]} ${step.content}`);
	}
	if (unfinished.length > MAX_WIDGET_STEPS) {
		lines.push(`  ... +${unfinished.length - MAX_WIDGET_STEPS} more`);
	}
	return lines;
}

/** Full-plan overlay shown by `/plan show`. Press Escape or ctrl+c to close. */
export class PlanViewComponent {
	private plan: PlanState;
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(plan: PlanState, theme: Theme, onClose: () => void) {
		this.plan = plan;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const th = this.theme;
		const lines: string[] = [];

		lines.push("");
		const title = th.fg("accent", " Plan ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		const done = countCompletedSteps(this.plan);
		lines.push(
			truncateToWidth(`  ${th.fg("muted", `${done}/${this.plan.steps.length} · ${this.plan.goal}`)}`, width),
		);
		lines.push("");

		for (const step of this.plan.steps) {
			const mark = STATUS_MARKS[step.status];
			const text =
				step.status === "completed"
					? th.fg("dim", `${mark} ${step.content}`)
					: th.fg("text", `${mark} ${step.content}`);
			lines.push(truncateToWidth(`  ${text}`, width));
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}
