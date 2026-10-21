# pi-drift-guard

A drift-prevention extension for [pi](https://github.com/earendil-works/pi) — prevents context drift in long-horizon tasks by maintaining an external navigation file and periodically re-presenting task goals. Without ever constraining the model.

## Problem

LLMs are stateless. "Memory" is the full conversation text resent on every call. In long tasks (hundreds of turns), four pathologies emerge:

| Pathology | Symptom |
|---|---|
| Dilution | Goal buried under tool outputs |
| Recency bias | Only the last few turns matter |
| Debt accumulation | Old direction persists after steering |
| One-way progress | Model never checks alignment |

**Solution**: A small authoritative state file (`PROGRESS.md`) outside the transcript. Code guarantees format. A metronome periodically places its content in front of the model. Whether to create it, what to record, whether to listen — the model's choice.

## How it works

```
User asks → Anchor injects Goal into system prompt
  ↓ ~15 tool calls
Reminder: "No nav file at <cwd>. Create one if this task is long enough."
  ↓ Model decides (may refuse for short tasks — this is by design)
PROGRESS.md created → Anchor switches to state form (same request, ADR-0006)
  ↓ Every 50 turns
[Navigation] "Stale for 50 turns. Goal: '...'. Previous Now (50 turns ago): '...'.
Read PROGRESS.md first, then update based on recent work."
  ↓ Model reads file → checkpoints → clocks reset → system goes silent
```

## Install

```bash
git clone https://github.com/YxY2032/pi-drift-guard.git ~/.pi/agent/pi-drift-guard
```

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "~/.pi/agent/pi-drift-guard/system-inject"
  ]
}
```

## Components

| File | What it does |
|---|---|
| `index.ts` | Anchor: injects Goal into system prompt; in-run form switch via `systemPromptOptions` live reference |
| `drift-guard.ts` | Checkpoint tool + metronome (dual-clock) + steer confirmation |
| `trace-probe.ts` | Dev probe: records what the model actually receives (opt-in `-e`) |
| `trace-report.mjs` | Session analyzer: compliance rate, nav evolution timeline |

### Anchor

Reads `PROGRESS.md` at run start and mid-run (when file first appears):

- **Guide form** (no file): skeleton template + location enforcement
- **State form** (file exists): title + Goal injected into system prompt tail

Constraints: only Goal enters the prompt (task-stable, preserves prefix cache); Now excluded (changes often, would destroy cache); untrusted project files blocked by trust gate.

### Checkpoint

Model calls it voluntarily. Content from model, format guaranteed by code:

```json
{
  "kind": "status",
  "status": "12/40 routes migrated, tests green",
  "results": "dual-read validated, 237 tests pass",
  "next": "1. Payment module  2. Cleanup old session utils"
}
```

Three-zone contract: managed sections (Goal/Now/Achievements/Next Steps) + **preservation zone** (model's custom sections carried verbatim) + review blocks (folded to 3).

### Metronome

Dual-clock separation:

- **Cadence clock** (when to speak): resets on delivery and on real updates → anti-bombing
- **Staleness baseline** (what number to say): only advanced by real file changes → the number never lies

All hints are fact chains with zero imperative verbs. Delivered via `sendMessage` to the user-role seat (model-must-read position). Non-compliance has zero consequences.

## Configuration

| Env | Effect |
|---|---|
| `PI_DRIFT_GUARD=off` | Disable entire system |
| `PI_DRIFT_HINT_CHANNEL=tail` | Fall back to old delivery channel (tool result tail) |

## Tests

```bash
cd system-inject
node system-inject.test.mjs   # 15 cases
node drift-guard.test.mjs     # 30 cases
```

Zero dependencies. Node >= 23.6.

## Design principles

> Don't constrain the model. Set boundaries, hold the general direction.

- Zero imperatives in all hints (enforced by test)
- Fire once per cadence period — never repeated, never escalated
- Refusal is real and exercised; "can be refused" is the proof of freedom
- The system's success condition is its own silence

## Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — full system overview
- [docs/adr/](./docs/adr/) — decision records with rejected alternatives

## License

MIT
