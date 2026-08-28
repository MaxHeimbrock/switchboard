---
name: merge-card
description: Merge the approved PR for a Trello card, land it on main, and clear away the branch and worktree. Use when asked to merge an approved card, ship a card Max has approved, pick up the next card to merge, or close out a card whose review is finished. Operates on the Switchboard board only.
allowed-tools: Bash, Read, Grep, Glob
---

# Merge an approved card

Last phase in the pipeline. Takes a card Max has approved (label `Approved`, sitting in
`Ready`), squash-merges its PR into `main`, brings the local `main` up to date, and clears
away the branch, the remote branch and the worktree. The card ends in `Done`.

**This phase makes no judgements about the code.** Whether the change is right, whether it
works, whether review is finished — all of that was decided before the `Approved` label went
on. Its whole job is to land the PR cleanly, or to refuse and say exactly why. It never edits
repo code, never pushes to a branch, and never resolves a conflict.

All Trello access goes through `scripts/trello.py` (a symlink to the shared
`.claude/scripts/trello.py`, used by every phase skill). It loads `~/.trello.env` itself.
**Never print `TRELLO_TOKEN`.**

**Always pass `--phase merge`.** The flag is what makes the script look for `Approved` cards;
without it you get the spec phase's view of the board.

```
REPO=/Users/maxheimbrock/dev/learning/switchboard
T="$REPO/.claude/skills/merge-card/scripts/trello.py"

"$T" --phase merge claim        # claim the next approved card — START HERE
"$T" release <id> <nonce>       # drop the claim when you stop
"$T" --phase merge pick         # read-only peek, claims nothing
"$T" card <id>                  # name, desc, list, labels
"$T" --phase merge comments <id># the card's comment thread
"$T" post-comment <id> <file>   # post a comment from a file
"$T" move <id> "Done"           # Backlog|Ready|In Progress|In Review|Done
```

Write comment bodies to files in the scratchpad first, then pass the path. Never build them
as inline shell strings — the text is markdown with newlines and quotes.

This skill applies **no label**. There is no `Merged` label; landing in `Done` is the record.
`"$T" label` refuses `Approved` outright — see below.

## The `Approved` label

`Approved` (blue) is the fourth label on the board and the only one **Max applies by hand**.
`Spec`, `Plan` and `PR` are stamped by the skill that produced them; `Approved` is the human
gate in front of the merge. He adds it in Trello while the card is in `In Review`, once he has
tested the PR and is happy for it to land — then moves the card to `Ready`, which is what
hands it to this skill.

It routes as well as gates. `phase_of` takes the **furthest** label in pipeline order
(`Spec` → `Plan` → `PR` → `Approved`), so an approved card no longer reads as a `PR` card and
drops out of build-card's queue automatically. That is what stops the two skills fighting over
the same `Ready` card:

| Card in `Ready` with | Belongs to |
|---|---|
| `Plan` | build-card — first build |
| `PR` | build-card — another revision round on the same branch |
| `PR` + `Approved` | **this skill** — merge it |

So the two moves that route a reviewed card are both Max's, and they are opposites:

- **Add `Approved`, move to `Ready`** → merge it.
- **Leave `Approved` off, move to `Ready`** → another build round.

If an approved card turns out to need more work after all — a conflict, a late review comment,
a failing check — **Max removes the `Approved` label** and it falls back into build-card's
queue. Never add or remove `Approved` yourself; `trello.py label` will refuse it, and doing it
by API instead would be a skill granting itself permission to merge.

## Board conventions

- **List = who holds the baton.** `Backlog` unpicked · `In Progress` an agent is working ·
  `In Review` waiting on Max · `Ready` groomed, next agent's turn · `Done` shipped.
- **Label = the last phase *completed*.** No label → spec-card. `Spec` → plan-card. `Plan` or
  `PR` → build-card. `Approved` → **this skill**.

## The loop

