#!/usr/bin/env python3
"""Trello helper for the Switchboard spec pipeline.

Credentials are read from ~/.trello.env (TRELLO_KEY / TRELLO_TOKEN) and never printed.

Subcommands:
  pick                     inspect the next card this skill owns (read-only, no claim)
  claim                    pick AND lock it -> JSON with a nonce, or {"card": null}
  release <id> <nonce>     drop the lock taken by claim
  card <id>                dump one card as JSON (name, desc, list, labels)
  comments <id>            JSON: all comments oldest-first, plus questionnaire/answer split
  post-comment <id> <file> post file contents as a comment
  set-desc <id> <file>     replace the card description with file contents
  move <id> <list>         move card to Backlog|Ready|In Progress|In Review|Done
  label <id> <name>        add label Spec|Plan|PR (no-op if already present)
"""
import datetime
import json
import os
import re
import sys
import uuid
import urllib.parse
import urllib.request

BOARD = "6a914ef6b93c83b3be4f20e8"

LISTS = {
    "Backlog": "6a9153ecc471e84a6585d684",
    "Ready": "6a914f012321af82cbe0058d",
    "In Progress": "6a914f0716aaaa63eb91d112",
    "In Review": "6a914f0a6c4570258dfff996",
    "Done": "6a914f0eed054adf19c0e050",
}
LIST_NAMES = {v: k for k, v in LISTS.items()}

# Labels mark the last phase COMPLETED, not the phase in flight.
PHASE_LABELS = ("Spec", "Plan", "PR")

# Every questionnaire comment's first line must match this once leading
# non-alphanumerics (an emoji) are stripped. Authorship cannot be used to tell
# the skill's comments from Max's: the API token acts as Max himself.
SENTINEL = re.compile(r"^Grill-me round (\d+)\b", re.IGNORECASE)

# Advisory lock, needed because `pick` reading a card and the follow-up `move`
# are two round trips: without it, two agents both read the same Ready card
# before either moves it. Trello has no compare-and-swap, but comments are
# append-only with server timestamps, so the oldest live lock wins.
LOCK = re.compile(r"^lock ([0-9a-f]{12})\b", re.IGNORECASE)
LOCK_PREFIX = "\U0001F512 lock "
STALE_LOCK_SECONDS = 900  # a crashed run must not wedge a card forever


def creds():
    path = os.path.expanduser("~/.trello.env")
    env = {}
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'\"")
    except FileNotFoundError:
        sys.exit(f"missing {path} (needs TRELLO_KEY / TRELLO_TOKEN)")
    if not env.get("TRELLO_KEY") or not env.get("TRELLO_TOKEN"):
        sys.exit(f"{path} must define TRELLO_KEY and TRELLO_TOKEN")
    return env["TRELLO_KEY"], env["TRELLO_TOKEN"]


KEY, TOKEN = creds()


def api(method, path, **params):
    params.update(key=KEY, token=TOKEN)
    url = f"https://api.trello.com/1{path}"
    data = urllib.parse.urlencode(params).encode()
    if method in ("GET", "DELETE"):
        url = f"{url}?{urllib.parse.urlencode(params)}"
        data = None
    req = urllib.request.Request(url, data=data, method=method)
    try:
        with urllib.request.urlopen(req) as resp:
            body = resp.read().decode()
    except urllib.error.HTTPError as exc:
        # Never echo the query string back - it carries the token.
        sys.exit(f"trello {method} {path} failed: {exc.code} {exc.reason}")
    return json.loads(body) if body else None


def sentinel_round(text):
    first = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    stripped = re.sub(r"^[^\w]+", "", first)
    m = SENTINEL.match(stripped)
    return int(m.group(1)) if m else None


def phase_of(card):
    done = [l["name"] for l in card.get("labels", []) if l["name"] in PHASE_LABELS]
    return done[-1] if done else None


def cards_in(list_name):
    cards = api(
        "GET",
        f"/lists/{LISTS[list_name]}/cards",
        fields="id,name,desc,shortUrl,labels,pos,idList",
    )
    return sorted(cards, key=lambda c: c["pos"])


