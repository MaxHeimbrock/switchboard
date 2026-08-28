---
name: check-board
description: Check the Switchboard Trello board for work and hand the next card to the phase skill that owns it. Use when asked to check the board, see what work is waiting, pick up the next card, or work the queue without naming a phase. Dispatches to merge-card, build-card, plan-card or spec-card. Operates on the Switchboard board only.
allowed-tools: Bash, Skill
---

# Check the board

The front door to the pipeline. Reads the `Ready` queue once, works out which phase owns
the next card, and **invokes that phase's skill**. It does no Trello writes of its own — no
claim, no label, no move, no comment. Every decision about a card is made by the skill that
owns it.

Use this when Max has not named a phase ("check the board", "what's next", "pick something
up"). When he names one ("spec this", "merge it"), go straight to that skill instead.

## The two commands

```
./scripts/session-name.py board "checking the queue"   # rename the session — FIRST
./scripts/trello.py survey
```

Both are symlinks to the shared scripts in `.claude/scripts/`. `trello.py` loads
`~/.trello.env` itself — **never print `TRELLO_TOKEN`.** `survey` is phase-independent, so no
`--phase` flag.

`session-name.py` is `PIPELINE.md §0`, and this skill is the one case with no card to name
itself after: it renames before the survey, with the tag `board` and no run number. The phase
skill it dispatches to renames the session again over the top, to `[spec] <card>` and so on —
that is the intended end state, and this name is only what the row reads while the survey
runs or when the queue turns out to be empty.

**Read `PIPELINE.md` (next to this file) for the board model** — what the lists and labels
mean, and why `Backlog` and `In Review` are Max's. This file carries only the routing.

It returns, in one pass over the board:

| field | Means |
|---|---|
| `next` | The card to dispatch, with the `phase` and the `skill` that owns it — or `null` |
| `queue` | Every `Ready` card bucketed by owning phase, already in dispatch order |
| `unowned` | A `Ready` card no phase claims — see [Unowned cards](#unowned-cards) |
| `backlog` | How many ideas sit in `Backlog`. A count only; **never dispatched** |

`survey` is read-only and takes **no lock** — it is a router, not a claim. That is safe
because the skill it hands off to runs its own `claim`, which is the authoritative read.

## Priority — furthest along the pipeline first

| Order | Phase | Owning skill | Card in `Ready` carries |
|---|---|---|---|
| 1 | `merge` | **merge-card** | `Approved` |
| 2 | `pr` | **build-card** | `Plan` (first build) or `PR` (revision round) |
| 3 | `plan` | **plan-card** | `Spec` |
| 4 | `spec` | **spec-card** | no phase label |

Finish work before starting it. An `Approved` PR left unmerged holds `main` back and blocks
every branch cut after it; a reviewed PR left unrevised holds *Max* up; a fresh spec adds
another card in flight without finishing any. So merge drains before build, build before
plan, plan before spec — even when the spec queue is longer.

The order lives in `DISPATCH_ORDER` in the shared script, next to the phase table it orders.
Change it there, not here.

Phases never contend for a card: a card's phase is its **furthest** label, so exactly one
phase owns it. A card appearing in two buckets is a bug in the script, not a judgement call.

## What to do

1. Rename the session, then run `survey`.
2. **`next` is non-null** → invoke `next.skill` via the Skill tool, and let it run to
   completion. Nothing else: do not pre-read the card, claim it, or move it first.
3. **`next` is null** → report the queue is empty and stop. See below.

Then stop — **one card per run**. Do not survey again and dispatch the next phase in the
same run: each phase ends with the card back in Max's hands (`In Review`, or `Ready` for the
next phase), and chaining straight on would blow past that gate and bury four phases' work
in one unreviewable run. Say what ran, and that `/check-board` will take the next one.

### Hand-off is total

Once a phase skill is invoked, it owns the card and every rule about it — its own
questionnaire rounds, labels, moves, worktree and PR. Do not second-guess it, re-read the
card after it, or finish a step it chose to leave open.

If the skill reports no card (`{"card": null}`), another agent claimed it between the survey
and the claim. Report that and stop. Do **not** re-run `survey` to find another card — a
lost race means work is already in flight, which is the correct outcome.

### An empty queue is a result, not a problem

`next: null` means Max has released nothing. Report it plainly, along with the `backlog`
count and anything sitting in `In Progress` / `In Review` if that explains the quiet, and
stop.

Never fill an empty queue — `PIPELINE.md §2` is the rule, and it binds this skill hardest,
because this is the skill that goes looking for work. Report the `Backlog` count, never the
cards as candidates. Leave `In Review` alone however long it has sat. `In Progress` means
another run is live — a crashed run's card is reaped by the 15-minute stale-lock rule, not
by this skill.

### Unowned cards

A `Ready` card in `unowned` carries a label combination no phase recognises — only reachable
if the board gained a pipeline label the script does not know about. Do not guess a phase for
it and do not dispatch it. Name it in the report, dispatch `next` as normal, and stop.

## Reporting

Two or three lines, no ceremony: what the queue held, which skill you dispatched and to
which card, then that skill's own outcome. Example:

```
Board: 1 approved, 2 to build, 0 to plan, 1 to spec (+3 in Backlog).
Dispatched merge-card → "Guard resume when a session is live in another shell".
→ PR #12 squash-merged, card in Done. Run /check-board again for the next one.
```

## Never

`PIPELINE.md §9` applies in full. In particular, and specific to this skill:

- Claim, label, move, or comment on a card. This skill routes; the phase skills act.
- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Dispatch a card from `Backlog`, `In Progress`, `In Review` or `Done` — `survey` reads
  `Ready` and nothing else, and that is the whole trigger.
- Dispatch more than one card in a run, or dispatch a second phase after the first returns.
- Dispatch a phase whose queue is empty, or a card in `unowned`.
- Do a phase's work yourself — write a spec, a plan, repo code, or run a merge. If the
  owning skill cannot run, say so and stop.
- Touch any board but Switchboard.
