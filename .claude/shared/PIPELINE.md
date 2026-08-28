# The Switchboard pipeline — shared rules

Every phase skill on this board obeys this file. Read it **before your first `claim`**.
Your own `SKILL.md` carries what is specific to your phase; this carries what is not, and
where the two ever disagree, **`SKILL.md` wins** — it was written for your phase, this was
written for all of them.

Skills that use this: `spec-card`, `plan-card`, `build-card`, `merge-card`, `check-board`.

---

## 0. Name the session before anything else

Switchboard's session list is the only place Max sees what his agents are doing, and by
default a row is titled with whatever the first prompt said — four rows reading "check the
board" tell him nothing. **The first thing every skill does is rename its own session**, so
the list reads as a status board:

```
[spec] Add a close button              [build] Add a close button (2)
[plan] Guard resume when a session…    [merge] Drop the fork button from session rows
```

One script does it, shared by every skill exactly like `trello.py`:

```
./scripts/session-name.py <phase> "<card name>" [run]
```

- **`<phase>`** — your own `--phase` value (`spec｜plan｜pr｜merge`). It maps `pr` to `build`,
  the word Max uses on the board, so no skill has to remember that.
- **`<card name>`** — the card's `name` verbatim from `claim`. Long titles are truncated.
- **`[run]`** — the `run` field from `claim`. `1` prints no suffix; `2` and up print ` (2)`,
  which is the whole point — a repeat pass on a card is the thing worth spotting in the list.

**Call it immediately after `claim` returns a card, before any other work** — the name is
what tells Max which session to open while the run is still going, so it is worthless
posted at the end. It is safe to call again later if you learn something better; the last
name wins.

`check-board` has no card when it starts, so it names itself `board` and passes no run.

### What `run` means

The number of times **this phase** has picked **this card** up, counting the current pass.
`claim` computes it; never count it yourself. Trello records no label history on this board,
so each phase derives it differently and `run_number` in the helper documents how — the one
you need to know is that `merge` always reports `1`, because a retried merge is
indistinguishable from the build passes before it and a wrong number is worse than none.

### If it fails

The rename is cosmetic; the card is not. If the script errors — no session id, no transcript
— say so in one line and **carry on with the phase**. Never abandon a claimed card over a
session title, and never retry it more than once.

---

## 1. The board model

One card walks the board once, through four phases, each owned by a different skill.

**List = who holds the baton.**

| List | Means |
|---|---|
| `Backlog` | **Max's.** Raw ideas. Never picked by any skill. |
| `Ready` | Max has released it — the owning phase's turn. **The only list any skill picks from.** |
| `In Progress` | An agent is working on it right now. |
| `In Review` | **Max's.** Waiting on him to answer, test, or approve. |
| `Done` | Shipped. Only merge-card puts a card here. |

**Label = the last phase *completed*** — never the phase in flight. A card carrying several
is at the **furthest** one along (`Spec` → `Plan` → `PR` → `Approved`), which is what stops
two phases claiming the same card.

| Card in `Ready` carrying | Belongs to | Which then applies |
|---|---|---|
| no phase label | **spec-card** | `Spec` |
| `Spec` | **plan-card** | `Plan` |
| `Plan` | **build-card** — first build | `PR` |
| `PR` | **build-card** — revision round on the same branch | `PR` (already there) |
| `Approved` | **merge-card** | no label; the card lands in `Done` |

`Approved` is the one label **no skill applies**. Max adds it by hand in `In Review` once he
has tested the PR and is happy for it to land, then moves the card to `Ready`. The helper
refuses `label <id> Approved` outright: a skill able to award itself the go-ahead would
defeat the only human gate in the pipeline.

## 2. The two lists that are Max's, not yours

This is the rule the whole loop rests on. Both failure modes look like initiative.

**`Backlog` is Max's alone.** It is where raw ideas sit until he judges one worth building.
A card leaves it only when *he* drags it to `Ready` — that drag **is** the go-ahead. Never
pick, claim, read-for-work, or move a `Backlog` card, however obvious or long-parked it
looks. `claim` cannot even see it; do not reach around that with `card` or the API.

**`In Review` is Max's alone.** It belongs to him however long it sits there and however
many comments land on it. Moving it to `Ready` is his deliberate signal that the round is
finished. Do not poll it, do not act on a new comment or PR review that appears there, do
not move it out yourself.

**An empty queue is a correct outcome, not a problem to route around.** If `claim` reports
`{"card": null}`, Max has released nothing. Say so and stop. Never offer a `Backlog` card as
a candidate, and never suggest starting one to have something to do.

## 3. The helper

All Trello access goes through `scripts/trello.py` — a symlink in each skill directory to
the shared `.claude/scripts/trello.py`. It loads `~/.trello.env` itself.

