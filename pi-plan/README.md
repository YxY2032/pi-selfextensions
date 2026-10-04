# Plan Extension

The agent's in-session execution working memory for long-horizon tasks: a
`write_plan` tool the model uses to decompose a task into steps and advance
through them, with per-run system-prompt injection. When a run settles with
unfinished steps, the footer lights a marker — the extension never
auto-continues the agent; resuming stays your call.

- Flat step list (`pending` / `in_progress` / `completed`), full rewrite on
  every call (never incremental edits)
- State lives in the `details` of the last `write_plan` result on the current
  branch: branching/forking restores the right plan, and compaction cannot
  lose it (it prunes provider context, not session storage)
- The current plan is re-injected into the system prompt on every agent run
- When a run settles with unfinished steps, the footer lights
  `plan 2/4 · unfinished` — a marker only; the extension never auto-continues
  (resuming is your call)
- A persistent widget above the editor shows `plan 2/4 · goal` plus the
  unfinished steps (hidden when the plan is complete or absent)
- `/plan show` opens a full-plan overlay; `/plan` forces a replan;
  `/plan clear` retires the plan

Install as a local package (referenced in place, no copy — edits take effect
on the next pi start):

```bash
pi install /path/to/pi-plan
```

Publishable later via npm or git sources (`pi install npm:pi-plan`,
`pi install git:host/user/repo`). Do not co-load with pi's `plan-mode`
example (both register `/plan`).

See `DESIGN.md` for the full design, `TESTS.md` for the test map, and the
repo-root `CONTEXT.md` glossary (Plan / Goal / Step / Ticket / Plan Mode).
