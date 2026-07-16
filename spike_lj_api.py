#!/usr/bin/env python3
"""Spike: is LiveJournal's export protocol still alive, on this account, today?

Everything in the project brief assumes authenticated XML-RPC still works. This
proves it or kills it, in five requests:

  1. LJ.XMLRPC.getchallenge     is the XML-RPC interface up at all?
  2. LJ.XMLRPC.login            does challenge-response auth still work?
  3. LJ.XMLRPC.getevents        do entries come back, with security levels?
  4. LJ.XMLRPC.sessiongenerate  can we mint a cookie session?
  5. export_comments.bml        does the comment export endpoint still serve?

Steps 4 and 5 are the interesting ones: comment export is not XML-RPC. It wants
a cookie session, which you mint over XML-RPC and then hand to a plain GET. If
anything here is going to have rotted, it is most likely that.

Stdlib only. Nothing is written to disk. Throwaway — this is not the fetch
layer, it just tells us whether there can be one.
"""

from __future__ import annotations

import getpass
import hashlib
import os
import resource
import sys
import urllib.error
import urllib.request
import xmlrpc.client
from xml.etree import ElementTree

XMLRPC_URL = "https://www.livejournal.com/interface/xmlrpc"
COMMENTS_URL = "https://www.livejournal.com/export_comments.bml"
CLIENT_VERSION = "Python-neo-lj-archive-spike/0.1"


class Secret:
    """A credential that cannot be accidentally printed, logged, or rendered
    into a traceback. reveal() is the only way out, so every use is greppable.

    This does not defend against a coredump — whatever key we obfuscated with
    would be in the same dump. It defends against the leak that actually
    happens, which is a stray f-string in a log line.
    """

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        object.__setattr__(self, "_value", value)

    def reveal(self) -> str:
        return self._value

    def __repr__(self) -> str:
        return "<Secret redacted>"

    __str__ = __repr__

    def __setattr__(self, *_: object) -> None:
        raise AttributeError("Secret is immutable")


class Transport(xmlrpc.client.SafeTransport):
    user_agent = CLIENT_VERSION


def ok(msg: str) -> None:
    print(f"  ok    {msg}")


def info(msg: str) -> None:
    print(f"        {msg}")


def die(step: str, err: object) -> None:
    print(f"  FAIL  {step}: {err}\n", file=sys.stderr)
    sys.exit(1)


def auth(server: xmlrpc.client.ServerProxy, user: str, pw_md5: Secret) -> dict:
    """Build auth params. Challenges are single-use and expire in ~60s, so this
    runs fresh for every request — worth knowing before designing a session.
    """
    challenge = server.LJ.XMLRPC.getchallenge()["challenge"]
    response = hashlib.md5(
        (challenge + pw_md5.reveal()).encode("utf-8")
    ).hexdigest()
    return {
        "username": user,
        "auth_method": "challenge",
        "auth_challenge": challenge,
        "auth_response": response,
        "ver": 1,
        "clientversion": CLIENT_VERSION,
    }


def main() -> None:
    try:
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except (ValueError, OSError):
        print("  !     could not disable coredumps; continuing", file=sys.stderr)

    print(__doc__.split("\n\n")[0])
    print()

    # Env vars are runtime injection, not storage. Popped immediately so they
    # don't outlive the read or get inherited by anything.
    user = os.environ.pop("LJ_USER", "") or input("LJ username: ").strip()
    password = os.environ.pop("LJ_PASSWORD", "") or getpass.getpass(
        "LJ password (not echoed, not stored): "
    )
    pw_md5 = Secret(hashlib.md5(password.encode("utf-8")).hexdigest())
    del password

    server = xmlrpc.client.ServerProxy(XMLRPC_URL, transport=Transport())

    print("\n[1/5] getchallenge")
    try:
        challenge = server.LJ.XMLRPC.getchallenge()
    except Exception as e:
        die("XML-RPC interface unreachable", e)
    ok(f"interface is up (challenge expires in {challenge.get('expire_at', '?')})")

    print("\n[2/5] login")
    try:
        login = server.LJ.XMLRPC.login(auth(server, user, pw_md5))
    except xmlrpc.client.Fault as e:
        die("challenge-response auth rejected", e.faultString)
    except Exception as e:
        die("login failed", e)
    ok(f"authenticated as {login.get('username', user)}")
    if login.get("fullname"):
        info(f"fullname: {login['fullname']}")
    if login.get("usejournals"):
        info(f"also has access to: {', '.join(login['usejournals'])}")

    print("\n[3/5] getevents (3 most recent, gentlest possible probe)")
    try:
        events = server.LJ.XMLRPC.getevents(
            {
                **auth(server, user, pw_md5),
                "selecttype": "lastn",
                "howmany": 3,
                "lineendings": "unix",
            }
        )["events"]
    except xmlrpc.client.Fault as e:
        die("getevents rejected", e.faultString)
    except Exception as e:
        die("getevents failed", e)

    ok(f"{len(events)} entries returned")
    for ev in events:
        body = ev.get("event", "")
        if isinstance(body, xmlrpc.client.Binary):
            body = body.data.decode("utf-8", "replace")
        subject = (ev.get("subject") or "(no subject)")[:48]
        info(
            f"#{ev['itemid']}  {ev['eventtime']}  "
            f"[{ev.get('security', 'public')}]  {len(body)}b  {subject}"
        )
    if any(e.get("security") in ("private", "usemask") for e in events):
        info("locked entries come through authenticated — confirmed")

    print("\n[4/5] sessiongenerate")
    try:
        session = server.LJ.XMLRPC.sessiongenerate(
            {**auth(server, user, pw_md5), "expiration": "short"}
        )
        ljsession = Secret(session["ljsession"])
    except xmlrpc.client.Fault as e:
        die("sessiongenerate rejected", e.faultString)
    except Exception as e:
        die("sessiongenerate failed", e)
    ok("cookie session minted")

    print("\n[5/5] export_comments.bml (comment_meta)")
    req = urllib.request.Request(
        f"{COMMENTS_URL}?get=comment_meta&startid=0",
        headers={
            "Cookie": f"ljsession={ljsession.reveal()}",
            "User-Agent": CLIENT_VERSION,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as e:
        die(f"comment export returned HTTP {e.code}", e.reason)
    except Exception as e:
        die("comment export failed", e)

    try:
        root = ElementTree.fromstring(raw)
    except ElementTree.ParseError:
        die("comment export returned non-XML", raw[:200])

    maxid = root.findtext("maxid")
    usermaps = root.findall(".//usermap")
    ok("comment export is alive")
    if maxid:
        info(f"maxid: {maxid}  (roughly, total comments ever on your journal)")
    info(f"{len(usermaps)} distinct commenters in this first page")

    print("\n" + "=" * 62)
    print("All five green. The protocol holds; the project is viable as briefed.")
    print("=" * 62 + "\n")


if __name__ == "__main__":
    main()
