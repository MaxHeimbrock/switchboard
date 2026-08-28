---
name: grill-card
description: Turn a rough Trello card into an agreed spec by grilling Max with questions on the card itself. Use when asked to spec a backlog card, run a grill-me session, pick up the next card to spec, or read back answers left on a Trello card. Operates on the Switchboard board only.
allowed-tools: Bash, Read, Grep, Glob
---

# Grill a card into a spec

Converts a one-line Trello card into a spec Max has actually agreed to, by asking
questions **as comments on the card** and reading his answers back from the same card.
The card description becomes the spec document; the comment thread is the transcript.

All Trello access goes through `scripts/trello.py` — a symlink to the shared
`.claude/scripts/trello.py` that every phase skill uses. Run it from the skill directory or
by absolute path; it loads `~/.trello.env` itself. **Never print `TRELLO_TOKEN`.**

The script takes a `--phase` flag selecting which phase of the pipeline it works on. It
defaults to `spec`, which is this skill's phase, so every command below is written without
it. Pass `--phase plan` only if you are deliberately inspecting plan-card's queue.

```
./scripts/trello.py claim                     # claim the next card — START HERE
./scripts/trello.py release <id> <nonce>      # drop the claim when you stop
./scripts/trello.py pick                      # read-only peek, claims nothing
./scripts/trello.py card <id>                 # name, desc, list, labels
./scripts/trello.py comments <id>             # thread + questionnaire/answer split
./scripts/trello.py post-comment <id> <file>  # post a comment from a file
./scripts/trello.py set-desc <id> <file>      # replace the description
./scripts/trello.py move <id> "In Review"     # Backlog|Ready|In Progress|In Review|Done
./scripts/trello.py label <id> Spec           # Spec|Plan|PR
```

Write comment and description bodies to files in the scratchpad first, then pass the path.
Never build them as inline shell strings — the text is markdown with newlines and quotes.

## Board conventions

- **List = who holds the baton.** `Backlog` unpicked · `In Progress` an agent is working ·
  `In Review` waiting on Max · `Ready` groomed, next agent's turn · `Done` shipped.
- **Label = the last phase *completed*.** `Spec` → plan-card's turn. `Plan` → implement
  skill's turn. `PR` → open for review. No label → this skill's turn.

So a card is this skill's only when it carries **none** of those labels. `pick` enforces this.

## The loop

| # | Card at | Who | Action |
|---|---|---|---|
| 1 | `Backlog`, no label | this skill | Pick topmost → move to `In Progress` |
| 2 | `In Progress` | this skill | Seed description, post round-1 questions → move to `In Review` |
| 3 | `In Review` | **Max** | Answers in a comment, then **moves the card to `Ready` himself** |
| 4 | `Ready`, no label | this skill | `claim` it (auto-moves to `In Progress`), read answers, update the spec |
| 5 | `In Progress` | this skill | Questions still open → go to step 2 (round *n+1*). None → final spec, add `Spec` label, move to `Ready`, stop |
| 6 | `Ready` + `Spec` | plan-card | Not this skill's card any more |

### What `claim` hands you

Both `claim` and `pick` report a `mode` derived from the **comment thread**, not from the
list — Max may drop a card straight into `Ready` that was never grilled. Act on the mode,
not on the list:

| mode | Means | Do |
|---|---|---|
| `new` | No questionnaire on the card yet | Post round 1 (step 2), wherever the card sat |
| `resume` | Answers arrived since round *N* | Fold them in (step 4) |
| `stalled` | Round *N* posted, no answers since | Max moved it without answering — see below |

### The trigger is strict — never jump the gun

**Only `Backlog` and `Ready` cards are ever picked up.** A card in `In Review` belongs to
Max, however long it sits there and however many comments appear on it. Moving it to
`Ready` is Max's deliberate signal that the review round is finished; that decision is his
alone. Do not poll `In Review`, do not act on a new comment there, do not move it out
yourself.

### Claiming — always start with `claim`, never `pick`

`pick` is read-only, for peeking at the queue. It is **not** safe to act on: reading the
card and moving it are two round trips, so two agents can both read the same `Ready` card
before either moves it. Switchboard runs multiple sessions and fires scheduled tasks, so
this race is real, not theoretical.

`claim` closes it. It posts a lock comment *first*, re-reads the thread, and only proceeds
if its own lock is the oldest live one — Trello orders comments server-side, which is what
makes the winner decidable. The loser withdraws its lock and reports `{"card": null}`.
Verified with three concurrent claims on one card: one winner, two clean back-offs.

A claim gives you a `lock` nonce. **Release it before you stop**, in the same run:

```
./scripts/trello.py release <id> <nonce>
```

Release *before* the final `move` out of `In Progress`, so the card is never sitting in a
queue-eligible list with a stale lock on it. A lock left behind by a crashed run is reaped
automatically after 15 minutes, so a dropped release costs a delay, not a wedged card.

`claim` also moves the card to `In Progress` and skips any card that already holds a live
lock. `In Progress` is therefore the visible half of the mutex and the lock comment is the
authoritative half — never hand-move a card into `In Progress` to fake a claim, and never
leave a card parked there.

