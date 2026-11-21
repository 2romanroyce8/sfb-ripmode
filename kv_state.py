#!/usr/bin/env python3
"""Read/write the RIP MODE dialer `state` value in KV namespace ripmode-data.

Uses the same credential mechanism as deploy.py (dynamic_credentials
surrogate for custom.cloudflare). This script NEVER touches worker code or
bindings — it only reads/writes one KV key ("state"). Load procedure:

  1. python3 kv_state.py read   -> prints a summary + writes a timestamped
     backup of the live state to state-backup-*.json (never overwritten).
  2. Edit the leads file (leads-naples-239.json) — one object per lead:
     {id, business, niche, city, phone, owner, email, stage}.
  3. python3 kv_state.py append leads-naples-239.json -> reads live state,
     skips any lead whose normalized phone or business already exists,
     appends the rest, writes back, then re-reads and verifies counts and
     that the two seed leads + callLogs + sessionStats are unchanged.

IDs for new leads: "lead-naples-<slug>-<n>" (deterministic, no random).
Phone format in state matches the seeds: "(239) 555-0100" display form.
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT = "212fe192b20e1827e2b4f8bd55928918"
KV_NS = "c4dd1ffc591b47c08a0946996b30d862"  # ripmode-data
BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/storage/kv/namespaces/{KV_NS}/values/state"
HERE = os.path.dirname(os.path.abspath(__file__))


def kv_get():
    req = urllib.request.Request(BASE, method="GET")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    resp = urllib.request.urlopen(req, timeout=30)
    return json.loads(resp.read().decode())


def kv_put(state):
    body = json.dumps(state).encode()
    req = urllib.request.Request(BASE, method="PUT", data=body)
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    req.add_header("Content-Type", "application/json")
    resp = urllib.request.urlopen(req, timeout=30)
    return resp.status


def norm_phone(p):
    return re.sub(r"\D", "", p or "")[-10:]


def norm_name(n):
    return re.sub(r"[^a-z0-9]", "", (n or "").lower())


def summary(state):
    leads = state.get("leads", [])
    return {
        "leads": len(leads),
        "lead_names": [l.get("business") for l in leads],
        "callLogs": len(state.get("callLogs", [])),
        "conversations": len(state.get("conversations", [])),
        "meetings": len(state.get("meetings", [])),
        "sessionStats": state.get("sessionStats", {}),
        "top_keys": sorted(state.keys()),
    }


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "read"
    if cmd == "read":
        state = kv_get()
        ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        backup = os.path.join(HERE, f"state-backup-{ts}.json")
        with open(backup, "w") as f:
            json.dump(state, f, indent=2)
        print("Backup written:", backup)
        print(json.dumps(summary(state), indent=2))
    elif cmd == "append":
        path = sys.argv[2]
        with open(path) as f:
            new_leads = json.load(f)
        before = kv_get()
        before_sum = summary(before)
        existing_phones = {norm_phone(l.get("phone")) for l in before.get("leads", [])}
        existing_names = {norm_name(l.get("business")) for l in before.get("leads", [])}
        added, skipped = [], []
        for lead in new_leads:
            if norm_phone(lead.get("phone")) in existing_phones or norm_name(lead.get("business")) in existing_names:
                skipped.append(lead.get("business"))
                continue
            before["leads"].append(lead)
            existing_phones.add(norm_phone(lead.get("phone")))
            existing_names.add(norm_name(lead.get("business")))
            added.append(lead.get("business"))
        status = kv_put(before)
        print(f"PUT status: {status}")
        after = kv_get()
        after_sum = summary(after)
        # Verify: history untouched, counts as expected, all added names present.
        # NOTE: the two seed leads (Jax / Performance) are NOT in live KV state
        # as of 2026-11-21 (state read showed 0 leads, 0 callLogs) — that is a
        # pre-existing condition, reported to the parent; this script does NOT
        # assert their presence and does NOT re-create them.
        assert after_sum["callLogs"] == before_sum["callLogs"], "callLogs changed!"
        assert after_sum["meetings"] == before_sum["meetings"], "meetings changed!"
        assert after_sum["sessionStats"] == before_sum["sessionStats"], "sessionStats changed!"
        assert after_sum["leads"] == before_sum["leads"] + len(added), "lead count mismatch!"
        missing = [n for n in added if n not in after_sum["lead_names"]]
        assert not missing, f"added leads missing after write: {missing}"
        print(f"Added {len(added)} leads, skipped {len(skipped)} duplicates.")
        print("Added:", added)
        print("Skipped:", skipped)
        print(f"Total leads now: {after_sum['leads']}")
        print(json.dumps(after_sum, indent=2))
    else:
        print("Usage: kv_state.py read | append <leads.json>")
        sys.exit(1)


if __name__ == "__main__":
    main()
