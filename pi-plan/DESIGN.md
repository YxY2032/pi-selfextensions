# Plan Extension — Design

Status: agreed design, pre-implementation. Decisions settled in a grilling session (13 questions, answers recorded in ADRs 0001/0002 and root `CONTEXT.md` vocabulary).

## Problem, from first principles

Long-horizon tasks fail because the agent's working memory decays as context grows, and compaction rebuilds that memory exactly once, summarily, at the moment it is most at risk. The fix is not "more memory" but a small authoritative state store that lives outside the transcript and is re-presented to the model on every request.

The feature formalizes what pi already does implicitly: the compaction summarizer maintains a `## Progress / ## Next Steps` checklist inside summary text (see `packages/agent/src/harness/compaction/compaction.ts`). We make that checklist explicit, current, and model-writable.

## Relationship to existing examples

- `examples/extensions/todo.ts`: contributes the persistence pattern (state in tool-result `details` → branch/fork-correct reconstruction). Not reused as-is: its tool is incremental (add/toggle), superseded by ADR 0002.
- `examples/extensions/plan-mode/`: contributes widget/status patterns and test harness precedent. Different feature: read-only planning interaction (Plan Mode), not execution tracking (a Plan).

## Non-goals

- Nested or recursive subplans (flat list; re-decompose by rewriting the list)
- Cross-session persistence (that is the Ticket layer; see `CONTEXT.md`)
- Hard completion gates (soft gate only: prompt requires running the repo check before marking code steps completed)
- Ticket integration or synchronization
- Staleness-optimized injection (snapshot is small; inject every turn)
- Merging Plan Mode's read-only lockdown into this extension

## State model

```ts
interface PlanStep {
  content: string                    // imperative, one verifiable outcome
  status: "pending" | "in_progress" | "completed"
}

interface PlanState {
  goal: string                       // one line; rewritten when the objective changes
  steps: PlanStep[]                  // 0..20; [] = plan retired
}
```

Single source of truth: the `details` of the last `write_plan` tool result on the current session branch (todo.ts pattern). Properties this buys:

- Branch/fork correct: `/tree` navigation and forks restore the right state by construction.
- Compaction survivable: compaction prunes provider context, never session storage; reconstruction scans entries, not the transcript.
- One store, two consumers: the tool result is model-visible in-context; the same `details` feed the per-turn snapshot after compaction cuts the result out of context.

## Components

### 1. Tool: `write_plan`

Full-rewrite tool (ADR 0002). Schema (TypeBox):

```ts
Type.Object({
  goal:  Type.String({ description: "One line: what this plan accomplishes." }),
  steps: Type.Array(Type.Object({
    content: Type.String({ description: "Imperative, single verifiable outcome." }),
    status:  Type.Union([
      Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"),
    ]),
  }), { description: "The COMPLETE step list in execution order. Full rewrite, not a delta." }),
})
```

Validation in `execute` (reject with guidance, never guess):

- 1–20 steps (0 = explicit clear: plan retired; tool result confirms "Plan cleared.")
- non-empty `content` after trimming, ≤ 200 chars each
- goal required (after trimming) while steps exist; goal and step content are stored trimmed
- statuses within the enum

Tool result: agent-visible content is a short confirmation + diff summary (create: `Plan created (N steps): goal`; update: `Plan updated (1/3 done · +1 step · 1 updated): goal`), NOT the full list — the per-turn snapshot carries the full state. `details` carries `{ previous, plan }` for rendering and reconstruction (field named `plan`, not `next`, to match the CONTEXT.md vocabulary).

### 2. Per-turn snapshot injection

`before_agent_start` → mutate `event.systemPromptOptions` (follow `plan-mode/index.ts:201-247`):

```
<plan_state>
Goal: add a plan extension to pi
1. [x] Explore extension API surface
2. [>] Implement write_plan tool
3. [ ] Add settle marker
4. [ ] Tests for all five acceptance criteria
</plan_state>
```

Rules:

- Injected whenever a plan exists with ≥ 1 step.
- All-completed plan: inject one final turn with "all steps complete — report the result to the user, then clear the plan (write_plan with empty steps)". This is the retirement path; the model clears explicitly.
- Snapshot is built from stored `details`, never from transcript text, so compaction cannot break it.

### 3. Settle marker (no auto-continue)

On `agent_settled` (fires when a run has fully settled — no retry, compaction, or queued continuation pending): if the plan has pending/in_progress steps and the run's final assistant stopReason is not `aborted`/`error` (tracked via `message_end`), the footer shows a warning marker via `ctx.ui.setStatus("plan", "plan N/M · unfinished")`; otherwise the marker clears.

The extension never sends messages with `triggerTurn: true` on its own — resuming unfinished work stays the user's decision (see `docs/adr/0001-no-auto-continue.md`, decided in the philosophy review). An earlier revision auto-nudged up to 3 times per plan; that mechanism was removed as a sovereignty violation.

