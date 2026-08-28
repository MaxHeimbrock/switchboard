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

**Read `PIPELINE.md` (next to this file) before your first `claim`.** It carries the rules
every phase on this board shares: the board model, the two lists that are Max's, the helper
and its commands, the claim/lock protocol, and how a phase ends. This file carries only what
is specific to the merge phase.

## This phase

| | |
|---|---|
| **Flag** | **`--phase merge`** on every queue command — without it you get the spec phase's view |
| **Claims** | `Ready` cards carrying `Approved` |
| **Produces** | **no label.** There is no `Merged` label; landing in `Done` is the record |
| **Sentinel** | none — this phase has no questionnaires and no rounds |
| **Writes** | nothing in the repo. It merges, syncs `main`, and deletes branches and worktrees |

```
REPO=/Users/maxheimbrock/dev/learning/switchboard
T="$REPO/.claude/skills/merge-card/scripts/trello.py"

"$T" --phase merge claim        # claim the next approved card — START HERE
"$T" release <id> <nonce>       # drop the claim when you stop
"$T" --phase merge comments <id># the card's comment thread
"$T" post-comment <id> <file>   # post a comment from a file
"$T" move <id> "Done"
```

## The `Approved` label

`Approved` (blue) is the fourth label on the board and the only one **Max applies by hand**.
`Spec`, `Plan` and `PR` are stamped by the skill that produced them; `Approved` is the human
gate in front of the merge. He adds it in Trello while the card is in `In Review`, once he has
tested the PR and is happy for it to land — then moves the card to `Ready`, which is what
hands it to this skill. `"$T" label` refuses `Approved` outright.

It routes as well as gates. `phase_of` takes the **furthest** label in pipeline order
(`Spec` → `Plan` → `PR` → `Approved`), so an approved card no longer reads as a `PR` card and
drops out of build-card's queue automatically. That is what stops the two skills fighting over
the same `Ready` card:

| Card in `Ready` with | Belongs to |
|---|---|
| `Plan` | build-card — first build |
| `PR` | build-card — another revision round on the same branch |
| `Approved` | **this skill** |

Removing `Approved` is how Max hands a card back to build-card. That is his move, never yours.

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

### Claiming

The claim/lock protocol is in `PIPELINE.md §4` — always `claim`, never act on `pick`. The
stake here is the highest on the board: **the loser of the race would try to merge a PR the
winner has already merged and deleted the branch of.** Never work a card you did not win.

A merge run is normally far shorter than the 15-minute lock reaper, and `release` failing
with `no lock … (already released?)` is a non-event.

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

`PIPELINE.md §9` applies in full. In particular, and specific to this phase:

- Run any `trello.py` queue command without `--phase merge`.
- Add or remove the `Approved` label. It is Max's gate; the helper refuses it for a reason.
- Act on a card in `In Review`, or move a card out of `In Review` — that is Max's move.
- Print `TRELLO_TOKEN`, or paste a URL containing it into output.
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
- Touch cards without the `Approved` label.
