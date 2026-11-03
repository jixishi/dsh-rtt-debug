# `_recover/` — how this plugin was rebuilt from session logs

On 2026-11-03 the working copy at `W:\dsh-plugins\dsh-rtt-debug` was wiped by an
update. The source existed only in the DSH session logs, so this directory holds
the tools that reconstructed it. They are kept because the recovery is
repeatable: the same logs produce the same tree, and the checks are how the
result was proven rather than assumed.

## Inputs

The logs were decompressed with `zstd -d` from two locations:

- `W:\DeepSeek Harness\HOME\sessions\--W-dsh-plugins-dsh-rtt-debug--\session-*.jsonl.zstd`
  (session format v4 — four sessions)
- `C:\Users\RUNIC\.dsh\sessions\--W-dsh-plugins-dsh-rtt-debug--\*\session.v3.jsonl.zstd`
  (session format v3 — twelve sessions)

Put the resulting `*.jsonl` back in this directory before running anything.

## Evidence, strongest first

| # | Source | What it proves |
|---|---|---|
| 1 | `dshFileReview` diffs on tool results | the exact `oldText`/`newText` written to disk |
| 2 | `read` snapshots (`meta.lines`) | the file's real content at that instant |
| 3 | `write` call arguments | the intended content of a new file |
| 4 | `edit` call arguments | the exact `old_string` → `new_string` substitution |

Two facts about the logs decide whether a replay is faithful:

- **Sessions fork.** The two November logs share 720 identical tool calls. Replaying
  both applies every edit twice, which is why `rebuild.py` keeps one event per
  `callId`.
- **Calls can be rejected.** 34 edits/writes were refused by the tool (stale
  `old_string`, ambiguous match, file changed since read). Those never touched the
  disk, so replaying them invents content. `outcomes.py` detects them in both log
  formats — v3 marks them with `isError`, v4 only says `Error:` in the text.

## Tools

| File | Purpose |
|---|---|
| `rebuild.py` | main replay: snapshots + writes + edits + review diffs, fork- and rejection-aware |
| `rebuild2.py` | independent engine: newest whole-file snapshot as base, later events only |
| `rebuild3.py` | independent engine: largest observed snapshot as base, clean diffs only |
| `structure.py` | lexer-aware bracket balance, duplicate declarations, leaked read-tool artefacts |
| `adjudicate.py` | per-file verdict between engines on structural validity |
| `repair.py` | compiler-guided repair of the three recurring splice injuries |
| `fix_nesting.py` | hoists a method/function that was spliced inside the block above it |
| `outcomes.py` | classifies every write/edit call as applied or rejected |
| `parse_error.cjs` | first true syntax errors via the TypeScript parser |
| `who_owns.cjs` | which AST node contains a given line (locates swallowed code) |
| `dump_ast.cjs` | statement structure of a named function |
| `check_bundle.mjs` | verifies the built `lib/` bundles export the plugin contract |

## Verification that was actually run

```
tsc --noEmit                     → 0 errors
node --test (9 files)            → 194 pass / 0 fail
tsdown                           → lib/index.js + lib/client.js
check_bundle.mjs                 → 6/6 checks pass
```

## Recovering again

```powershell
# 1. decompress the logs into this directory (zstd -d)
# 2. replay
python _recover\rebuild.py
python _recover\rebuild2.py
python _recover\rebuild3.py
python _recover\structure.py
# 3. adjudicate, deploy, then let the compiler arbitrate what is left
python _recover\adjudicate.py
node   _recover\parse_error.cjs src/index.ts
```

## What the replay cannot prove

The reconstruction is faithful where a snapshot or a diff covers the text, and
inferred where neither does. `service.ts` and `panel.tsx` were repaired enough to
compile and pass their tests, but their block ORDER in places is the replay's
reconstruction, not a byte-for-byte copy of the original. Treat those two as the
most likely place for a subtle behavioural difference.
