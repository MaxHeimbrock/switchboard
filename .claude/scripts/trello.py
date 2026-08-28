#!/usr/bin/env python3
"""Trello helper for the Switchboard pipeline. Shared by every phase skill.

Credentials are read from ~/.trello.env (TRELLO_KEY / TRELLO_TOKEN) and never printed.

The board runs one card through three phases, each owned by a different skill. A
phase is defined by the label it REQUIRES on a card (the last phase completed) and
the label it PRODUCES when it finishes. Pass --phase before the subcommand; it
defaults to `spec` so spec-card's existing invocations keep working unchanged.

  --phase spec   no phase label  -> Spec    (spec-card)
  --phase plan   Spec            -> Plan    (plan-card)
  --phase pr     Plan or PR      -> PR      (build-card)

The pr phase accepts its own output label as well as its input one: a card Max has
reviewed and moved back to Ready carries PR already, and comes round again for
another pass on the same branch. `pick`/`claim` report that as "revision": true.

Subcommands:
  pick                     inspect the next card this phase owns (read-only, no claim)
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

# Labels mark the last phase COMPLETED, not the phase in flight. Pipeline order -
# a card carrying several is at the furthest one along.
PHASE_LABELS = ("Spec", "Plan", "PR")

# Each phase's questionnaire sentinel must be distinct, so one phase never reads
# another phase's questions as its own. Authorship cannot be used to tell a
# skill's comments from Max's: the API token acts as Max himself.
#
# `requires` is the set of phase states a card may be in for this phase to own it,
# where the state is the FURTHEST label on the card (see phase_of). It is a tuple
# because the pr phase also accepts its own `produces` label: a card that already
# has a PR, has been reviewed, and that Max moved back to Ready is asking for
# another round of implementation on the same branch, not a second PR.
PHASES = {
    "spec": {
        "requires": (None,),
        "produces": "Spec",
        "sentinel": "Spec-me round",
        # Backlog is in scope only for the first phase - a card parked there with a
        # phase label already on it was parked deliberately.
        "lists": ("Ready", "Backlog"),
    },
    "plan": {
        "requires": ("Spec",),
        "produces": "Plan",
        "sentinel": "Plan-me round",
        "lists": ("Ready",),
    },
    "pr": {
        "requires": ("Plan", "PR"),
        "produces": "PR",
        "sentinel": "Build-me round",
        "lists": ("Ready",),
    },
}
DEFAULT_PHASE = "spec"

# Advisory lock, needed because `pick` reading a card and the follow-up `move`
# are two round trips: without it, two agents both read the same Ready card
# before either moves it. Trello has no compare-and-swap, but comments are
# append-only with server timestamps, so the oldest live lock wins. Locks are
# phase-independent on purpose: a card being planned must not also be specced.
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


def sentinel_re(phase):
    return re.compile(rf"^{re.escape(PHASES[phase]['sentinel'])} (\d+)\b", re.IGNORECASE)


def first_line(text):
    text = (text or "").strip()
    return re.sub(r"^[^\w]+", "", text.splitlines()[0]) if text else ""


def sentinel_round(text, phase):
    m = sentinel_re(phase).match(first_line(text))
    return int(m.group(1)) if m else None


def phase_of(card):
    """The last phase completed on this card, by pipeline order - not by the order
    Trello happens to return the labels in."""
    names = {l["name"] for l in card.get("labels", [])}
    done = [name for name in PHASE_LABELS if name in names]
    return done[-1] if done else None


def cards_in(list_name):
    cards = api(
        "GET",
        f"/lists/{LISTS[list_name]}/cards",
        fields="id,name,desc,shortUrl,labels,pos,idList",
    )
    return sorted(cards, key=lambda c: c["pos"])


def eligible(phase):
    """Cards this phase owns, in board order, across the lists it may draw from."""
    for list_name in PHASES[phase]["lists"]:
        for card in cards_in(list_name):
            if phase_of(card) in PHASES[phase]["requires"]:
                yield card


def is_revision(card, phase):
    """True when the card already carries this phase's OWN output label, i.e. the
    phase ran to completion once and Max has sent it back for another pass. Only
    the pr phase can see this - it is the only one that accepts its own output."""
    return phase_of(card) == PHASES[phase]["produces"]


def mode_of(state):
    """new     - no questionnaire for this phase yet   -> post round 1
    resume  - answers arrived since round N           -> fold them in
    stalled - round N posted, no answers since        -> moved without answering"""
    if state["last_round"] == 0:
        return "new"
    return "resume" if state["has_new_answers"] else "stalled"


def cmd_pick(phase):
    """Strict trigger: only the phase's own lists are scanned.

    A card parked in In Progress / In Review is never picked up - In Progress is
    the mutex for a run in flight, In Review is waiting on Max, and Max moving it
    to Ready is the only signal that the review round is over.

    Mode comes from the comment thread, not from the list, because Max may drop a
    card into Ready that was never taken through this phase's questions.
    """
    for card in eligible(phase):
        state = thread_state(card["id"], phase)
        print(
            json.dumps(
                {
                    "card": summarise(card),
                    "phase": phase,
                    "mode": mode_of(state),
                    "revision": is_revision(card, phase),
                    "last_round": state["last_round"],
                    "answers_since": state["answers_since"],
                },
                indent=2,
            )
        )
        return
    print(json.dumps({"card": None, "phase": phase}))


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


def thread_state(card_id, phase):
    """Split a card's comment thread into this phase's questionnaires and the answers
    after the latest one. Authorship is useless here - the API token acts as Max
    himself, so comments a skill posts are attributed to him. The sentinel is the
    only signal, and it is phase-specific: an earlier phase's questions and answers
    are just ordinary older comments to this one."""
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
                "round": sentinel_round(a["data"]["text"], phase),
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
    m = LOCK.match(first_line(text))
    return m.group(1).lower() if m else None


def parse_date(iso):
    return datetime.datetime.fromisoformat(iso.replace("Z", "+00:00"))


def post_comment(card_id, text):
    return api("POST", f"/cards/{card_id}/actions/comments", text=text)


def delete_comment(card_id, action_id):
    api("DELETE", f"/cards/{card_id}/actions/{action_id}/comments")


def live_locks(card_id, phase):
    """Locks that still count, oldest first. Anything older than
    STALE_LOCK_SECONDS is a crashed run's leftover - delete it and move on."""
    now = datetime.datetime.now(datetime.timezone.utc)
    live = []
    for lk in thread_state(card_id, phase)["locks"]:
        if (now - parse_date(lk["date"])).total_seconds() > STALE_LOCK_SECONDS:
            delete_comment(card_id, lk["id"])
            continue
        live.append(lk)
    return live