def cmd_pick():
    """Strict trigger: only Backlog and Ready cards are ours.

    A card parked in In Progress / In Review is never picked up - In Progress is
    the mutex for a run in flight, In Review is waiting on Max, and Max moving it
    to Ready is the only signal that the review round is over.

    Mode comes from the comment thread, not from the list, because Max may drop a
    card straight into Ready without it ever having been grilled:
      new     - no questionnaire yet          -> post round 1
      resume  - answers arrived since round N -> fold them in
      stalled - round N posted, no answers    -> he moved it without answering
    """
    for list_name in ("Ready", "Backlog"):
        for card in cards_in(list_name):
            if phase_of(card) is not None:
                continue
            state = thread_state(card["id"])
            if state["last_round"] == 0:
                mode = "new"
            elif state["has_new_answers"]:
                mode = "resume"
            else:
                mode = "stalled"
            print(
                json.dumps(
                    {
                        "card": summarise(card),
                        "mode": mode,
                        "last_round": state["last_round"],
                        "answers_since": state["answers_since"],
                    },
                    indent=2,
                )
            )
            return
    print(json.dumps({"card": None}))


def summarise(card):
    return {
        "id": card["id"],
        "name": card["name"],
        "url": card["shortUrl"],
        "list": LIST_NAMES.get(card.get("idList"), card.get("idList")),
        "labels": [l["name"] for l in card.get("labels", [])],
        "phase_done": phase_of(card),
        "desc": card.get("desc", ""),
    }


def cmd_card(card_id):
    card = api(
        "GET", f"/cards/{card_id}", fields="id,name,desc,shortUrl,labels,pos,idList"
    )
    print(json.dumps(summarise(card), indent=2))


def thread_state(card_id):
    """Split a card's comment thread into questionnaires and the answers after the
    latest one. Authorship is useless here - the API token acts as Max himself, so
    comments this skill posts are attributed to him. The sentinel is the only signal."""
    actions = api(
        "GET", f"/cards/{card_id}/actions", filter="commentCard", limit="1000"
    )
    everything = sorted(
        (
            {
                "id": a["id"],
                "date": a["date"],
                "author": a["memberCreator"]["username"],
                "text": a["data"]["text"],
                "round": sentinel_round(a["data"]["text"]),
                "lock": lock_nonce(a["data"]["text"]),
            }
            for a in actions
        ),
        key=lambda c: (c["date"], c["id"]),
    )
    # Lock comments are bookkeeping. They must never be mistaken for an answer -
    # otherwise taking a lock would itself flip the card to mode "resume".
    locks = [c for c in everything if c["lock"]]
    comments = [c for c in everything if not c["lock"]]
    questionnaires = [c for c in comments if c["round"] is not None]
    last_q = questionnaires[-1] if questionnaires else None
    answers = (
        [c for c in comments if c["round"] is None and c["date"] > last_q["date"]]
        if last_q
        else []
    )
    return {
        "comments": comments,
        "locks": locks,
        "last_round": last_q["round"] if last_q else 0,
        "last_questionnaire_at": last_q["date"] if last_q else None,
        "answers_since": answers,
        "has_new_answers": bool(answers),
    }


def lock_nonce(text):
    first = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    m = LOCK.match(re.sub(r"^[^\w]+", "", first))
    return m.group(1).lower() if m else None


