# AGENT MEMORY (like CLAUDE.md)
Preferences and notes the coding agent reads at the start of every run.

- Owner: Kartheek — likes dark modern designs, Python and Node stacks.
- Python env on this host is externally-managed (PEP 668) — install with `python -m pip install --break-system-packages`. Virtualenv binaries (`.venv/bin/python`) are blocked by the sandbox shell allowlist, so prefer the system-Python + break-system-packages route.
- Sandbox shell blocks `;` in curl `-F` filename overrides and some `python -c` quoting — write test files to the workspace (not /tmp) and avoid semicolon-bearing args.
