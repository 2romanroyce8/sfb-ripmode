#!/usr/bin/env python3
"""Merge verified lead-enrichment fields into the live KV state.leads.

Source: leads-enriched-2026-11-23.json — 46 objects, one per live lead,
in source order, each {id, business, phone, website, tags[], socials{},
owner, facts[{text, source}], callBrief, sources[]}.

Only SIX fields are written per lead: website, tags, socials, owner,
facts, callBrief — and only when the enriched value is present
(non-null, non-empty). A missing enriched field leaves the live value
alone (never overwrites with null). Nothing else is touched: no lead
is added/removed/reordered, and callLogs, meetings, conversations,
followUps, scripts, campaigns, sessionStats are byte-compared after
the write and must be identical.

Safety: aborts unless the enriched ids match the live ids 46/46 in
the same order. Writes a pre-merge backup locally, PUTs, re-reads,
and verifies before reporting success.
"""
import json
import os
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from kv_state import kv_get, kv_put

FIELDS = ["website", "tags", "socials", "owner", "facts", "callBrief"]


def present(v):
    if v is None:
        return False
    if isinstance(v, (str, list, dict)):
        return len(v) > 0
    return True


def main():
    enriched = json.load(open(os.path.join(HERE, "leads-enriched-2026-11-23.json")))
    assert len(enriched) == 46, f"enriched file has {len(enriched)} entries, expected 46"

    before = kv_get()
    live = before.get("leads", [])
    assert len(live) == 46, f"live state has {len(live)} leads, expected 46"

    live_ids = [l["id"] for l in live]
    enr_ids = [e["id"] for e in enriched]
    assert live_ids == enr_ids, (
        f"id mismatch: missing in live {[i for i in enr_ids if i not in live_ids]}, "
        f"extra in live {[i for i in live_ids if i not in enr_ids]}"
    )
    print("id match: 46/46, same order")

    # Pre-merge backup (local, never overwritten).
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    with open(os.path.join(HERE, f"enrich-backup-{ts}.json"), "w") as f:
        json.dump(before, f, indent=1)
    print(f"pre-merge backup: enrich-backup-{ts}.json")

    by_id = {e["id"]: e for e in enriched}
    counts = {f: 0 for f in FIELDS}
    for lead in live:
        e = by_id[lead["id"]]
        for f in FIELDS:
            if present(e.get(f)):
                lead[f] = e[f]
                counts[f] += 1
    print("fields written per lead:", counts)

    status = kv_put(before)
    print("PUT status:", status)
    assert status == 200, f"kv_put failed: {status}"

    # KV API reads are eventually consistent — the first re-read after a
    # write can still return the old value. Retry until the merged fields
    # show up (or time out), then run the full verification.
    first_want = by_id[live_ids[0]].get("website")
    after = None
    for attempt in range(7):
        after = kv_get()
        got = (after.get("leads", [{}])[0] or {}).get("website")
        if first_want is None or got == first_want:
            break
        print(f"re-read {attempt + 1}: stale (website={got!r}), retrying...")
        import time
        time.sleep(5)
    else:
        raise AssertionError("re-reads stayed stale after 7 attempts")
    print("re-read fresh after write")
    a_leads = after.get("leads", [])
    assert len(a_leads) == 46, f"after-write lead count {len(a_leads)}"
    assert [l["id"] for l in a_leads] == live_ids, "lead order/ids changed"
    # Only the six fields may differ per lead; everything else identical.
    for b, a in zip(live, a_leads):
        for k in b:
            if k not in FIELDS:
                assert a.get(k) == b[k], f"lead {b['id']}: field {k} changed"
        for f in FIELDS:
            want = by_id[b["id"]].get(f)
            if present(want):
                assert a.get(f) == want, f"lead {b['id']}: field {f} not written"
    # Non-lead state must be byte-identical.
    for k in before:
        if k == "leads":
            continue
        assert after.get(k) == before[k], f"top-level key {k} changed"
    print("verify: 46/46 leads enriched, all other state identical")
    print("verify: callLogs", len(after.get("callLogs", [])),
          "meetings", len(after.get("meetings", [])),
          "sessionStats", after.get("sessionStats", {}))
    print("MERGE OK")


if __name__ == "__main__":
    main()