def parse_date(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def post_comment(card_id, text):
    return api("POST", f"/cards/{card_id}/actions/comments", text=text)


def delete_comment(card_id, action_id):
    api("DELETE", f"/cards/{card_id}/actions/{action_id}/comments")


def live_locks(card_id):
    """Locks that still count, oldest first. Anything older than
    STALE_LOCK_SECONDS is a crashed run's leftover - delete it and move on."""
    now = datetime.datetime.now(datetime.timezone.utc)
    live = []
    for lk in thread_state(card_id)["locks"]:
        if (now - parse_date(lk["date"])).total_seconds() > STALE_LOCK_SECONDS:
            delete_comment(card_id, lk["id"])
            continue
        live.append(lk)
    return live


def cmd_claim():
    """Take an exclusive claim on the next eligible card, or report none.

    `pick` alone is not safe: reading the card and moving it are two round trips,
    so two agents can both read the same Ready card before either moves it. Here
    the lock comment is posted FIRST, then the thread is re-read - whoever's lock
    is oldest owns the card, and the loser withdraws. Trello orders comments
    server-side, which is what makes this decidable at all.
    """
    for list_name in ("Ready", "Backlog"):
        for card in cards_in(list_name):
            if phase_of(card) is not None:
                continue
            card_id = card["id"]
            if live_locks(card_id):
                continue  # somebody else is mid-run on this card
            nonce = uuid.uuid4().hex[:12]
            mine = post_comment(card_id, f"{LOCK_PREFIX}{nonce}")
            holders = live_locks(card_id)
            if not holders or holders[0]["lock"] != nonce:
                delete_comment(card_id, mine["id"])
                continue  # lost the race; try the next card
            state = thread_state(card_id)
            if state["last_round"] == 0:
                mode = "new"
            elif state["has_new_answers"]:
                mode = "resume"
            else:
                mode = "stalled"
            api("PUT", f"/cards/{card_id}", idList=LISTS["In Progress"])
            card["idList"] = LISTS["In Progress"]
            print(
                json.dumps(
                    {
                        "card": summarise(card),
                        "mode": mode,
                        "last_round": state["last_round"],
                        "answers_since": state["answers_since"],
                        "lock": nonce,
                    },
                    indent=2,
                )
            )
            return
    print(json.dumps({"card": None}))


def cmd_release(card_id, nonce):
    for lk in thread_state(card_id)["locks"]:
        if lk["lock"] == nonce.lower():
            delete_comment(card_id, lk["id"])
            print(f"released {nonce} on {card_id}")
            return
    sys.exit(f"no lock {nonce!r} on {card_id} (already released?)")


def cmd_comments(card_id):
    print(json.dumps(thread_state(card_id), indent=2))


def read_file(path):
    with open(path) as fh:
        return fh.read()


def cmd_post_comment(card_id, path):
    api("POST", f"/cards/{card_id}/actions/comments", text=read_file(path))
    print(f"comment posted to {card_id}")


def cmd_set_desc(card_id, path):
    api("PUT", f"/cards/{card_id}", desc=read_file(path))
    print(f"description updated on {card_id}")


def cmd_move(card_id, list_name):
    if list_name not in LISTS:
        sys.exit(f"unknown list {list_name!r}; one of {', '.join(LISTS)}")
    api("PUT", f"/cards/{card_id}", idList=LISTS[list_name])
    print(f"moved {card_id} -> {list_name}")


def cmd_label(card_id, name):
    if name not in PHASE_LABELS:
        sys.exit(f"unknown label {name!r}; one of {', '.join(PHASE_LABELS)}")
    labels = api("GET", f"/boards/{BOARD}/labels", fields="id,name")
    match = next((l for l in labels if l["name"] == name), None)
    if not match:
        sys.exit(f"board has no label named {name!r}")
    card = api("GET", f"/cards/{card_id}", fields="labels")
    if any(l["name"] == name for l in card["labels"]):
        print(f"{card_id} already labelled {name}")
        return
    api("POST", f"/cards/{card_id}/idLabels", value=match["id"])
    print(f"labelled {card_id} {name}")


COMMANDS = {
    "pick": (cmd_pick, 0),
    "claim": (cmd_claim, 0),
    "release": (cmd_release, 2),
    "card": (cmd_card, 1),
    "comments": (cmd_comments, 1),
    "post-comment": (cmd_post_comment, 2),
    "set-desc": (cmd_set_desc, 2),
    "move": (cmd_move, 2),
    "label": (cmd_label, 2),
}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit(__doc__)
    fn, argc = COMMANDS[sys.argv[1]]
    args = sys.argv[2:]
    if len(args) != argc:
        sys.exit(f"{sys.argv[1]} takes {argc} argument(s); got {len(args)}")
    fn(*args)


if __name__ == "__main__":
    main()