| # | Card at | Who | Action |
|---|---|---|---|
| 1 | `In Review` + `PR` | **Max** | Tests the PR, adds `Approved`, moves it to `Ready` |
| 2 | `Ready` + `Approved` | this skill | `claim` topmost (auto-moves to `In Progress`) |
| 3 | `In Progress` | this skill | Find PR → preflight → squash-merge → sync `main` → delete worktree and branches → `Done` |
| — | `In Progress` | this skill | Escape hatch: anything in preflight fails → report on the card → `In Review`, **not merged** |

There are no questionnaires in this phase and no rounds. A merge either goes through or it
doesn't; there is nothing to ask about that a bracketed default could answer. `claim` still
reports `mode` and `revision` because every phase shares one helper — **ignore both fields
here.** `mode` is always `new`.

### Claiming — always start with `claim`, never `pick`

`pick` is read-only, for peeking at the queue. It is **not** safe to act on: reading the card
and moving it are two round trips, so two agents can both read the same `Ready` card before
either moves it. Switchboard runs multiple sessions and fires scheduled tasks, so the race is
real — and here the loser would try to merge a PR the winner has already merged and deleted
the branch of.

`claim` closes it: it posts a lock comment first, re-reads the thread, and only proceeds if its
own lock is the oldest live one. The loser reports `{"card": null}`. A claim gives you a `lock`
nonce — **release it before you stop, in the same run**:

```
"$T" release <id> <nonce>
```

Release *before* the final `move`, so the card is never sitting in a queue-eligible list with a
stale lock on it. Locks older than 15 minutes are reaped; a merge run is normally far shorter
than that, and `release` failing with "no lock … (already released?)" is a non-event.

Only `Ready` cards are ever picked up. A card in `In Review` belongs to Max however long it
sits there, and an `Approved` card parked in `Backlog` was parked deliberately.

## Find the PR

Everything in this phase runs from the **main checkout**, on `main`. There is no worktree to
enter — the branch is about to disappear, not be worked on.

```bash
REPO=/Users/maxheimbrock/dev/learning/switchboard
cd "$REPO"
SHORT=<the card's shortUrl, from claim>

# Primary: build-card writes `Trello: <shortUrl>` into every PR body. Match on that —
# it survives a renamed card and a branch prefix you can't guess from the title.
gh pr list --state all --limit 100 --json number,state,isDraft,headRefName,url,body \
  --jq "[.[] | select(.body | contains(\"$SHORT\"))] | map(del(.body))"
```

If that finds nothing, fall back to the branch, whose slug is the card title lowercased with
non-alphanumerics collapsed to `-`. The prefix varies (`feat`/`fix`/`refactor`/`docs`) and the
slug is lossy, so this is a fallback, not the primary:

```bash
gh pr list --state all --limit 100 --json number,state,isDraft,headRefName,url \
  --jq '.[] | select(.headRefName | endswith("/<slug>"))'
```

**Exactly one open PR must match.** Anything else is a preflight failure: zero means the `PR`
label is wrong or the PR was closed, more than one means the card is ambiguous and Max has to
say which. Do not guess, and do not open or re-open anything.

An already-`MERGED` PR is not a failure — it means a previous run got as far as merging and
then died. Skip the merge, carry on with the cleanup, and say so in the closing comment. The
rest of this skill is idempotent by design.

## Preflight — the refusal list

Capture the state once and check all of it before touching anything:

```bash
PR=<number>
gh pr view "$PR" --json state,isDraft,mergeable,mergeStateStatus,reviewDecision,headRefName,url
gh pr view "$PR" --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | {name: (.name // .context), status, conclusion: (.conclusion // .state)}]'
git rev-parse --abbrev-ref HEAD          # must be `main`
```

Refuse — go to **When it cannot merge** — on any of these:

