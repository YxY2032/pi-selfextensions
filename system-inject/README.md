# pi-drift-guard — system-inject package

The pi extension package. Two files loaded at startup:

| File | Role |
|---|---|
| `index.ts` | Anchor (system prompt injection) + preamble |
| `drift-guard.ts` | Checkpoint tool + metronome + steer confirmation |

## Anchor (`index.ts`)

Reads `PROGRESS.md` from the working directory root on every run, and mid-run when the file first appears (ADR-0006):

| Condition | Anchor content |
|---|---|
| No file / empty / untrusted / `PI_DRIFT_GUARD=off` | Guide form (skeleton template) |
| File exists + project trusted | Title + Goal (capped at 800 chars) |

**Cache economics**: Only Goal enters the system prompt (task-stable → preserves prefix cache). Now is deliberately excluded (changes on every checkpoint → would invalidate cache).

**Trust gate**: Untrusted project file content never enters the system prompt (prevents repo-planted injection).

**In-run switch** (ADR-0006): When the file is created mid-run, the anchor switches from guide to state form on the next request — via live mutation of `systemPromptOptions.forceSystemPrompt`. No need to wait for the next `before_agent_start`.

## Checkpoint tool (`drift-guard.ts`)

Model calls it voluntarily. Content from the model, format guaranteed by code.

Three-zone structure contract (ADR-0003):

```
# Title              ← managed: carried through
## Goal              ← managed: carried through (cache red line)
## Now               ← managed: replaced by `status` param
## Achievements      ← managed: replaced by `results` param (omit = preserved)
## Next Steps        ← managed: replaced by `next` param (omit = preserved)
## <custom sections>  ← preservation zone: model's own tables/notes, carried verbatim
### Review #N        ← managed: appended on review, folded to 3, always at end
```

## Metronome (`drift-guard.ts`)

**Dual-clock separation**:

- **Cadence clock** (`lastStatusTurn`/`lastReviewTurn`): when to speak. Reset on delivery (anti-bombing) and on real updates.
- **Staleness baseline** (`lastNavWriteTurn`/`lastActualReviewTurn`): what number to say. Only advanced by real file changes (checkpoint or direct write). Hints never reset it.

**Priority** (at tool_result, same-turn dedup):
1. Steer confirmation (armed, one-shot)
2. Empty-doc review fact (no file + review due, every 100 turns)
3. Doc reminder (no file + ≥15 tool calls, once only)
4. Review (≥100 turns without)
5. Status (≥50 turns without)

**Delivery channel** (ADR-0004/0005): `pi.sendMessage()` with `triggerTurn: true` — lands as the last message in the array (user-role seat, model-must-read position). Fall back with `PI_DRIFT_HINT_CHANNEL=tail`.

**Hint format**: fact chain, zero imperatives (enforced by test T20):

```
[Navigation] Stale for 50 turns. Goal: "..." (from PROGRESS.md).
Previous Now (50 turns ago): "...". Progress since then is unrecorded and
may be lost on compaction. Read PROGRESS.md first to review progress,
then update based on the last 50 turns of work.
```

## Steer confirmation

When user sends a message mid-stream (`streamingBehavior === "steer"`):
1. `input` hook: arm
2. `message_start` hook: skip first user message (that's the original prompt); subsequent user + armed → mark
3. Next `tool_result`: one-time neutral hint (tail channel) quoting current Goal

## Dev tools (not auto-loaded)

| File | What |
|---|---|
| `trace-probe.ts` | Load with `-e` to record what the model actually receives (system markers, tool declarations, nav file snapshots). Read-only. |
| `trace-report.mjs` | Session analyzer: `--compliance` (hint compliance rate), `--nav` (nav evolution timeline), `--trace` (model-received markers). |

## Tests

```bash
node system-inject.test.mjs   # 15 cases (anchor, in-run switch, trust gate, cache)
node drift-guard.test.mjs     # 30 cases (checkpoint, metronome, steer, red lines)
```

Zero dependencies. Node >= 23.6. The test harness stubs `typebox` (provided by pi's virtual module at runtime) into a temp directory to keep the real extension directory free of `node_modules`.

## Key design decisions

See [docs/adr/](../docs/adr/) for full decision records with rejected alternatives.

| Decision | Rationale |
|---|---|
| Goal in prompt, Now out | Cache separation: Now changes per checkpoint, would invalidate all prefix cache |
| Fact-chain hints (zero imperatives) | Imperative "suggest calling checkpoint" had 2% compliance; fact chain achieves 93-100% |
| Dual-clock separation | Without it, the staleness number always equals the interval (hint resets it) — fact degrades to alarm |
| Message channel (user seat) | Same hint ignored 3× on tool result tail; 28/28 compliance on message channel |
| Preservation zone | Model's custom sections deleted twice by rebuilds before this contract |
| Read-before-record | Model reads full file before updating, ensuring context refresh and self-review |
| System never creates the file | "Only broadcast, never act" — crossing that line changes the trust model |