def cmd_claim(phase):
    """Take an exclusive claim on the next eligible card, or report none.

    `pick` alone is not safe: reading the card and moving it are two round trips,
    so two agents can both read the same Ready card before either moves it. Here
    the lock comment is posted FIRST, then the thread is re-read - whoever's lock
    is oldest owns the card, and the loser withdraws. Trello orders comments
    server-side, which is what makes this decidable at all.
    """
    for card in eligible(phase):
        card_id = card["id"]
        if live_locks(card_id, phase):
            continue  # somebody else is mid-run on this card
        nonce = uuid.uuid4().hex[:12]
        mine = post_comment(card_id, f"{LOCK_PREFIX}{nonce}")
        holders = live_locks(card_id, phase)
        if not holders or holders[0]["lock"] != nonce:
            delete_comment(card_id, mine["id"])
            continue  # lost the race; try the next card
        state = thread_state(card_id, phase)
        api("PUT", f"/cards/{card_id}", idList=LISTS["In Progress"])
        card["idList"] = LISTS["In Progress"]
        print(
            json.dumps(
                {
                    "card": summarise(card),
                    "phase": phase,
                    "mode": mode_of(state),
                    "revision": is_revision(card, phase),
                    "last_round": state["last_round"],
                    "answers_since": state["answers_since"],
                    "lock": nonce,
                },
                indent=2,
            )
        )
        return
    print(json.dumps({"card": None, "phase": phase}))


def cmd_release(card_id, nonce):
    for lk in thread_state(card_id, DEFAULT_PHASE)["locks"]:
        if lk["lock"] == nonce.lower():
            delete_comment(card_id, lk["id"])
            print(f"released {nonce} on {card_id}")
            return
    sys.exit(f"no lock {nonce!r} on {card_id} (already released?)")


def cmd_comments(card_id, phase):
    print(json.dumps(thread_state(card_id, phase), indent=2))


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


# name -> (fn, positional argc, wants the phase appended)
COMMANDS = {
    "pick": (cmd_pick, 0, True),
    "claim": (cmd_claim, 0, True),
    "release": (cmd_release, 2, False),
    "card": (cmd_card, 1, False),
    "comments": (cmd_comments, 1, True),
    "post-comment": (cmd_post_comment, 2, False),
    "set-desc": (cmd_set_desc, 2, False),
    "move": (cmd_move, 2, False),
    "label": (cmd_label, 2, False),
}


def take_phase(argv):
    """Pull --phase/-p out of argv wherever it sits, so it can precede or follow
    the subcommand."""
    phase = DEFAULT_PHASE
    rest = []
    skip = -1
    for i, arg in enumerate(argv):
        if i == skip:
            continue
        if arg.startswith("--phase="):
            phase = arg.split("=", 1)[1]
        elif arg in ("--phase", "-p"):
            if i + 1 >= len(argv):
                sys.exit("--phase needs a value")
            phase = argv[i + 1]
            skip = i + 1
        else:
            rest.append(arg)
    if phase not in PHASES:
        sys.exit(f"unknown phase {phase!r}; one of {', '.join(PHASES)}")
    return phase, rest


def main():
    phase, argv = take_phase(sys.argv[1:])
    if not argv or argv[0] not in COMMANDS:
        sys.exit(__doc__)
    fn, argc, wants_phase = COMMANDS[argv[0]]
    args = argv[1:]
    if len(args) != argc:
        sys.exit(f"{argv[0]} takes {argc} argument(s); got {len(args)}")
    if wants_phase:
        fn(*args, phase)
    else:
        fn(*args)


if __name__ == "__main__":
    main()
