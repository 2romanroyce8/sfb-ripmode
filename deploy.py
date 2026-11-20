#!/usr/bin/env python3
"""Re-upload sfb-ripmode-router WITH its KV binding.

cf.py worker-put uploads metadata with only main_module, which drops the
worker's existing bindings (confirmed: settings showed bindings: [] after
a metadata-only upload, and every API call touching KV threw 1101).
This upload restores the RIPMODE_KV binding to namespace ripmode-data.
"""
import json
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

with open(PATH, "rb") as f:
    script_bytes = f.read()

metadata = json.dumps({
    "main_module": "worker.js",
    "compatibility_date": "2024-01-01",
    "bindings": [
        {"type": "kv_namespace", "name": "RIPMODE_KV", "namespace_id": KV_NS},
    ],
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
    f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT}/workers/scripts/{SCRIPT}",
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
