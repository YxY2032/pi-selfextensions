# Plan Extension — Test Documentation

How the plan extension is tested, updated each implementation round.
Run from this package:

```bash
npm test
```

This package is standalone (migrated out of the pi monorepo); its only test
suite is the one above.

## Review round (post code-review)

Standards/spec review fixes, all still 52 tests passing:

- extracted `countCompletedSteps` + `STATUS_MARKS` into `state.ts` (three-way
  duplication)
- `PlanDiffLine` became a discriminated union (removed unreachable
  `?? "pending"` fallbacks)
- direct `renderCall`/`renderResult` references instead of pass-throughs
- prompt copy moved to `prompts.ts` per the DESIGN file list
- update result text now carries the diff summary
- `/plan` argument completion for `clear`
- nudge copy sanctions stopping ("say so and stop, leaving steps pending")
- remaining `as any` in tests replaced with `as unknown as` casts
- documented deviations in DESIGN.md: `details.plan` naming, simplified nudge
  condition, durable `plan.cleared` marker, trim/goal validation

## Design acceptance criteria

The five criteria from `DESIGN.md`, and where each is covered:

1. Complex tasks create a plan; simple tasks do not → mechanics tested per round; the "is this task complex" judgment is model behavior, verified by tmux smoke testing, not unit tests.
2. Plan survives compaction + session resume → `readPlanFromBranch` (state.ts) + injection tests.
3. Premature wrap-up triggers the nudge exactly once per run end, capped at 3 → nudge tests.
4. Compact transcript rendering (diff-style) → renderer/diff unit tests.
5. `/plan` manual replan and `/plan clear` → command tests.

## Round 1 — state.ts (`describe("isPlanState")`, `describe("readPlanFromBranch")`)

The authoritative plan state is the `details` of the last `write_plan` tool
result on the current session branch. `readPlanFromBranch` is a pure function
over that branch so it can be tested without a session manager.

- `isPlanState` accepts valid plans, accepts zero-step plans (the cleared
  representation), and rejects non-objects, missing fields, and steps with
  invalid shape or status (reconstructed JSON is untrusted input).
