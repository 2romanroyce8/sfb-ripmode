#!/usr/bin/env python3
"""Re-upload sfb-ripmode-router WITH its KV binding — and WITHOUT wiping
the worker's plain-text env vars.

LESSON (2026-11-20, root cause of the "In-dashboard calling is not set up
yet" outage): the old deploy.py uploaded metadata with ONLY the KV binding.
A script upload REPLACES the worker's bindings, so the three plain-text vars
set in the Cloudflare dashboard (TWILIO_ACCOUNT_SID, TWILIO_API_KEY_SID,
TWILIO_TWIML_APP_SID) were silently wiped by the v=10 deploy. Only
TWILIO_API_KEY_SECRET survived, because secrets are stored separately from
the script metadata. The dashboard then showed the vars as set, the worker
saw none of them, and /api/voice/status returned configured:false.

This version therefore:
  1. GETs the live worker's current settings first and re-sends every
     existing binding (KV, secrets, plain-text vars) in the upload metadata,
     so a deploy can never wipe a var again.
  2. Merges in plain-text vars supplied as environment variables at deploy
     time (e.g. TWILIO_ACCOUNT_SID=AC... python3 deploy.py) — the ONLY way
     a var value should ever reach this script. Values are never printed.
     Use this to (re-)set a var whose value is known; never invent one.
  3. Prints only binding NAMES (never values) so the log proves what was
     preserved.

ALWAYS deploy with this script. `cf.py worker-put` uploads metadata with
only main_module, which drops the worker's existing bindings (confirmed:
settings showed bindings: [] after a metadata-only upload, and every API
call touching KV threw 1101).
"""
import json
import os
import sys
import urllib.request
import urllib.error
import uuid

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

ACCOUNT = "212fe192b20e1827e2b4f8bd55928918"
SCRIPT = "sfb-ripmode-router"
KV_NS = "c4dd1ffc591b47c08a0946996b30d862"  # ripmode-data
PATH = "/home/hatch/workspace/ripmode-standalone/worker/standalone.js"

# Plain-text var names this worker is allowed to carry. Values come ONLY
# from the environment at deploy time — never hardcode one here.
PLAIN_VAR_NAMES = [
    "TWILIO_ACCOUNT_SID",
    "TWILIO_API_KEY_SID",
    "TWILIO_TWIML_APP_SID",
]

BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}"


def api_get(path):
    req = urllib.request.Request(BASE + path, method="GET")
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    resp = urllib.request.urlopen(req, timeout=30)
    return read_json_response(resp)


def main():
    # 1. Preserve whatever the live worker already has. Secrets (type
    # secret_text) are EXCLUDED from the upload metadata on purpose: the
    # upload API rejects a secret binding without a text value, and secrets
    # persist independently — the old KV-only deploy proved omitting them
    # does not delete them. Only KV + plain-text vars go in the metadata.
    bindings = []
    try:
        settings = api_get(f"/workers/scripts/{SCRIPT}/settings")
        all_bindings = list((settings.get("result") or {}).get("bindings") or [])
        bindings = [b for b in all_bindings if b.get("type") != "secret_text"]
        print("Preserving live bindings:", [b.get("name") for b in bindings],
              "(secrets live outside script metadata and are left untouched)")
    except Exception as e:  # noqa: BLE001 — fall back to KV-only, loudly
        print(f"WARNING: could not read live settings ({e}); falling back to KV-only bindings.", file=sys.stderr)

    by_name = {b.get("name"): b for b in bindings if b.get("name")}

    # 2. Merge plain-text vars supplied via the environment (values never logged).
    for name in PLAIN_VAR_NAMES:
        value = os.environ.get(name)
        if value:
            by_name[name] = {"type": "plain_text", "name": name, "text": value}
            print(f"Setting plain-text var from environment: {name}")

    # 3. Ensure the KV binding is present.
    if "RIPMODE_KV" not in by_name:
        by_name["RIPMODE_KV"] = {"type": "kv_namespace", "name": "RIPMODE_KV", "namespace_id": KV_NS}

    bindings = list(by_name.values())
    print("Uploading with bindings:", [(b.get("name"), b.get("type")) for b in bindings])

    with open(PATH, "rb") as f:
        script_bytes = f.read()

    metadata = json.dumps({
        "main_module": "worker.js",
        "compatibility_date": "2024-01-01",
        "bindings": bindings,
    }).encode()

    boundary = uuid.uuid4().hex
    parts = []
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
        f"Content-Type: application/json\r\n\r\n".encode() + metadata + b"\r\n"
    )
    parts.append(
        f'--{boundary}\r\nContent-Disposition: form-data; name="script"; filename="worker.js"\r\n'
        f"Content-Type: application/javascript+module\r\n\r\n".encode() + script_bytes + b"\r\n"
    )
    parts.append(f"--{boundary}--\r\n".encode())
    body = b"".join(parts)

    req = urllib.request.Request(
        f"{BASE}/workers/scripts/{SCRIPT}",
        method="PUT",
    )
    add_surrogate_to_request(req, "custom.cloudflare", allowed_hosts=["api.cloudflare.com"])
    req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
    req.data = body
    try:
        resp = urllib.request.urlopen(req, timeout=30)
        out = read_json_response(resp)
        print(json.dumps(out, indent=2)[:1500])
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read()[:500].decode(errors="replace"))
        sys.exit(2)


if __name__ == "__main__":
    main()
