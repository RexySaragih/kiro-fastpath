FastPath security notes
=======================

npm audit (as of 1.0.0 packaging): re-check with `npm audit` each release; CI gates critical only

Chain:
  @huggingface/transformers
    → onnxruntime-node → adm-zip (<0.6 memory allocation advisory)
    → sharp / libvips advisories

Our use:
  - Models load from Hugging Face cache (~/.fastpath/models) for local embed/rerank
  - We do not accept untrusted ZIP uploads into adm-zip ourselves
  - Index DB and hooks are local-only; no network telemetry

Policy:
  - CI/QC: npm audit --audit-level=critical must pass
  - High severities accepted until upstream transformers clears them
  - Do NOT swap embedding stack to bypass audit without a MiniLM regression pass

Re-check:
  cd "$FASTPATH_HOME" && npm audit

Mitigations tried:
  - package.json overrides.adm-zip ^0.6.2 (may not hoist into onnxruntime-node tree)
  - sharp <0.35 has no fix available from npm audit (upstream)

Accept remaining highs until @huggingface/transformers clears onnx/sharp advisories.
Critical audit gate: npm run audit:critical