### 4. Rendering

`renderCall`/`renderResult` (per-tool, resolved by name; see `core/tools/renderers/edit.ts` + `diff.ts` precedent):

- Collapsed (default): one line — "plan: 2/5 done · +1 step · 1 updated" (counts only).
- Expanded (F-key/click, existing `expanded` toggle): diff of changed lines only, `[x]/[>]/[ ]` markers, success/error/accent colors per change kind.

Phase 2 (delivered, view.ts): `ctx.ui.setWidget("plan", lines, { placement: "aboveEditor" })` live panel — `plan done/total · goal` header plus unfinished steps (max 8 + a `... +N more` line), refreshed on session reconstruction, write_plan tool results, and `/plan clear`; hidden when the plan is complete or absent. `/plan show` opens a full-plan overlay (todo.ts overlay pattern, Escape closes); outside tui it falls back to a notify with the snapshot text.

### 5. Command: `/plan`

- `/plan` — injects a message instructing the model to write/rewrite the plan now for the current task (manual trigger path). Unknown arguments notify usage instead of replanning. Argument completion for `show` and `clear`.
- `/plan clear` — wipes state directly, no LLM round-trip. Durability: appends a `plan.cleared` CustomEntry (CustomEntries don't enter LLM context but persist in the journal), and `readPlanFromBranch` applies writes and clear markers in branch order — so resume/fork after a manual clear stays cleared.
- Do not co-load with `plan-mode/` (both register `/plan`; collisions demote rather than override).

### 6. Prompt copy (lives in `prompts.ts`)

Tool `description` (model-facing; kept tight because it rides along with every request — context tax, trimmed in the philosophy review):

> Create or update the execution plan: send the COMPLETE step list every time (full rewrite, not a delta); an empty list clears the plan. Use for tasks needing 3+ steps or many tool calls; skip for quick questions and single-file edits. Mark a step in_progress when starting it and completed only after verifying (for code changes, run the repo's check first). One verifiable outcome per step.

`promptGuidelines` (system-prompt rules section): serial advancement preferred (one, at most two, steps in_progress); blocked steps get rewritten or split, not stalled.

## Files

```
(standalone package, installed via `pi install <path-to-this-dir>`)
  index.ts     default-export factory; wires components below
  state.ts     PlanState types + authority store (branch scan / resume reconstruction)
  tool.ts      write_plan schema, validation, execute, details
  inject.ts    snapshot text + before_agent_start hook
  settle.ts    agent_settled footer marker (no auto-continue)
  render.ts    diff computation + renderCall/renderResult
  prompts.ts   tool description + prompt guidelines text
test/plan-extension.test.ts
```

## Tests (acceptance criteria → cases)

Implemented as unit tests over a mocked `ExtensionAPI` in `test/plan-extension.test.ts` (the `plan-mode-extension.test.ts` precedent), not the harness/faux-provider integration originally sketched here. Follow-ups still owed: a compaction integration test through the real session manager, and a tmux smoke test with a real model.

1. **Plan mechanics + guidance**: `write_plan` (4 steps) → tool result ok, state persisted; next run's system prompt options contain the `plan_state` snapshot. Negative: no `write_plan` → no snapshot; guidance bullets registered with the tool. (Whether a real model judges a task "complex" is model behavior — tmux smoke, not unit tests.)
2. **Compaction + resume**: reconstruction reads `details` from the branch, not transcript text, so compaction cannot break it — covered by `readPlanFromBranch` unit tests plus the wiring test that `session_start` re-injects from branch entries. Real-compaction integration test: follow-up.
3. **Settle marker**: run settles with pending steps → footer `plan N/M · unfinished`, no message sent (no auto-continue); complete/absent plans and aborted/errored runs clear the marker.
4. **Renderer**: unit-tested diff function (added / removed / reword / status-change lines) and the collapsed one-liner.
5. **Commands**: `/plan` injects the replan instruction; `/plan clear` wipes state durably and stops injection.

## Implementation-time verification points

- Exact turn-end event name (extension event union, `types.ts:1087-1115`).
- Whether `ctx.sessionManager.getEntries()` is branch-scoped; if not, follow `todo.ts:114-133` reconstruction exactly.
- `ToolDefinition.promptGuidelines` vs `promptSnippet` semantics (`types.ts:452-501`).
- Faux-provider tool-call scripting shape in `test/suite/harness.ts`.
- `RegisteredCommand.getArgumentCompletions` for `/plan` argument completion.

## Enabling

Install as a local package: `pi install <path>` writes it to settings `packages[]` and references it in place (no copy), so source edits apply on next start. `-l` installs project-scoped. Extension-only code: no pi core files touched (ADR 0001). The ADR-0001 file lives in the pi monorepo checkout at `docs/adr/0001-plan-tracking-as-extension.md`.
