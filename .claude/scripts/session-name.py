#!/usr/bin/env python3
"""Rename the running Claude Code session. Shared by every phase skill.

Switchboard's session list is the only place Max sees what his agents are doing, and
by default a row is titled with whatever the first prompt happened to say - four rows
reading "check the board" tell him nothing. Naming the session after the card and the
phase turns that list into a status board.

HOW IT WORKS. Claude Code keeps the transcript at ~/.claude/projects/<enc>/<id>.jsonl
and treats the LAST {"type": "custom-title"} record in it as the session's title -
that record is exactly what /title writes. Appending one here is the same move made by
the agent instead of by hand, so it is safe to call more than once: the newest wins.
Switchboard re-indexes the file when its mtime changes and promotes customTitle into
its own name column, so the row relabels itself within a few seconds.

The transcript is found by globbing for the session id rather than by encoding the
working directory, because build-card and merge-card run inside a git worktree whose
path is not the project the session was started in.

  session-name.py spec  "Add a close button"       ->  [spec] Add a close button
  session-name.py pr    "Add a close button" 2     ->  [build] Add a close button (2)
  session-name.py board "checking the queue"       ->  [board] checking the queue

The tag is your --phase flag, so the caller never has to remember that the pr phase is
spelled "build" on the board. Anything unrecognised is passed through as written.

Run 1 gets no suffix; the number only appears when a phase picks the same card up
again, which is the case worth spotting in the list. `claim` reports it as `run`.
"""
import glob
import json
import os
import sys

# The board's word for each phase, so a session never reads "[pr]" - Max calls that
# phase build, and the skill that owns it is build-card.
TAGS = {"spec": "spec", "plan": "plan", "pr": "build", "merge": "merge", "board": "board"}

# Long enough for any real card title, short enough to read in a narrow sidebar.
MAX_TEXT = 72


def transcript_path(session_id):
    hits = glob.glob(os.path.expanduser(f"~/.claude/projects/*/{session_id}.jsonl"))
    return hits[0] if hits else None


def main():
    args = sys.argv[1:]
    if not 2 <= len(args) <= 3:
        sys.exit(__doc__.strip().splitlines()[0] + "\nusage: session-name.py <phase> <text> [run]")

    tag = TAGS.get(args[0].lower(), args[0].lower().strip())
    text = " ".join(args[1].split())
    if len(text) > MAX_TEXT:
        text = text[: MAX_TEXT - 1].rstrip() + "…"

    suffix = ""
    if len(args) == 3:
        try:
            run = int(args[2])
        except ValueError:
            sys.exit(f"run must be a number, got {args[2]!r}")
        if run > 1:
            suffix = f" ({run})"

    title = f"[{tag}] {text}{suffix}"

    session_id = os.environ.get("CLAUDE_CODE_SESSION_ID")
    if not session_id:
        sys.exit("CLAUDE_CODE_SESSION_ID is not set - not running inside a Claude Code session")

    path = transcript_path(session_id)
    if not path:
        sys.exit(f"no transcript found for session {session_id}")

    with open(path, "a", encoding="utf-8") as f:
        f.write(
            json.dumps(
                {"type": "custom-title", "customTitle": title, "sessionId": session_id},
                ensure_ascii=False,
            )
            + "\n"
        )
    print(title)


if __name__ == "__main__":
    main()
