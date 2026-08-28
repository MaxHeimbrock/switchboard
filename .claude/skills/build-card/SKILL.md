---
name: build-card
description: Implement the plan on a Trello card in a git worktree and open a draft PR. Use when asked to build or implement a planned card, pick up the next card to implement, turn a Trello plan into code, or open the PR for a planned card. Operates on the Switchboard board only.
allowed-tools: Bash, Read, Grep, Glob, Edit, Write, EnterWorktree, ExitWorktree
---

# Build a planned card

Takes a card whose plan Max has already agreed to (label `Plan`, sitting in `Ready`), writes
the code on a branch in its own git worktree, and opens a **draft** PR. The card ends up in
`In Review` with a `PR` label and the PR link in a comment.

It is also the phase Max sends a card **back** to. Once he has tested the PR or collected
review comments — his own, a colleague's, or an AI reviewer's — he moves the card from
`In Review` to `Ready` with its `PR` label still on it. That is the signal for another round of
implementation on the same branch and the same PR. See **Revision rounds**.

This is the only phase that writes repo code. The spec said *what*, the plan said *how* —
this skill does it and proves it works. It does not re-decide either.

All Trello access goes through `scripts/trello.py` (a symlink to the shared
`.claude/scripts/trello.py`, used by every phase skill). It loads `~/.trello.env` itself.
**Never print `TRELLO_TOKEN`.**

**Always pass `--phase pr`.** The flag is what makes the script look for `Plan` cards and read
`Build-me` questionnaires; without it you get the spec phase's view of the board.

Once you enter the worktree the session's working directory changes, so call the script by
its **absolute path** from that point on:

```
REPO=/Users/maxheimbrock/dev/learning/switchboard
T="$REPO/.claude/skills/build-card/scripts/trello.py"

"$T" --phase pr claim           # claim the next card — START HERE
"$T" release <id> <nonce>       # drop the claim when you stop
"$T" --phase pr pick            # read-only peek, claims nothing
"$T" card <id>                  # name, desc, list, labels
"$T" --phase pr comments <id>   # thread + questionnaire/answer split
"$T" post-comment <id> <file>   # post a comment from a file
"$T" set-desc <id> <file>       # replace the description
"$T" move <id> "In Review"      # Backlog|Ready|In Progress|In Review|Done
"$T" label <id> PR              # Spec|Plan|PR
```

Write comment and description bodies to files in the scratchpad first, then pass the path.
Never build them as inline shell strings — the text is markdown with newlines and quotes.

## Board conventions

- **List = who holds the baton.** `Backlog` unpicked · `In Progress` an agent is working ·
  `In Review` waiting on Max · `Ready` groomed, next agent's turn · `Done` shipped.
- **Label = the last phase *completed*.** No label → spec-card's turn. `Spec` → plan-card's
  turn. `Plan` → **this skill's turn**. `PR` → a PR is open; **also this skill's turn**, but
  only once Max has moved the card back to `Ready`.

This is the one phase that accepts its own output label, because implementation is the only
step that loops: `Plan` in `Ready` is a first build, `PR` in `Ready` is a revision round.
Everywhere else in the pipeline `PR` means hands off. `claim --phase pr` enforces the list and
the labels, and never picks a `PR` card out of `In Review`.

## The loop

| # | Card at | Who | Action |
|---|---|---|---|
| 1 | `Ready` + `Plan` | this skill | `claim` topmost (auto-moves to `In Progress`) |
| 2 | `In Progress` | this skill | Worktree → implement → verify → draft PR → label `PR`, move to `In Review` |
| 3 | `In Review` + `PR` | **Max** | Tests it, gathers review comments. Merging and `Done` are his |
| 4 | `Ready` + `PR` | this skill | **Revision round** — `claim`, read the PR feedback, another pass on the same branch, back to `In Review` |
| 5 | — | | Steps 3–4 repeat for as many rounds as the review takes |
| — | `In Progress` | this skill | Escape hatch: plan unbuildable → round-*n* questions → `In Review`, no new label |

Steps 2 and 4 are the whole job. `In Review` here means *a PR is waiting on Max*, unlike the
earlier phases where it means *a questionnaire is waiting on Max* — the `PR` label tells the two
apart. Max moving a `PR` card back to `Ready` is the only thing that starts a revision round; a
comment appearing on the PR is not.

### What `claim` hands you

Two independent fields, answering different questions:

- **`revision`** — from the card's **labels**. `false` = first build, `true` = a PR already
  exists and this is another pass on it. **This is the field that decides what you do.**
