#!/usr/bin/env python3
"""Regenerate worker/standalone.js from the app files.

Structure of standalone.js:
  router.js up to (but excluding) its `export default {` block  (the API code)
  + the fetch handler taken from the current standalone.js, with its
    embedded FILES replaced by the current index.html / app.js / style.css.

The deployed worker is the standalone version (serves the app + API from
Cloudflare KV). router.js is the proxy version for a future Vercel deploy.

Usage:  python3 build.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent
WORKER = ROOT / "worker"

router = (WORKER / "router.js").read_text()
marker = "export default {"
head = router.split(marker, 1)[0].rstrip() + "\n"

old = (WORKER / "standalone.js").read_text()
fetch_start = old.index(marker)
handler_lines = old[fetch_start:].splitlines(keepends=True)

files = {
    "index.html": (ROOT / "index.html").read_text(),
    "app.js": (ROOT / "app.js").read_text(),
    "style.css": (ROOT / "style.css").read_text(),
    # Public Packages page (2026-11-23, v28): served at /salesteam/packages
    # with no session — it is a prospect-facing page, not part of the app.
    "packages.html": (ROOT / "packages.html").read_text(),
}
files_line = "const FILES = " + json.dumps(files, ensure_ascii=False) + ";"

for i, line in enumerate(handler_lines):
    if line.lstrip().startswith("const FILES = "):
        handler_lines[i] = files_line + "\n"
        break
else:
    raise SystemExit("FILES line not found in existing standalone.js")

(WORKER / "standalone.js").write_text(head + "\n" + "".join(handler_lines))
print(f"worker/standalone.js regenerated ({len(head) + sum(len(l) for l in handler_lines)} bytes)")
