FastPath Office Runbook (v1.0)
==============================

1) Install FastPath home (once per machine)
------------------------------------------
Git repo name: kiro-fastpath
Default FASTPATH_HOME: ~/kiro-fastpath

From git:
  git clone <kiro-fastpath-url> ~/kiro-fastpath
  bash ~/kiro-fastpath/scripts/install-home.sh ~/kiro-fastpath

If already cloned elsewhere (e.g. Documents):
  bash ~/Documents/kiro-fastpath/scripts/install-home.sh ~/Documents/kiro-fastpath
  # copies/syncs into ~/kiro-fastpath by default

install-home ARG = kiro-fastpath only — NEVER your application repo.
Non-FastPath FASTPATH_HOME refuse wipe unless: --force


2) Wire a project workspace (your app)
--------------------------------------
  export FASTPATH_HOME=~/kiro-fastpath
  bash "$FASTPATH_HOME/scripts/install-target.sh" /path/to/your-repo
  # or:
  node "$FASTPATH_HOME/packages/cli/dist/index.js" use /path/to/your-repo

This creates .fastpath/index.db + .kiro agents/hooks/mcp for that repo.


3) Kiro UI (required)
---------------------
  1. Reload window
  2. Trust workspace if prompted (required for .kiro/agents)
  3. Chat agent picker → Workspace → Scout (daily) or Architect (bigger)
  4. Hook UI → enable "fastpath-auto-context"
  5. Effort: Scout → /effort low · Architect → /effort medium

If Scout is missing: doctor must say "Agent pack IDE-compatible".
Re-run: fastpath repair-kiro /path/to/repo


4) Agents
---------
  Scout.md     — claude-sonnet-4.6, /effort low — daily locate→edit (max ~3 files)
  Architect.md — claude-sonnet-4.6, /effort medium — multi-file (+ shell/subagent)
  Effort is session-level in Kiro; set /effort when switching agents.
  Scout.json is NOT installed (IDE uses .md only).


5) Freshness
------------
  Every prompt  — prompt-inject delta (≤20 dirty files, 2s budget)
  Long sessions — fastpath watch   (path-level delta)
  After git pull — fastpath index --git
  Full rebuild   — fastpath index --rebuild
  After upgrade  — fastpath upgrade && fastpath rewire --all


6) Debug
--------
  fastpath doctor /path/to/repo
  fastpath doctor /path/to/repo --json
  fastpath viz /path/to/repo       # open local HTML dashboard of the index
  fastpath home
  fastpath metrics --summary
  fastpath repair-native          # after Node upgrade
  fastpath unwire /path/to/repo   # remove FastPath wiring

Stale absolute paths in hooks → fastpath rewire /path/to/repo
Hook not injecting → confirm UserPromptSubmit hook enabled in Hook UI.
Corrupt DB → fastpath index --rebuild


7) Verify (realistic prompt — do NOT say "use FastPath")
--------------------------------------------------------
  Where is RunEngine defined, and who calls performVaultLogin?
  Open at most 3 files, then stop. Don’t edit yet.

Pass: paths under packages/…, hook ran, no repo walk.


8) Security / support
---------------------
  scripts/SECURITY_NOTES.txt — npm audit highs (transformers/onnx/sharp)
  scripts/SUPPORT_MATRIX.txt — OS/Node/Kiro limits
  scripts/RELEASE_GATE.txt   — 1.0 cold-install checklist