- **`mode`** — from the `Build-me` **comment thread** only. It tracks the escape-hatch
  questionnaire and nothing else.

| mode | Means | Do |
|---|---|---|
| `new` | No `Build-me` questionnaire yet | Nothing special — the normal state for first builds *and* revisions |
| `resume` | Answers arrived since round *N* | Fold the answers in, then build |
| `stalled` | Round *N* posted, no answers since | Re-post the round, back to `In Review`, stop |

**`mode: new` does not mean "first build".** A revision round has usually never had a
questionnaire, so `{"mode": "new", "revision": true}` is the ordinary revision case. Read
`revision` first, every time. Getting this backwards means rebuilding the card from scratch on a
fresh branch and opening a duplicate PR on top of a review already in progress.

Only `Build-me` comments count towards `mode`. The `Spec-me` and `Plan-me` threads above them
are history to this phase and are never read as an answer.

### The trigger is strict — never jump the gun

**Only `Ready` cards are ever picked up**, carrying `Plan` or `PR`. A card in `In Review`
belongs to Max, however long it sits and however many comments appear on it.

This matters more here than anywhere else in the pipeline, because a `PR` card in `In Review` is
busy collecting exactly the review feedback you would act on, and starting early looks helpful.
Don't. He may still be testing, a colleague may not have finished reviewing, and he decides
which comments survive. Moving it to `Ready` is his signal that the round is complete. Do not
poll `In Review`, do not act on a new PR comment, do not move it out yourself. A `Plan` or `PR`
card parked in `Backlog` was parked deliberately.

### Claiming — always start with `claim`, never `pick`

`pick` is read-only, for peeking at the queue. It is **not** safe to act on: reading the card
and moving it are two round trips, so two agents can both read the same `Ready` card before
either moves it. Switchboard runs multiple sessions and fires scheduled tasks, so this race is
real — and here the loser would open a duplicate PR, not merely duplicate a comment.

`claim` closes it. It posts a lock comment *first*, re-reads the thread, and only proceeds if
its own lock is the oldest live one. The loser withdraws and reports `{"card": null}`. Locks
are phase-independent: a card being built cannot also be specced.

A claim gives you a `lock` nonce. **Release it before you stop**, in the same run:

```
"$T" release <id> <nonce>
```

Release *before* the final `move` out of `In Progress`, so the card is never sitting in a
queue-eligible list with a stale lock on it. A lock left by a crashed run is reaped after 15
minutes, so a dropped release costs a delay, not a wedged card.

`claim` also moves the card to `In Progress` and skips any card holding a live lock. Never
hand-move a card into `In Progress` to fake a claim, and never leave one parked there.

**A build outlives the 15-minute lock reaper.** That is expected and safe: the card is sitting
in `In Progress`, which no phase's queue scans, so nothing else will pick it up. Do not
re-claim mid-run, and do not shorten the work to beat the timer. Just release at the end —
`release` failing with "no lock … (already released?)" because the reaper got there first is a
non-event; carry on and finish the card.

## Revision rounds — a card that comes back carrying `PR`

`revision: true` means a draft PR is already open for this card, feedback has landed on it, and
Max has moved the card back to `Ready` asking for another pass. **The existing branch and the
existing PR are the deliverable** — this round adds commits to them. Never open a second PR.

`SLUG` and `BRANCH` are derived exactly as in **Set up the worktree** below.

### Find the PR

From the main checkout, before touching a worktree:

```bash
REPO=/Users/maxheimbrock/dev/learning/switchboard
cd "$REPO"

# Primary: the branch this card's slug produced last time.
gh pr list --head "$BRANCH" --state all --json number,url,headRefName,isDraft,state

# Fallback, if the card title changed since the first build: the Trello link in the PR body.
gh pr list --state all --search "<card shortUrl>" --json number,url,headRefName
```

The `Trello: <shortUrl>` line the first build wrote into the PR body is what makes the fallback
work — keep writing it. If neither lookup finds a PR the `PR` label is wrong: say so in a card
comment, move the card back to `In Review`, and stop. Do not "fix" it by building from scratch.

### Read every source of feedback

There are four, they are genuinely separate, and skipping one drops comments silently:

```bash
PR=<number>

# 1. Conversation comments — where Max reports what his testing found.
gh pr view "$PR" --json comments \
  --jq '.comments[] | {author: .author.login, at: .createdAt, body}'

# 2. Review summaries and verdicts (APPROVED / CHANGES_REQUESTED / COMMENTED).
gh pr view "$PR" --json reviews,reviewDecision \
  --jq '.reviews[] | select(.body != "") | {author: .author.login, state: .state, at: .submittedAt, body}'

# 3. Inline per-line comments — NOT included in either of the above. AI reviewers land here.
gh api "repos/{owner}/{repo}/pulls/$PR/comments" \
  --jq '.[] | {id, in_reply_to_id, path, line, author: .user.login, at: .created_at, body}'

# 4. CI, if there is any.
gh pr checks "$PR"
```

Plus the Trello card itself — `"$T" --phase pr comments <id>` — since Max sometimes leaves the
summary there instead. An automated reviewer's summary body can run to thousands of lines; read
it, act on it, but never paste it into a card comment.

**What counts as this round's work.** Anything created after the branch's head commit:

```bash
git -C "$REPO" log -1 --format=%cI "origin/$BRANCH"
```

Older comments were answered in an earlier round — confirm the diff actually shows it, and if it
doesn't, the comment is still open. When you cannot tell, treat it as open: re-reading a handled
comment is cheap, dropping a live one is not.

**If nothing is new**, the card came back without feedback. Do not go looking for improvements to
make. Post a `Build-me` round asking what needs changing, move to `In Review`, and stop — the
same discipline as `stalled`.

### Act on it

Every piece of feedback gets one of two things: a code change, or a reply saying why not.
Nothing is dropped in silence, including feedback you disagree with — Max arbitrates, you don't.

Feedback asking for something the **spec rules out**, or needing a decision the plan never made,
is not yours to absorb quietly: reply saying so, and raise it as a `Build-me` question on the
card. A review comment does not override an agreed spec.

Then reply, once the work is pushed:

```bash
# Inline threads — reply on the thread you acted on, so the reviewer can resolve it.
gh api --method POST "repos/{owner}/{repo}/pulls/$PR/comments/<comment_id>/replies" \
  -f body='Done in <sha> — <one line>.'

# Everything not tied to a line: one comment for the whole round.
gh pr comment "$PR" --body-file <scratchpad>/round-note.md
```

One or two lines each. Inline feedback gets inline replies; everything else gets the single
round comment. Never post both for the same point.

## Set up the worktree — never build on `main`

Work happens in a git worktree under `.claude/worktrees/`, on its own branch, so `main` and
Max's own checkout are untouched while you build.

```bash
REPO=/Users/maxheimbrock/dev/learning/switchboard
SLUG=remove-fork-button          # from the card title: lowercase, non-alnum -> '-', <= 40 chars
BRANCH=feat/$SLUG                # feat|fix|refactor|docs — whichever the change actually is

cd "$REPO"
git fetch origin
git worktree add ".claude/worktrees/$SLUG" -b "$BRANCH" main
ln -s "$REPO/node_modules" "$REPO/.claude/worktrees/$SLUG/node_modules"
```

Then call `EnterWorktree` with `path: <absolute path to the worktree>` so the session's working
directory follows. Do this *before* editing anything — otherwise `Grep`, `Glob` and relative
paths all silently resolve against `main`'s checkout and you will edit the wrong tree.

Why each line is the way it is:

- **Branch from local `main`, not `origin/main`.** Max's `main` is often ahead of the remote.
  Branching from the remote silently drops those commits and the PR conflicts. If
  `git log origin/main..main` is non-empty, the PR will show those commits too — say so in the
  closing comment rather than trying to fix it.
- **`node_modules` must be a symlink to the main checkout.** It is gitignored, so a fresh
  worktree has none, and `npm test` needs `electron` and `better-sqlite3` — the latter compiled
  for Electron's ABI. Symlinking is instant and correct; `npm install` in the worktree is slow
  and can rebuild natives against the wrong ABI. Remove the symlink before removing a worktree.
- **`.claude/worktrees/` is gitignored** so the worktree never shows up as untracked in Max's
  main checkout. Keep it that way.
- **Never `git checkout` in the main checkout**, never commit to `main`, never `git push` main.

**On a revision, reattach — do not create.** The worktree usually survives from the previous
round. If it doesn't, recreate it on the branch that already exists; the first build's `-b` form
would fail here:

```bash
WT="$REPO/.claude/worktrees/$SLUG"
git fetch origin
if [ ! -d "$WT" ]; then
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git worktree add "$WT" "$BRANCH"                              # local branch still there
  else
    git worktree add --track -b "$BRANCH" "$WT" "origin/$BRANCH"  # only the remote survived
  fi
fi
ln -sfn "$REPO/node_modules" "$WT/node_modules"
```

