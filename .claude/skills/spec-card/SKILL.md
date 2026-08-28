---
name: spec-card
description: Turn a rough Trello card into an agreed spec by putting questions to Max on the card itself. Use when asked to spec a card Max has moved to Ready, run a spec-me session, pick up the next card to spec, or read back answers left on a Trello card. Never picks from Backlog. Operates on the Switchboard board only.
allowed-tools: Bash, Read, Grep, Glob
---

# Spec a card

Converts a one-line Trello card into a spec Max has actually agreed to, by asking
questions **as comments on the card** and reading his answers back from the same card.
The card description becomes the spec document; the comment thread is the transcript.

**Read `PIPELINE.md` (next to this file) before your first `claim`.** It carries the rules
every phase on this board shares: the board model, the two lists that are Max's, the helper
and its commands, the claim/lock protocol, questionnaire mechanics, and how a phase ends.
This file carries only what is specific to the spec phase.

## This phase

| | |
|---|---|
| **Flag** | none — `--phase spec` is the script's default, so every command below omits it |
| **Claims** | `Ready` cards carrying **no phase label** |
| **Produces** | the `Spec` label, then back to `Ready` for plan-card |
| **Sentinel** | `🔍 Spec-me round N — M questions` |
| **Writes** | the card description and comments. **Never repo code.** |

```
./scripts/trello.py claim                     # claim the next card — START HERE
./scripts/trello.py release <id> <nonce>      # drop the claim when you stop
./scripts/trello.py comments <id>             # thread + questionnaire/answer split
./scripts/trello.py post-comment <id> <file>  # post a comment from a file
./scripts/trello.py set-desc <id> <file>      # replace the description
./scripts/trello.py move <id> "In Review"
./scripts/trello.py label <id> Spec
```

Pass `--phase plan` only if you are deliberately inspecting plan-card's queue.

## The loop

| # | Card at | Who | Action |
|---|---|---|---|
| 0 | `Backlog`, no label | **Max** | Decides the idea is worth speccing and **moves it to `Ready` himself** |
| 1 | `Ready`, no label | this skill | `claim` it (auto-moves to `In Progress`) |
| 2 | `In Progress` | this skill | Seed description, post round-1 questions → move to `In Review` |
| 3 | `In Review` | **Max** | Answers in a comment, then **moves the card to `Ready` himself** |
| 4 | `Ready`, no label | this skill | `claim` it again, read answers, update the spec |
| 5 | `In Progress` | this skill | Questions still open → go to step 2 (round *n+1*). None → final spec, add `Spec` label, move to `Ready`, stop |
| 6 | `Ready` + `Spec` | plan-card | Not this skill's card any more |

`mode: new` here means the card has no `Spec-me` questionnaire yet — post round 1, wherever
the card sat. On `stalled`, re-post rather than assuming consent; see `PIPELINE.md §5`.

## What makes a question worth asking

Read the code before writing questions. Use `Grep`/`Read` on the repo to answer everything
the repo can answer — asking Max what the codebase already states wastes the round and
erodes his trust in the loop.

On top of the general bar in `PIPELINE.md §6`, a spec question is about **observable
behaviour, scope, and edge cases — not implementation.** Mechanism is the plan skill's job;
do not ask which file or function to touch.

Cap each round at **8 questions**, grouped under short bold headings. Fewer, sharper
questions beat exhaustive ones — a round Max can clear in two minutes is a round he'll
actually clear. Prefer asking about: scope boundaries, what happens in the awkward case,
what the user sees, back-compat for existing sessions/DBs, and what "done" looks like.

Ask nothing you can decide yourself and state as an assumption.

```
🔍 Spec-me round 1 — 5 questions

Reply in one comment. Number your answers; skip any you don't care about and I'll
take the assumption in brackets. Then move the card to Ready.

**Scope**
1. Does this apply to every session row or only detached ones?
   [assume: every row]
2. ...

**Edges**
3. ...
```

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
4. Post a short closing comment (no sentinel) summarising what was agreed and noting any
   assumed-unanswered decisions.

Then stop. The card is the plan skill's.

## Never

`PIPELINE.md §9` applies in full. In particular, and specific to this phase:

- Pick up, claim, or move a card in `Backlog` — releasing one to `Ready` is Max's call alone.
- Move a card out of `In Review` — that is Max's move and the whole point of the loop.
- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Touch a card carrying `Spec` / `Plan` / `PR` / `Approved` — it is past this phase.
- Ask about mechanism, or re-ask a question Max deliberately skipped.
- Write repo code. This skill produces a spec, nothing else.