**Never print `TRELLO_TOKEN`,** or paste a URL containing it into output. The script never
echoes a query string back for this reason; do not defeat that by building URLs by hand.

**Always pass your phase's `--phase` flag** on `claim`, `pick` and `comments`. The flag is
what makes the script look for your phase's input label and read your phase's questionnaire
sentinel. Without it you get the **spec** phase's view of the board (`--phase` defaults to
`spec`), which for any other phase means an empty or wrong queue. The other subcommands take
a card id and need no flag.

| Command | Does |
|---|---|
| `claim` | Claim the next card this phase owns → JSON + a `lock` nonce, or `{"card": null}` |
| `release <id> <nonce>` | Drop the claim |
| `pick` | Read-only peek at the queue. Claims nothing — **not safe to act on** |
| `card <id>` | Name, desc, list, labels |
| `comments <id>` | The thread, split into questionnaires and the answers after the last one |
| `post-comment <id> <file>` | Post a comment from a file |
| `set-desc <id> <file>` | Replace the description |
| `move <id> <list>` | `Backlog｜Ready｜In Progress｜In Review｜Done` |
| `label <id> <name>` | `Spec｜Plan｜PR` — idempotent; refuses `Approved` |
| `survey` | The whole `Ready` queue bucketed by owning phase. `check-board`'s view; phase-independent |

**Write comment and description bodies to a file in the scratchpad first, then pass the
path.** Never build them as inline shell strings — the text is markdown with newlines,
quotes and backticks, and a shell will mangle it.

Skills that enter a git worktree lose the skill directory as their working directory, so
they set `T="$REPO/.claude/skills/<skill>/scripts/trello.py"` up front and call `"$T"`
throughout. Skills that stay put call `./scripts/trello.py`. Both are the same script.

`session-name.py` sits beside it, symlinked into every skill the same way, and is reached
the same two ways — see `§0`. It touches no Trello and needs no credentials.

## 4. Claiming — always start with `claim`, never `pick`

`pick` is read-only, for peeking at the queue. It is **not** safe to act on: reading the card
and moving it are two round trips, so two agents can both read the same `Ready` card before
either moves it. Switchboard runs multiple sessions and fires scheduled tasks, so this race
is real, not theoretical — and the loser does real damage, up to a duplicate PR on a review
already in progress, or a merge of a PR the winner already merged and deleted the branch of.

`claim` closes it. It posts a lock comment **first**, re-reads the thread, and only proceeds
if its own lock is the oldest live one — Trello orders comments server-side, which is what
makes the winner decidable at all. The loser withdraws its own lock and reports
`{"card": null}`. Verified with three concurrent claims on one card: one winner, two clean
back-offs.

Locks are **phase-independent** on purpose: a card being planned must not also be specced.

`claim` also moves the card to `In Progress` and skips any card already holding a live lock.
`In Progress` is the visible half of the mutex and the lock comment is the authoritative
half — never hand-move a card into `In Progress` to fake a claim, and never leave a card
parked there.

### Releasing

A claim gives you a `lock` nonce. **Release it before you stop, in the same run:**

```
release <id> <nonce>
```

**Release *before* the final `move` out of `In Progress`,** in that order, so the card is
never sitting in a queue-eligible list with a stale lock on it.

A lock left behind by a crashed run is reaped after **15 minutes**, so a dropped release
costs a delay, not a wedged card. A long run (a build, say) outliving the reaper is expected
and safe: the card is in `In Progress`, which no phase's queue scans, so nothing else picks
it up. Do not re-claim mid-run and do not rush the work to beat the timer — just release at
the end, and treat `release` failing with `no lock … (already released?)` as a non-event.

## 5. What `claim` hands you

Two independent fields decide what you do. (A third, **`run`**, decides nothing — it is the
pass number for the session name and is covered in `§0`.) Read both; they answer different
questions.

**`revision`** — from the card's **labels**. `true` means the card already carries this
phase's *own* output label: the phase ran to completion once and Max has sent it back for
another pass. Only the `pr` phase can ever see `true`.

**`mode`** — from the **comment thread**, not from the list, and only from *your* phase's
sentinel. An earlier phase's questions and answers are ordinary older comments to you and
are never read as an answer.

| mode | Means | Do |
|---|---|---|
| `new` | No questionnaire from this phase on the card yet | Start the phase from scratch |
| `resume` | Answers arrived since round *N* | Fold them in |
| `stalled` | Round *N* posted, no answers since | See below |

**`mode: new` does not mean "first time".** A revision round has usually never had a
questionnaire, so `{"mode": "new", "revision": true}` is an ordinary revision. Where both
fields exist, `revision` decides what you do.