Then `EnterWorktree`, and inside it `git pull --ff-only origin "$BRANCH"` — Max or a colleague
may have pushed to the branch since the last round.

Leave the worktree on disk when you finish and name its path in the closing comment — the draft
PR is likely the start of a conversation, and Max may want to poke at the branch. It costs a
symlink and a checkout. To clean up an old one later:
`rm -f <wt>/node_modules && git worktree remove <wt>`.

## Implementing — the plan is the contract

Read the whole card description first. `## Spec` is what Max agreed to build, `## Decisions`
are settled, `## Plan` is the mechanism, `## Risks` is a direct message from plan-card to you.

Then work the `**Steps**` **in the order given**. They were ordered so the tree stays coherent
between them; reordering reintroduces the dangling references that ordering was designed to
avoid. Run each step's `*Verify:*` check as you go, not all at the end.

The plan's line numbers were accurate when it was written and may have drifted. Treat them as
a starting point: locate the named **symbol**, confirm it is the thing the plan describes, then
edit. A line number that no longer matches is drift, not licence to improvise.

**When the plan is wrong.** Plans are written from reading, so occasionally reality differs.

- *Small and obvious* — a moved line, a helper that turned out to have two callers, a step that
  needs an extra one-line change to compile: fix it, do it, and note the deviation in the PR
  body under **Deviations from the plan**. Do not ask.
- *Changes what gets built* — the approach cannot work, a step contradicts the spec, or doing
  it properly means a schema change or a decision the plan never made: **stop and ask** (see
  below). Do not quietly build something else. The card's whole value is that Max agreed to
  what is in it.

Stay inside the plan's `**Touches**` list plus whatever the change genuinely forces. Do not
reformat untouched code, do not fix unrelated bugs you notice, and honour `**Not doing**` — it
is a decision, not an oversight. Note anything tempting you left alone in the PR body.

## Verifying — run everything you can, claim only what you ran

Run, from inside the worktree:

1. **Every automated check in the plan's `**Verification**` block** — the greps, the diffs, the
   file assertions. They map onto the spec's acceptance criteria one for one.
2. **`npm test`** (`node --test`, runs in about a second) — always, even when the plan does not
   mention it. It is the collateral-damage check. Report the counts it actually prints.
3. **Any new test the change warrants**, in `test/`, matching the existing files' style
   (`node:test` + `node:assert/strict`, one file per subject). Add one when the change has
   logic worth pinning; do not manufacture a test for a pure deletion.

**Never tick a box you did not run.** The plan's `npm start` / hover-the-row /
resume-a-session steps need a human at a GUI: they go into the PR checklist **unticked**, for
Max to tick as he does them. Say plainly in the card comment that some remain unticked. A
green PR that quietly claimed its own acceptance criteria is the single worst thing this skill
can produce.

If `npm test` fails, fix it — a failure you caused is yours. If it fails for a reason the change
did not cause, say so in the PR body with the output, and still open the PR. If you cannot make
the change work at all, do not open a PR: go to **When the build cannot finish**.

## Commit and open the draft PR

One commit for the card unless the plan's steps genuinely want separating. Match the repo's
style: a conventional-commit subject, then a prose body saying **why**, then the trailer.

```
feat(ui): drop the fork button from session rows

Forking was reachable only from the row's hover strip, and the spawn path
behind it had accumulated detection branches that could never fire once the
button was gone. Remove the button, forkSession, and the forkFrom plumbing,
keeping the self-fork detection that reads the JSONL's own forkedFrom field.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Then push and open the PR **as a draft**:

```bash
git push -u origin "$BRANCH"
gh pr create --draft --base main --title "<commit subject>" --body-file <scratchpad>/pr-body.md
```

PR body, in this order. **The plan's `**Verification**` block becomes a markdown checklist** —
one item per check, in the plan's own order, ticked only if this run actually ran it and it
passed. GitHub renders these as live checkboxes, so the unticked ones are Max's worklist: he
ticks them off in the PR as he does each manual pass.

```markdown
<One paragraph: what changes and why, from the spec.>

Trello: <card shortUrl>

## Verification
Ticked = run by me and passing. Unticked = needs you at a GUI; I have not run it.

- [x] `npm test` — <n> pass, 0 fail
- [x] <automated check from the plan, verbatim> — <its result>
- [ ] <manual check from the plan, verbatim>

