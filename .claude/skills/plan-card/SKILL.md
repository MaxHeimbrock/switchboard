---
name: plan-card
description: Turn an agreed spec on a Trello card into an implementation plan written into the card description. Use when asked to plan a specced card, pick up the next card to plan, produce an implementation plan from a Trello spec, or fold Max's planning answers back into a plan. Operates on the Switchboard board only.
allowed-tools: Bash, Read, Grep, Glob
---

# Plan a specced card

Takes a card whose spec Max has already agreed to (label `Spec`, sitting in `Ready`) and
writes the implementation plan into a `## Plan` section of the same card description.
Mechanism is this skill's job — the spec says *what* and *why*, the plan says *how*.

Most cards should finish in one pass with no questions. Questions exist for the choices
the spec deliberately left open, not as a second spec round.

**Read `PIPELINE.md` (next to this file) before your first `claim`.** It carries the rules
every phase on this board shares: the board model, the two lists that are Max's, the helper
and its commands, the claim/lock protocol, questionnaire mechanics, and how a phase ends.
This file carries only what is specific to the plan phase.

## This phase

| | |
|---|---|
| **Flag** | **`--phase plan`** on every queue command — without it you get the spec phase's view |
| **Claims** | `Ready` cards carrying `Spec` and not `Plan` / `PR` / `Approved` |
| **Produces** | the `Plan` label, then back to `Ready` for build-card |
| **Sentinel** | `🧭 Plan-me round N — M questions` |
| **Writes** | the card description and comments. **Never repo code.** |

```
./scripts/trello.py --phase plan claim         # claim the next card — START HERE
./scripts/trello.py release <id> <nonce>       # drop the claim when you stop
./scripts/trello.py --phase plan comments <id> # thread + questionnaire/answer split
./scripts/trello.py post-comment <id> <file>   # post a comment from a file
./scripts/trello.py set-desc <id> <file>       # replace the description
./scripts/trello.py move <id> "In Review"
./scripts/trello.py label <id> Plan
```

## The loop

| # | Card at | Who | Action |
|---|---|---|---|
| 1 | `Ready` + `Spec` | this skill | `claim` topmost (auto-moves to `In Progress`) |
| 2 | `In Progress` | this skill | Read spec + code. No questions → write plan, label `Plan`, move to `Ready`, done |
| 3 | `In Progress` | this skill | Questions needed → write partial plan, post round-*n* questions → move to `In Review` |
| 4 | `In Review` | **Max** | Answers in a comment, then **moves the card to `Ready` himself** |
| 5 | `Ready` + `Spec` | this skill | `claim` it, fold answers in → step 2 or step 3 (round *n+1*) |
| 6 | `Ready` + `Plan` | build-card | Not this skill's card any more |

Only `Plan-me` comments count towards `mode`. The whole `Spec-me` thread above them is
history to this phase and is never read as an answer.

## Grounding the plan — read the code first

A plan that names a file that does not exist is worse than no plan: build-card will
follow it. Before writing a single step:

1. Read the whole card description — `## Spec` is the contract, `## Decisions` are settled
   and must not be re-opened, `## Risks` is a direct message from spec-card to you.
2. Find the real code with `Grep`/`Glob`, then `Read` it. Follow the call chain end to end —
   the caller, the state it mutates, the consumers of that state.
3. **Verify every path, symbol and line number you write down.** If you cite
   `main.js:1155`, you have read line 1155 in this run.
4. Work out what the change breaks: persisted data, IPC contracts, other callers, anything
   that reads a field you are deleting. The spec's `## Risks` names some of these; find the
   rest yourself.

## When to ask, and when to just decide

**Bias hard towards deciding.** You were given the mechanism to choose; choosing is the job.
Write the decision into the plan and move on. A card that needs no questions should go
straight from `claim` to `Ready` with a `Plan` label in one run — that is the common case.

Ask only when the choice:

- is **visible to Max as a user** and the spec did not settle it (what the UI does in a case
  the spec skipped, what an existing session sees after the change), **or**
- is **expensive to reverse** — a schema change, a data migration, deleting persisted data,
  a public IPC or file-format contract, **or**
- was **explicitly punted** to you by the spec's `## Risks`, **or**
- has two credible approaches with a real cost/benefit split you cannot settle from the
  code — say so and name both.