**On `stalled`:** Max moved the card without answering. Do **not** invent answers or write
from assumed defaults — a card arriving with no answers at all is far more likely a misdrag
than blanket consent. Re-post the open questions as a fresh round, noting they are a repeat,
move back to `In Review`, and stop.

## 6. Questionnaires

Only the phases that ask questions use this section; `merge-card` has no rounds.

### The sentinel is load-bearing

Every questionnaire comment's **first line must be** `<emoji> <Phase>-me round N — M questions`:

| Phase | First line |
|---|---|
| spec | `🔍 Spec-me round N — M questions` |
| plan | `🧭 Plan-me round N — M questions` |
| build | `🔨 Build-me round N — M questions` |

The helper detects rounds by that prefix. **The API token acts as Max himself**, so comments
a skill posts are attributed to *him* — authorship cannot separate questions from answers,
and only the sentinel can. A questionnaire posted without it is invisible to the next run and
its answers will never be found. It must carry **your** phase's word: a `Spec-me` sentinel on
a plan question makes the card look un-specced to the wrong skill.

A closing comment is **not** a questionnaire — post it with no sentinel.

### What a question must be

- **Forces a decision** that changes what gets built — not colour, not confirmation.
- **Carries a bracketed default assumption**, so silence is a safe answer.
- **Answerable in a few words, from a phone.**
- Not answerable from the repo. Read the code first — asking Max what the codebase already
  states wastes the round and erodes his trust in the loop.
- Never re-litigates a `## Decisions` entry.

### Resolving a round

The bar is **not** "every question got a reply". Round 1 promises Max that skipping a
question means taking the bracketed assumption, so re-asking one he deliberately skipped
breaks that promise and the loop never terminates. Once *any* answer comes back, every
question in that round is resolved:

- **answered** → record the decision in `## Decisions`
- **skipped** → the bracketed assumption becomes the decision, recorded as
  `<decision> — round n, assumed (unanswered)` so he can spot and overturn it
- **deferred** — he explicitly says he doesn't know or wants to decide later → stays open
- **ambiguous** — unparseable, or contradicts another of his answers → stays open, and round
  *n+1* quotes both back to him and asks which wins

Match answers by **content, not just by number** — Max may restart numbering per round
(round 2's question 7 coming back as "1. Yes (a) is correct"). With one question the mapping
is unambiguous; with several and the numbering off, treat it as `ambiguous` rather than guess.

Only `deferred`, `ambiguous`, and genuinely new questions his answers raise carry into the
next round. Everything else is settled.

**Cap: 3 rounds.** At round 3, stop asking and finish from what is decided, listing whatever
is still unresolved under `## Risks` and calling it out in the closing comment. An endless
questionnaire is worse than a document with two stated unknowns — the next phase can raise
them again with something concrete in hand.

## 7. The card description is a shared document

`spec-card` and `plan-card` both rewrite it in full (`set-desc` replaces the whole thing), so
each must carry forward what the other wrote:

```markdown
## Idea          <- Max's original card text, verbatim. Captured once, never touched again.
## Spec          <- spec-card's contract. plan-card and build-card never edit it.
## Decisions     <- append-only across both phases. Never drop an entry.
## Plan          <- plan-card's mechanism. Added at the plan phase.
## Open questions
## Risks         <- omit the heading when there are none.
```

`build-card` and `merge-card` **never edit the description at all** — by then `## Spec` and
`## Plan` are the record of what was agreed, and the PR is where the work is reviewed.

## 8. Finishing a phase

Whatever else the phase does, it ends the same way, **in this order**:

1. Do the phase's own work (`set-desc`, `label`, open the PR, merge — whatever it produces).
2. `release <id> <nonce>`
3. `move <id> <list>` — `Ready` when the next phase can take it, `In Review` when the card
   is going back to Max, `Done` only from merge-card.
4. `post-comment` a short closing comment, **no sentinel**: what was decided or done, and
   anything that did not go to plan.

Then **stop**. One card per run. Do not carry on into the next phase — every phase ends with
the card back in Max's hands, and chaining past that gate buries several phases' work in one
unreviewable run.

## 9. Never — every phase

These hold for every skill on this board, on top of your own `SKILL.md`'s list:

- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Run a queue command (`claim` / `pick` / `comments`) without your phase's `--phase` flag.
- Pick up, claim, or move a card in `Backlog` — releasing one to `Ready` is Max's call alone.
- Act on, or move a card out of, `In Review` — that is Max's move and the whole point of the loop.
- Delete or edit any comment other than a lock comment (`claim` / `release` own those).
- Add or remove the `Approved` label.
- Move a card to `Done` — merge-card's alone, and only against a confirmed `MERGED` PR.
- Touch cards on any board but Switchboard, or a card whose labels put it in another phase.
- Do another phase's job. Each skill produces one thing; if the card needs something else,
  say so and leave it for the phase that owns it.