- `readPlanFromBranch`:
  - returns null for an empty branch
  - ignores entries that are not `write_plan` tool results (usage entries,
    user/assistant messages, other tools' results)
  - returns the plan from a single write
  - lets the last write win across multiple writes
  - treats a zero-step write as clearing the plan (null)
  - skips malformed details (undefined, null, invalid plan) and falls back to
    the last valid write

## Round 2 — tool.ts (`describe("applyWritePlan")`, `describe("createPlanToolDefinition")`)

`applyWritePlan` is the pure core of the `write_plan` tool: validation plus
result shaping. The factory wires it to the extension's state access object.

- create: builds the plan from a null current, result text `Plan created (N steps)`,
  `details.previous` null
- update: progress counts in the result text (`1/2 done`), previous linked
- clear: empty steps list returns ok with `next === null` and `Plan cleared.`
- rejections leave the plan unchanged and return guidance text: step cap
  (20), empty content (with step number), overlong content (200 chars),
  missing goal on a non-empty plan
- goal and step content are trimmed
- error details are state-neutral: reconstructing from an error result's
  details yields the unchanged current plan
- `execute` updates state through `setPlan` only on successful writes

## Round 3 — inject.ts + index.ts (`describe("snapshot formatting")`, `describe("plan extension wiring")`)

Snapshot injection rebuilt from stored state on every agent run.

- `hasUnfinishedSteps` / `formatPlanSnapshot`: goal line, 1-based numbering,
  `[x]/[>]/[ ]` marks; the retirement instruction appears only on a
  fully-completed plan
- wiring: registers exactly `write_plan` with prompt guidelines
- wiring: no plan → `before_agent_start` leaves `sections.plan_state` unset
- wiring: `session_start` reconstructs from the branch and the snapshot is
  injected into `systemPromptOptions.sections.plan_state`
- wiring: `session_tree` re-reconstructs (branch navigation restores that
  branch's plan)
- closed loop: tool writes flow into the next injected snapshot
  (create → progress → clear stops injection)

## Round 4 — render.ts (`describe("diffPlans")`, `describe("summarizeDiff")`, `describe("plan renderers")`)

Diff semantics: steps match on exact content (multiset, greedy pairing), so a
reworded step shows as a removal plus an addition.

- create = goal line + all steps added; goal-only change = single goal line
- status changes carry the previous status
- duplicate contents pair greedily
- identical plans produce an empty diff
- collapsed renderer: one-line summary (`1/3 done · +1 step · 1 updated`,
  `plan cleared`)
- expanded renderer: changed lines with `~`/`+`/`-` markers and `[x]/[>]/[ ]`
- renderer falls back to result content when details are missing

## Round 5 — nudge.ts (`describe("nudge guard (unit)")` + wiring tests)

- nudge message includes unfinished/total counts
- ignored: absent plan, completed plan, `aborted` or `error` stop reasons
- nudges once per settled run, caps at 3, then `gave-up` (no fourth send)
- wiring: `agent_settled` + unfinished plan → `sendMessage` with
  `customType: "plan-nudge"`, `triggerTurn: true`
- wiring: the incomplete footer marker appears only after giving up; a
  `write_plan` resets the counter and nudging resumes

## Round 6 — /plan command (wiring tests + `readPlanFromBranch` ordering)

`/plan` sends a replan instruction (`customType: "plan-replan"`) that triggers
a turn; `/plan clear` retires the plan without an LLM round-trip by appending
a `plan.cleared` CustomEntry.

- `readPlanFromBranch` applies writes and clear markers in branch order
- wiring: `/plan` → replan message with `triggerTurn: true`
- wiring: `/plan clear` → `appendEntry("plan.cleared")`, notification,
  injection stops; a later `session_start` reconstructs the cleared state



## Round 7 — view.ts (`describe("plan widget lines")`, `describe("widget and /plan show wiring")`, `describe("PlanViewComponent")`)

- `planWidgetLines`: [] without a plan or when all steps complete (widget
  hidden); header `plan done/total · goal` plus unfinished steps with marks;
  capped at eight steps with a `... +N more` line (10-line widget budget)
- wiring: widget refreshed on session_start/session_tree reconstruction and
  after `write_plan` tool results (other tools do not refresh it); hidden
  after `/plan clear`
- wiring: `/plan show` opens the overlay; without a plan it notifies;
  outside tui it notifies with the snapshot text
- `PlanViewComponent`: renders goal, progress, every step, and the close
  hint; closes on escape

## Round 8 — philosophy review fixes (settle.ts replaces nudge.ts)

Two findings from the harsh philosophy assessment (context tax, auto-continue):

- tool description halved (~130 → ~65 words); the verify guideline folded
  into the description and dropped from `promptGuidelines` (dedupe)
- auto-nudge removed entirely: `agent_settled` now only lights the footer
  marker `plan N/M · unfinished` (or clears it); no `triggerTurn` from the
  extension, no counter, no cap. Decision recorded in
  `docs/adr/0001-no-auto-continue.md`
- `describe("settle check (unit)")`: flags unfinished plans only on clean
  stops; formats the progress marker
- wiring: unfinished plan + clean stop → footer marker, no sendMessage;
  aborted/errored/complete/absent → marker cleared

## Round 9 — code-review fixes

Findings from the two-axis code review (defects + structure + doc accuracy):

- `lastStopReason` now read fresh per run from `agent_end` messages (replaces
  the never-reset `message_end` tracking); a run with no assistant message
  (early abort/error) clears the marker instead of flagging — semantics
  tightened in `shouldFlagIncomplete` (undefined stopReason → no flag) with a
  staleness regression test
- `/plan <unknown-arg>` notifies usage instead of silently replanning with a
  triggered turn
- stale copy contradicting ADR 0001 fixed in three places (README bullet,
  package.json description, index.ts header); DESIGN corrected (collapsed
  example counts, no "dim for completed", completions cover show+clear,
  stopReason source documented)
- `hasUnfinishedSteps`/`unfinishedSteps`/`progressLabel` moved into state.ts
  (settle no longer imports from the prompt-formatting module); duplicated
  progress prefix and unfinished predicate removed
- unreachable zero-step guard removed from before_agent_start
- new tests: unknown-arg usage notice, argument completions, staleness
  regression
