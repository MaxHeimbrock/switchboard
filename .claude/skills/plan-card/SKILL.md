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
the spec deliberately left open, not as a second grilling.

All Trello access goes through `scripts/trello.py` (a symlink to the shared
`.claude/scripts/trello.py`, used by every phase skill). Run it from the skill directory or
by absolute path; it loads `~/.trello.env` itself. **Never print `TRELLO_TOKEN`.**

**Always pass `--phase plan`.** The flag is what makes the script look for `Spec` cards and
read `Plan-me` questionnaires; without it you get the grill phase's view of the board.

```
./scripts/trello.py --phase plan claim         # claim the next card — START HERE
./scripts/trello.py release <id> <nonce>       # drop the claim when you stop
./scripts/trello.py --phase plan pick          # read-only peek, claims nothing
./scripts/trello.py card <id>                  # name, desc, list, labels
./scripts/trello.py --phase plan comments <id> # thread + questionnaire/answer split
./scripts/trello.py post-comment <id> <file>   # post a comment from a file
./scripts/trello.py set-desc <id> <file>       # replace the description
./scripts/trello.py move <id> "In Review"      # Backlog|Ready|In Progress|In Review|Done
./scripts/trello.py label <id> Plan            # Spec|Plan|PR
```

Write comment and description bodies to files in the scratchpad first, then pass the path.
Never build them as inline shell strings — the text is markdown with newlines and quotes.

## Board conventions

- **List = who holds the baton.** `Backlog` unpicked · `In Progress` an agent is working ·
  `In Review` waiting on Max · `Ready` groomed, next agent's turn · `Done` shipped.
- **Label = the last phase *completed*.** No label → grill-card's turn. `Spec` → **this
  skill's turn**. `Plan` → implement skill's turn. `PR` → open for review.

So a card is this skill's only when it carries `Spec` and **not** `Plan` or `PR`, and only
from `Ready`. `claim --phase plan` enforces both.

## The loop

| # | Card at | Who | Action |
|---|---|---|---|
| 1 | `Ready` + `Spec` | this skill | `claim` topmost (auto-moves to `In Progress`) |
| 2 | `In Progress` | this skill | Read spec + code. No questions → write plan, label `Plan`, move to `Ready`, done |
| 3 | `In Progress` | this skill | Questions needed → write partial plan, post round-*n* questions → move to `In Review` |
| 4 | `In Review` | **Max** | Answers in a comment, then **moves the card to `Ready` himself** |
| 5 | `Ready` + `Spec` | this skill | `claim` it, fold answers in → step 2 or step 3 (round *n+1*) |
| 6 | `Ready` + `Plan` | implement skill | Not this skill's card any more |

### What `claim` hands you

`mode` comes from the **comment thread**, not the list — Max may move a card into `Ready`
that has never been planned. Act on the mode:

| mode | Means | Do |
|---|---|---|
| `new` | No `Plan-me` questionnaire on the card yet | Plan from scratch (step 2 or 3) |
| `resume` | Answers arrived since round *N* | Fold them in (step 5) |
| `stalled` | Round *N* posted, no answers since | Max moved it without answering — see below |

Only `Plan-me` comments count. The whole grill-me thread above them is just history to this
phase, and is never read as an answer.

### The trigger is strict — never jump the gun

**Only `Ready` cards with `Spec` are ever picked up.** A card in `In Review` belongs to Max,
however long it sits there and however many comments appear on it. Moving it to `Ready` is
his deliberate signal that the round is finished. Do not poll `In Review`, do not act on a
new comment there, do not move it out yourself. A `Spec` card sitting in `Backlog` was
parked deliberately — leave it.

### Claiming — always start with `claim`, never `pick`

`pick` is read-only, for peeking at the queue. It is **not** safe to act on: reading the
card and moving it are two round trips, so two agents can both read the same `Ready` card
before either moves it. Switchboard runs multiple sessions and fires scheduled tasks, so
this race is real.

`claim` closes it. It posts a lock comment *first*, re-reads the thread, and only proceeds
if its own lock is the oldest live one. The loser withdraws its lock and reports
`{"card": null}`. Locks are phase-independent: a card being planned cannot also be grilled.

A claim gives you a `lock` nonce. **Release it before you stop**, in the same run:

```
./scripts/trello.py release <id> <nonce>
```

Release *before* the final `move` out of `In Progress`, so the card is never sitting in a
queue-eligible list with a stale lock on it. A lock left by a crashed run is reaped after
15 minutes, so a dropped release costs a delay, not a wedged card.