| Signal | Meaning | Why refuse |
|---|---|---|
| `state` is `CLOSED` | PR closed without merging | The card and the PR disagree; only Max can say which is right |
| `mergeable` is `CONFLICTING` | Branch conflicts with `main` | Resolving conflicts is build-card's job, on the branch. Tell Max to drop `Approved` and send it back |
| `mergeStateStatus` is `BLOCKED` / `DIRTY` | A branch rule or a conflict stands in the way | Not this skill's to override |
| `reviewDecision` is `CHANGES_REQUESTED` | A GitHub review is still asking for changes | The Trello label and the GitHub review disagree — Max resolves that, not you |
| a check is failing or still running | see below | Never merge red or pending |
| `HEAD` in the main checkout is not `main` | Max is mid-something | Merging would sync the wrong branch. Leave his checkout alone |

**Checks.** `statusCheckRollup` is the reliable source: `[]` means the PR has no checks at all,
which is normal on this fork and merges normally. Do **not** use `gh pr checks`' exit
status to decide — it exits `1` both for a failing check *and* for a PR with no checks, and
reading that as red would block every merge on the board.

When there are checks, every one must have finished and passed (`conclusion` of `SUCCESS`,
`NEUTRAL` or `SKIPPED`). Anything `IN_PROGRESS`, `QUEUED`, `PENDING`, `FAILURE`, `TIMED_OUT`
or `CANCELLED` stops the merge — including a check that is merely still running. Do not wait
for it and do not poll: report which check and hand the card back. The build workflow is a
four-platform Electron matrix and can take a long while; Max moving the card to `Ready` again
once it is green costs him one drag.

A **draft** PR is not a refusal. `Approved` is Max's explicit go-ahead, so mark it ready as
part of merging — a draft simply cannot be merged:

```bash
gh pr ready "$PR"
```

## Merge, then clean up — in this order

Nothing local is destroyed until the merge has actually landed. Never reorder these.

**1. Squash-merge.** One commit per card on `main`, revision-round commits collapsed into it —
which is exactly the shape build-card writes ("one commit for the card"). The PR title becomes
the commit subject, so build-card's conventional-commit subject carries through.

```bash
gh pr merge "$PR" --squash
```

No `--delete-branch`: it also reaches for the *local* branch, and that branch is checked out in
a worktree, so gh would try to switch branches in the main checkout to get rid of it. Delete
the branches explicitly below instead.

**2. Confirm it landed.** Everything after this is destructive, so do not take the exit code's
word for it:

```bash
gh pr view "$PR" --json state,mergeCommit --jq '{state, sha: .mergeCommit.oid}'
```

`state` must be `MERGED`. If it is not, stop here and report — the branch and worktree are
still intact.

**3. Bring the local `main` up to date.** This is load-bearing, not tidiness: build-card
branches new work from **local** `main`, so leaving it stale means the next card is built on a
tree without this one's changes.

```bash
git -C "$REPO" fetch origin --prune
git -C "$REPO" merge --ff-only origin/main
```

`--ff-only`, always. If it refuses, local `main` has commits the remote does not (Max commits
there directly) — say so in the closing comment and leave it alone. Never rebase, never reset,
never force, and never stash or discard uncommitted work in his checkout.

**4. Remove the worktree.** Find it by branch, not by re-deriving the slug from the card title
— the slug is lossy and the worktree may have been created under a different one:

```bash
BRANCH=<headRefName from the PR>
WT=$(git -C "$REPO" worktree list --porcelain \
     | awk -v b="refs/heads/$BRANCH" '/^worktree /{wt=$2} /^branch /{if ($2==b) print wt}')

if [ -n "$WT" ]; then
  rm -f "$WT/node_modules"                 # the symlink into the main checkout
  git -C "$WT" status --porcelain          # only NOW must this be empty
  git -C "$REPO" worktree remove "$WT"
fi
git -C "$REPO" worktree prune
```

**Remove the `node_modules` symlink before running `git status`, not after.** `.gitignore`
lists `node_modules/` with a trailing slash, which matches a directory — so the real
`node_modules` in the main checkout is ignored, but build-card's *symlink* of the same name in
a worktree is not, and shows up as `?? node_modules`. Check the status first and every single
worktree looks dirty, so the guard below would refuse every merge on the board.