## Deviations from the plan
- <each one, and why. Omit the section if there were none.>
```

Every line of the plan's `**Verification**` block appears here, none dropped and none reworded
— it is the spec's acceptance criteria in disguise, and a check that goes missing from the list
is a criterion nobody will ever notice was skipped. Add the `npm test` line at the top even
when the plan omits it. A check that ran and *failed* for a reason the change did not cause
stays unticked, with the reason and the output beside it.

Draft, always — Max decides when it is ready for review. Never `gh pr merge`, never
`gh pr ready`, never push to `main`.

### On a revision: push to the same PR

No `gh pr create`. Commit on the same branch with a subject saying what this round did — it does
not need to restate the card — then push and bring the checklist back in line with the code:

```bash
git push origin "$BRANCH"
gh pr edit "$PR" --body-file <scratchpad>/pr-body.md
```

Rules for the updated checklist:

- Items Max ticked stay ticked — **unless this round changed the code that item covers**, in
  which case untick it and say so in the round note. A tick that no longer reflects the code is
  worse than an empty box, because he has already stopped looking at it.
- Add an item for anything this round's feedback introduced.
- Re-run every automated check and update its result. They are cheap; assume nothing carries over.

The PR keeps its number and URL, stays a draft, and stays open.

## Finishing

In this order:

1. **First build:** `gh pr create --draft …` — capture the URL it prints.
   **Revision:** `git push` then `gh pr edit --body-file …`; the PR keeps its number and URL.
2. `"$T" label <id> PR` — a no-op on a revision, but run it anyway: it is idempotent, and it
   covers a label removed by hand.
3. `"$T" release <id> <nonce>`, then `"$T" move <id> "In Review"` — in that order.
4. `"$T" post-comment <id> <file>` — a short closing comment, no sentinel (it is not a
   questionnaire).
   - *First build:* the PR link, the approach in one sentence, which checklist items are unticked
     and waiting on him, any deviation from the plan, and the worktree path.
   - *Revision:* the PR link, what this round changed per piece of feedback, anything you pushed
     back on and why, and any checklist item you had to untick.

Do **not** edit the card description on any round — `## Spec` and `## Plan` are the record of
what was agreed, and the PR is where the implementation is reviewed. Leave both alone.

Then call `ExitWorktree` with `action: "keep"` and stop. The card is Max's.

## When the build cannot finish

Only for the "changes what gets built" case above, or a build that genuinely will not go green.

1. Commit and push whatever coherent work exists on the branch, if any. Do **not** open a PR.
2. `post-comment` a questionnaire whose **first line is** `🔨 Build-me round N — M questions`.
   The helper detects rounds by that prefix, and this is load-bearing: the API token acts as
   Max himself, so comments this skill posts are attributed to *him*. Authorship cannot separate
   questions from answers — only the sentinel can. A questionnaire without it is invisible to
   the next run and its answers will never be found. It must say `Build-me`, not `Spec-me` or
   `Plan-me`.
3. `release <id> <nonce>`, then `move <id> "In Review"`.
4. Do **not** add the `PR` label — the phase is not finished.
5. `ExitWorktree` with `action: "keep"`, and name the branch in the comment.

```
🔨 Build-me round 1 — 1 question

Hit a wall implementing step 4 — reply in one comment, skip it and I'll take the
assumption in brackets. Then move the card to Ready.

1. `forkFrom` is also read by the schedule runner, which the plan didn't cover. Strip
   it there too, or leave the schedule path working as-is?
   [assume: strip it too — same removal]
```

Each question must force a decision that changes what gets built, carry a **bracketed default
assumption** so silence is safe, and be answerable in a few words from a phone. **Cap 5
questions per round, 3 rounds.** At round 3, build what is decided, and add what is still
unresolved to the PR's `## Verification` checklist as unticked items.

Never ask about naming, file layout, test structure or code style — decide those. Never
re-litigate a `## Decisions` entry or re-open the spec.

## Never

- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Run any `trello.py` queue command without `--phase pr`.
- Commit to `main`, push `main`, or `git checkout` in the main checkout. Everything happens in
  the worktree.
- Open a non-draft PR, mark one ready for review, merge one, or push to someone else's branch.
- Open a second PR for a card that already has one, or run a revision round on a fresh branch.
- Act on PR feedback while the card is still in `In Review`. Wait for Max to move it to `Ready`.
- Drop a piece of review feedback without either a code change or a reply saying why not.
- Tick a checklist item you did not run, or drop one from the plan's Verification block.
- Edit the card description, or delete/edit any comment other than a lock comment.
- Move a card out of `In Review` — that is Max's move.
- Move a card to `Done`. Merging the PR and closing the card are his.
- Touch cards on any board but Switchboard, or cards carrying neither `Plan` nor `PR`.
