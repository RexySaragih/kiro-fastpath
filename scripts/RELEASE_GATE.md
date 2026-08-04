FastPath 1.0 release gate
=========================

Complete before tagging / announcing 1.0 on a new machine set.

[ ] 1. Cold machine A
    git clone <kiro-fastpath-url> ~/kiro-fastpath
    bash ~/kiro-fastpath/scripts/install-home.sh ~/kiro-fastpath
    bash ~/kiro-fastpath/scripts/install-target.sh /path/to/app
    node ~/kiro-fastpath/packages/cli/dist/index.js warm
    FASTPATH_EMBED=minilm node .../index.js index /path/to/app
    node .../index.js doctor /path/to/app
    Expect: exit 0, SCOUT READY, embedBackend=minilm, search smoke OK

[ ] 2. Kiro UI (machine A)
    Reload → trust workspace → Scout → enable fastpath-auto-context
    /effort low
    Prompt (do NOT say FastPath): locate a known symbol; ≤3 file reads; no repo walk
    Pass: hook injected context and/or MCP tools used

[ ] 3. Cold machine B (or second home path)
    Same install OR: fastpath upgrade && fastpath rewire --all
    doctor exit 0 without hand-editing .kiro paths

[ ] 4. CI
    push: Node 20+22 build-test green
    minilm-smoke green
    audit:critical green

[ ] 5. Docs match reality
    OFFICE_RUNBOOK.txt, SUPPORT_MATRIX.txt, INSTALL_PROMPT.txt
    Effort manual; hook UI; workspace trust called out

[ ] 6. Tag
    git tag -a v1.0.0 -m "FastPath 1.0.0 battle-ready"
    (push tag only when office owners confirm steps 1–3)

Rollback
--------
  fastpath unwire /path/to/app
  Or reinstall previous tag into FASTPATH_HOME with install-home.sh --force