Never ask about: which file to touch, naming, test structure, code style, or anything the
repo already answers. Never re-litigate a `## Decisions` entry.

**Cap 5 questions per round, 3 rounds.** Question rules and round resolution are in
`PIPELINE.md §6`; record answers as `<decision> — plan round n`.

```
🧭 Plan-me round 1 — 2 questions

Spec's agreed; these are the two build choices I can't call myself. Reply in one comment,
number your answers, skip any you don't care about and I'll take the assumption in
brackets. Then move the card to Ready.

1. Drop the `forkFrom` column outright, or leave it in place unread?
   [assume: leave it — no migration]
2. ...
```

## Description skeleton

The description is the working doc, shared with the spec phase. Rewrite the whole thing each
time (`set-desc` replaces it), keeping exactly these sections in this order:

```markdown
## Idea
<unchanged — never touch>

## Spec
<unchanged — never touch. If the code contradicts the spec, say so in ## Risks and plan
what the spec asks for; changing the contract is Max's call, not yours.>

## Decisions
<Every spec-phase entry preserved verbatim, then your plan-phase entries appended:>
- <decision> — plan round <n>
- <decision> — plan round <n>, assumed (unanswered)

## Plan
<Written by this skill — see below. "_pending round 1_" only if you genuinely cannot draft
anything before Max answers; usually you can draft most of it and flag the open bit.>

## Open questions
- [ ] <n>. <plan question still deferred or ambiguous>
<`_none — plan complete_` when finished.>

## Risks
<Spec-phase risks you have now resolved get struck through or rewritten with the answer.
Add: anything build-card must not get wrong, plus anything left open by the
3-round cap. Omit the section only if there is genuinely nothing.>
```

Preserve `## Idea`, `## Spec`, and every existing `## Decisions` entry **verbatim**.

## What goes in `## Plan`

```markdown
## Plan
**Approach.** <2–4 sentences: the shape of the change and why this shape rather than the
obvious alternative.>

**Touches**
- `path/file.js` — <what changes here>
- `public/app.js:412` — <what changes here>

**Steps**
1. **<short imperative title>** — `path/file.js:120–148`
   <What to change, concretely enough to act on without re-deriving it. Name the symbols.>
   *Verify:* <the check that proves this step landed>
2. ...

**Verification**
- <command, or the manual check that proves each acceptance criterion in the spec>

**Not doing**
- <the tempting adjacent change this plan deliberately leaves alone, and why>
```

Rules for the steps:

- **Ordered so the tree is coherent between steps** — no step leaves a dangling reference
  the next one happens to fix.
- **Right-sized**: each step is one reviewable change with its own verification. A step
  nobody can check is too big; a step that only renames a variable is too small.
- **Concrete**: symbols and line ranges, not "update the handler" — build-card should
  not have to re-do your search.
- **Complete against the spec**: every acceptance criterion in `## Spec` is reachable by
  following the steps, and `**Verification**` proves each one.

## Finishing

When `## Open questions` is empty, or the 3-round cap is reached:

1. `set-desc` with the full description, `## Plan` complete.
2. `label <id> Plan`
3. `release <id> <nonce>`, then `move <id> Ready` — in that order.
4. Post a short closing comment (no sentinel): 2–4 lines saying the plan is in the card
   description, the approach in one sentence, and any assumed-unanswered decision or
   leftover risk. **Do not paste the plan into a comment** — the description is the single copy.

Then stop. The card is build-card's.

## When questions are needed instead

1. `set-desc` with the partial plan and the questions listed under `## Open questions`.
2. `post-comment` the `🧭 Plan-me round N` questionnaire.
3. `release <id> <nonce>`, then `move <id> "In Review"`.
4. Do **not** add the `Plan` label — the phase is not finished.

Then stop.

## Never

`PIPELINE.md §9` applies in full. In particular, and specific to this phase:

- Run any `trello.py` queue command without `--phase plan`.
- Move a card out of `In Review` — that is Max's move and the whole point of the loop.
- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Edit `## Idea` or `## Spec`, or drop a `## Decisions` entry.
- Label a card `PR`, or touch a card without `Spec`, or one already carrying `Plan` / `PR`.
- Write repo code, run tests, or open a branch. This skill produces a plan, nothing else.