**On `stalled`:** do **not** write a spec from assumed defaults — a card arriving in
`Ready` with no answers at all is far more likely a misdrag than blanket consent. Re-post
the open questions as a fresh round, noting they are a repeat, move back to `In Review`,
and stop.

### Resolving a round — when can the spec be written?

The bar is **not** "every question got a reply". Round 1 promises Max that skipping a
question means taking the bracketed assumption, so re-asking a question he deliberately
skipped breaks that promise and the loop never terminates. Once *any* answer comes back,
every question in that round is resolved:

- **answered** → record the decision in `## Decisions`
- **skipped** → the bracketed assumption becomes the decision, recorded as
  `<decision> — round n, assumed (unanswered)` so he can spot and overturn it
- **deferred** — he explicitly says he doesn't know or wants to decide later → stays open
- **ambiguous** — the answer is unparseable, or contradicts one of his other answers →
  stays open, and round *n+1* quotes both back to him and asks which wins

Match answers by **content, not just by number** — Max may restart numbering per round
(round 2's question 7 came back as "1. Yes (a) is correct"). When a round has one question
the mapping is unambiguous; when it has several and the numbering looks off, treat the
mismatch as `ambiguous` rather than guessing.

Only `deferred` and `ambiguous` answers, plus genuinely new questions his answers raise,
carry into the next round. Everything else is settled. In practice most cards finish in one
round, and a second round should be one or two questions, not another six.

**Cap: 3 rounds.** At round 3, stop grilling and write the spec from what is decided,
listing whatever is still unresolved under a `## Risks` heading in the description and
calling it out in the closing comment. An endless questionnaire is worse than a spec with
two stated unknowns — the plan skill can raise them again with a concrete plan in hand.

## Comment format

Every questionnaire comment's **first line must be** `🔍 Grill-me round N — M questions`.
The helper detects rounds by that prefix, and this is load-bearing: the API token acts as
Max himself, so comments this skill posts are attributed to *him*. Authorship cannot
separate questions from answers — only the sentinel can. A questionnaire without it is
invisible to the next run, and its answers will never be found.

```
🔍 Grill-me round 1 — 5 questions

Reply in one comment. Number your answers; skip any you don't care about and I'll
take the assumption in brackets. Then move the card to Ready.

**Scope**
1. Does this apply to every session row or only detached ones?
   [assume: every row]
2. ...

**Edges**
3. ...
```

## What makes a question worth asking

Read the code before writing questions. Use `Grep`/`Read` on the repo to answer everything
the repo can answer — asking Max what the codebase already states wastes the round and
erodes his trust in the loop.

Each question must:

- **force a decision** that changes what gets built — not gather colour
- **carry a bracketed default assumption**, so silence is a safe answer
- **be answerable in a few words**, from a phone
- be about **observable behaviour, scope, and edge cases** — not implementation. Mechanism
  is the plan skill's job; do not ask which file or function to touch.

Cap each round at **8 questions**, grouped under short bold headings. Fewer, sharper
questions beat exhaustive ones — a round Max can clear in two minutes is a round he'll
actually clear. Prefer asking about: scope boundaries, what happens in the awkward case,
what the user sees, back-compat for existing sessions/DBs, and what "done" looks like.

Ask nothing you can decide yourself and state as an assumption.

## Description skeleton

The description is the spec doc. Maintain exactly these sections, in this order,
rewriting the whole description each time (`set-desc` replaces it):

```markdown
## Idea
<Max's original card text, preserved verbatim. If the card had none, the title.>

## Spec
<What will be built, in observable terms. Grows each round. Empty until round 1
answers land — write "_pending round 1_" before that.>

## Decisions
- <decision> — round <n>
- <decision> — round <n>, assumed (unanswered)
<Every settled point. Mark the ones taken from a skipped question's assumption so Max
can spot and overturn them.>

## Open questions
- [ ] <n>. <question still deferred or ambiguous>
<Empty list means the spec is finishable this round.>

## Risks
<Questions still open because the 3-round cap forced a finish, plus any implementation
hazard the plan skill needs warning about. Omit the section when there are neither.>
```

Preserve `## Idea` exactly once captured. Never drop a `## Decisions` entry.

## Finishing

When `## Open questions` is empty, or the 3-round cap is reached:

1. Write the final `## Spec` — complete enough that the plan skill needs no further input
   from Max: scope, behaviour, edge cases, out-of-scope, and acceptance criteria.
2. `label <id> Spec`
3. `release <id> <nonce>`, then `move <id> Ready` — in that order
4. Post a short closing comment (no sentinel — it is not a questionnaire) summarising what
   was agreed and noting any assumed-unanswered decisions.

Then stop. The card is the plan skill's.

## Never

- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Delete or edit any comment other than a lock comment (`claim` / `release` own those).
- Move a card out of `In Review` — that is Max's move and the whole point of the loop.
- Move a card to `Done`.
- Touch cards on any board but Switchboard, or cards carrying `Spec` / `Plan` / `PR`.
- Write repo code. This skill produces a spec, nothing else.
