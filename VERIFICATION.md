# Verification — 2026-11-08

Target SDK: installed @deepseek-ai/dsh 0.2.2-rc.1 and matching SDK packages. Node 24.22.1.

## Final local verification

- `npm run check`: PASS — 58 Node core/adapter/security/lifecycle/persistence tests + 20 React/jsdom UI tests; host/client build passed.
- `git diff --check`: PASS.
- `npm pack --ignore-scripts --cache .npm-cache`: PASS; distributable contains 9 intended package files, about 51 KB compressed.
- Import built host entry without activation: PASS; identity/apply/inject exports verified.
- Adapter implementer separately exercised actual installed SDK BlockAssembler/message constructors and actual filesystem/search Config/apply/native-executor provisioning with controlled boundaries. No model or filesystem tool execution occurred.
- Independent core review: no outstanding Critical/Important findings after deletion/admission/unload races and restore resource/whitelist fixes.
- Independent adapter review checked installed SDK signatures. Requested fixes include terminal turn authority, respecting transient retry attempts, and rejecting additional writable roots; new regressions passed before packaging.

## Not verified

The development GUI required an authenticated browser context. No authentication was requested or bypassed. No plugin was installed into the desktop profile and no replacement server was launched.

Consequently this is NOT a claim of live GUI installation, real model success, actual read-only/write enforcement during a model-run, screenshot/visual QA, or end-to-end acceptance. Those remain post-install checks in a non-sensitive workspace.

## Suggested acceptance checks

1. Open Side Chat without sending: no model request.
2. Discuss a selected passage: no Agent or tool execution; configured independent model is used.
3. Read-only Agent: only read/glob/grep available; writing is denied.
4. Workspace-write: requires confirmation; additional writable roots fail closed; bash/MCP never exposed.
5. Change main session while side request is active: no cross-session reads, draft insertion, or stop routing.
6. Close an active native tab: run stops; reopen saved record: text history resumes; plugin refresh never silently reruns.
7. Main input draft with text/references: conclusion appends, never submits or overwrites; busy state refuses safely.
8. Provider failure/timeout: visible error, retained partial text and history.
9. Delete during/after generation: no resurrected record or Agent resource leak.

## Reproduce local verification

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run check
npm pack --ignore-scripts
```

The tests use controlled service boundaries; a passing local suite does not replace the post-install acceptance checks above.