`claim` also moves the card to `In Progress` and skips any card holding a live lock.
`In Progress` is the visible half of the mutex, the lock comment the authoritative half —
never hand-move a card into `In Progress` to fake a claim, and never leave one parked there.

**On `stalled`:** do **not** invent answers. Re-post the open questions as a fresh round,
noting they are a repeat, move back to `In Review`, and stop.

## Grounding the plan — read the code first

A plan that names a file that does not exist is worse than no plan: the implement skill will
follow it. Before writing a single step:

1. Read the whole card description — `## Spec` is the contract, `## Decisions` are settled
   and must not be re-opened, `## Risks` is a direct message from grill-card to you.
2. Find the real code with `Grep`/`Glob`, then `Read` it. Follow the call chain end to end —
   the caller, the state it mutates, the consumers of that state.
3. **Verify every path, symbol and line number you write down.** If you cite
   `main.js:1155`, you have read line 1155 in this run.
4. Work out what the change breaks: persisted data, IPC contracts, other callers, anything
   that reads a field you are deleting. The spec's `## Risks` names some of these; find the
   rest yourself.

Never edit repo code. This skill produces a plan, nothing else.

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

Each question must force a decision that changes what gets built, carry a **bracketed
default assumption** so silence is safe, and be answerable in a few words from a phone.

**Cap 5 questions per round, 3 rounds.** At round 3, write the plan from what is decided and
list whatever is still unresolved under `## Risks`, calling it out in the closing comment.

## Comment format

Every questionnaire comment's **first line must be** `🧭 Plan-me round N — M questions`.
The helper detects rounds by that prefix, and this is load-bearing: the API token acts as
Max himself, so comments this skill posts are attributed to *him*. Authorship cannot
separate questions from answers — only the sentinel can. A questionnaire without it is
invisible to the next run, and its answers will never be found. It must say `Plan-me`, not
`Grill-me` — a `Grill-me` sentinel makes the card look un-specced to the wrong skill.

```
🧭 Plan-me round 1 — 2 questions

Spec's agreed; these are the two build choices I can't call myself. Reply in one comment,
number your answers, skip any you don't care about and I'll take the assumption in
brackets. Then move the card to Ready.

1. Drop the `forkFrom` column outright, or leave it in place unread?
   [assume: leave it — no migration]
2. ...
```

## Resolving a round

Once *any* answer comes back, every question in that round is resolved:

- **answered** → record it in `## Decisions` as `<decision> — plan round n`
- **skipped** → the bracketed assumption becomes the decision, recorded as
  `<decision> — plan round n, assumed (unanswered)` so Max can spot and overturn it
- **deferred** — he says he doesn't know or wants to decide later → stays open
- **ambiguous** — unparseable, or contradicts another answer → stays open, and round *n+1*
  quotes both back and asks which wins

Match answers by **content, not just by number** — Max may restart numbering per round. Only
`deferred`, `ambiguous`, and genuinely new questions his answers raise carry forward.

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
Add: anything the implement skill must not get wrong, plus anything left open by the
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
- **Concrete**: symbols and line ranges, not "update the handler". The implement skill
  should not have to re-do your search.
- **Complete against the spec**: every acceptance criterion in `## Spec` is reachable by
  following the steps, and `**Verification**` proves each one.

## Finishing

When `## Open questions` is empty, or the 3-round cap is reached:

1. `set-desc` with the full description, `## Plan` complete.
2. `label <id> Plan`
3. `release <id> <nonce>`, then `move <id> Ready` — in that order.
4. Post a short closing comment (no sentinel — it is not a questionnaire): 2–4 lines saying
   the plan is in the card description, the approach in one sentence, and any
   assumed-unanswered decision or leftover risk. **Do not paste the plan into a comment** —
   the description is the single copy.

Then stop. The card is the implement skill's.

## When questions are needed instead

1. `set-desc` with the partial plan and the questions listed under `## Open questions`.
2. `post-comment` the `🧭 Plan-me round N` questionnaire.
3. `release <id> <nonce>`, then `move <id> "In Review"`.
4. Do **not** add the `Plan` label — the phase is not finished.

Then stop.

## Never

- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Run any `trello.py` queue command without `--phase plan`.
- Edit `## Idea` or `## Spec`, or drop a `## Decisions` entry.
- Delete or edit any comment other than a lock comment (`claim` / `release` own those).
- Move a card out of `In Review` — that is Max's move and the whole point of the loop.
- Move a card to `Done`, or label it `PR`.
- Touch cards on any board but Switchboard, or cards without `Spec`, or cards carrying
  `Plan` / `PR`.
- Write repo code, run tests, or open a branch. This skill produces a plan, nothing else.