**Once the symlink is gone, if `git status` is still not empty, stop and report.** That is
uncommitted work which never made it into the PR, and it is Max's to look at. Never
`worktree remove --force` to get past it, and never delete the directory with `rm -rf` — that
leaves git's worktree metadata behind. A missing worktree is fine: it may have been cleaned up
already, or the card built before the worktree convention.

**5. Delete the branches.**

```bash
git -C "$REPO" branch -D "$BRANCH"           # -D, not -d: a squash-merge leaves no ancestry
git -C "$REPO" push origin --delete "$BRANCH"
```

`-d` would refuse here — squashing rewrites the commits, so the branch is not an ancestor of
`main` even though its content is fully in. `-D` is only safe because step 2 confirmed
`MERGED`; never reach for it earlier. If the remote branch is already gone, gh or a previous
run got there first — a non-event.

## Finishing

In this order:

1. `"$T" release <id> <nonce>`, then `"$T" move <id> "Done"`.
2. `"$T" post-comment <id> <file>` — a short closing comment, no sentinel. It should say:
   the PR link and number, the squash commit sha, that the branch and worktree are gone, and
   **anything that did not go to plan** — local `main` that would not fast-forward, a worktree
   that was already missing, a PR that was already merged.

Do not edit the card description. `## Spec` and `## Plan` are the record of what was agreed and
they stay as they are.

```
Merged ✅

PR #1 → `main` as a squash commit (`a1b2c3d`).
Branch `feat/remove-branch-button-on-sessions` deleted locally and on origin; worktree removed.
Local `main` fast-forwarded to origin.
```

## When it cannot merge

Any preflight refusal, a merge that does not land, or a worktree holding uncommitted work.

1. **Change nothing.** Do not merge, do not delete a branch or worktree, do not push, do not
   touch the `Approved` label.
2. `"$T" post-comment <id> <file>` — a plain report, no sentinel and no questionnaire. Say
   what stopped it, quote the evidence (the failing check's name, the conflicting files,
   `mergeStateStatus`), and say in one line what Max needs to do.
3. `"$T" release <id> <nonce>`, then `"$T" move <id> "In Review"`.
4. Stop. Do not retry, and do not work around it.

The report must name the move that unblocks it, because the two are opposites:

- *Fixable outside the code* — a pending or failing check, a stale GitHub review: **leave
  `Approved` on** and move the card back to `Ready` when it is sorted. This skill picks it up
  again.
- *Needs code* — a conflict, changes requested, work left uncommitted in the worktree:
  **remove `Approved`** and move it to `Ready`. That hands it to build-card for another
  revision round on the same branch and PR.

```
Not merged ❌

The `build (mac)` check is still running (queued 6 min ago); the rest have not started.
Nothing was changed — the branch, the worktree and the PR are exactly as they were.

Leave `Approved` on and move the card back to Ready once the checks are green.
```

## Never

- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
- Run any `trello.py` queue command without `--phase merge`.
- Add or remove the `Approved` label. It is Max's gate; the helper refuses it for a reason.
- Merge a PR with a failing or still-running check, a conflict, or changes requested.
- Read `gh pr checks`' exit code as a verdict — it is `1` for a PR with no checks at all.
- Merge anything other than the one PR that matches the claimed card.
- Edit repo code, commit, push to a branch, resolve a conflict, or re-run a build. If the PR
  needs any of that, it is build-card's, and Max routes it there by removing `Approved`.
- Delete a worktree with uncommitted changes in it, `worktree remove --force`, or `rm -rf` a
  worktree directory. `?? node_modules` alone is not uncommitted work — it is build-card's
  symlink, which step 4 removes before it checks.
- `git checkout`, rebase, reset, force-push or stash in the main checkout, or fast-forward
  `main` past commits Max has only locally.
- Move a card to `Done` without a confirmed `MERGED` state on its PR.
- Act on a card in `In Review`, or move a card out of `In Review` — that is Max's move.
- Touch cards on any board but Switchboard, or cards without the `Approved` label.
