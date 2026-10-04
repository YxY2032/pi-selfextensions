/**
 * Model-facing prompt copy for the plan extension: the write_plan tool
 * description (triggering criteria and discipline) and the system-prompt
 * guideline bullets. Kept deliberately tight — this text rides along with
 * every request, so every word is context tax.
 */

export const PLAN_TOOL_DESCRIPTION = `Create or update the execution plan: send the COMPLETE step list every time (full rewrite, not a delta); an empty list clears the plan. Use for tasks needing 3+ steps or many tool calls; skip for quick questions and single-file edits. Mark a step in_progress when starting it and completed only after verifying (for code changes, run the repo's check first). One verifiable outcome per step.`;

export const PLAN_TOOL_GUIDELINES = [
	"Advance plans serially: at most one or two steps in_progress at a time.",
	"Rewrite blocked steps with the unblocking path, or split them, instead of stalling.",
];
