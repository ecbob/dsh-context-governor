# Changelog

All notable changes to `dsh-context-governor` are documented here. The Chinese twin is
[`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md); both are maintained together.

## 0.1.1 — 2026-10-25

### Added

- **Fallback writer for the compaction config.** In the desktop/Web profile the `standard` preset seals
  `compaction-basic` inside a `cordis:group` with `isolate: compaction`: that nested row has no live
  fiber, so `configEditor` refuses it outright (`Configuration entry is no longer available`) and
  `ctx.compaction` cannot see it either. The plugin then appends or rewrites a **top-level**
  `- id: compaction-basic` override in the profile's `cordis.patch.yml` (the loader's id index recurses
  into group configs, and the host watches this file — measured: the row's composed config changed within
  6 seconds, no restart). This channel only does line-level text editing: it never parses the whole YAML,
  never touches anyone else's lines, skips the write when the content is identical (idempotent), refuses
  outright if that block contains a `!!js` expression, deletes only keys it wrote itself
  (`retainRatio` / `retainTokens` may not coexist — that deletion asks no questions), preserves CRLF, and
  finds its own block again through a comment stamped with `dsh-context-governor`.
- Richer state and settings page: `compaction.via` / `writtenKeys` / `lastSyncAt` / `lastSyncCode` /
  `patchWritable` / `onHostRetainTokens`; the section now states which channel the backend config landed
  through, spells out the O caveat in the threshold preview, and explains the write-safety factor (the
  number stays exactly what you typed — the plugin never overwrites it).

### Fixed

- **A startup write could freeze the serialized write queue.** A task inside the `enqueue` chain that
  itself calls `enqueue` (syncing the threshold wraps `editRow`) awaited the very chain link containing
  itself, so the startup sync — and every later patch write — queued forever. Re-entrant calls now run
  inline (they are already inside the serialized section); group `[14]` covers it end to end.
- The block boundary of a top-level row no longer swallows trailing blank lines, which used to turn an
  identical block into a spurious "needs rewriting".

### Tests

- New offline group `[14]`: append / idempotency / in-place rewrite / `!!js` refusal / CRLF preservation /
  indented rows with the same id are not treated as the target / merge semantics (delete only our own keys,
  the mutual-exclusion deletion excepted, `retain ≥ threshold` blocked up front) / YAML value rendering,
  plus the full fallback write after a fake `configEditor` refuses. Now **14 groups / 232 checks**.

## 0.1.0 — 2026-10-25

First release.

- **Context ceiling auto-correction.** Probes the endpoint of the routed provider model and takes the
  maximum context it reports: `GET /health` (`max_context`, Strata), `GET {baseURL}/models`
  (`meta.n_ctx`, `contextWindow`, `context_length`, `max_input_tokens`, `limit.context`),
  llama.cpp `GET /props` (`default_generation_settings.n_ctx`), vLLM `GET /server_info`
  (`max_model_len`), TGI `GET /info` (`max_total_tokens`), Ollama `POST /api/show`
  (`context_length`, `model_info["general.context_length"]`, `parameters` text). Two consecutive
  transport failures (timeout / refused) end the candidate sweep early and report `unreachable`, so a
  server that is simply off does not cost six timeouts. When the reported value
  differs from the effective `contextWindow`, writes it into the profile patch row of
  `@deepseek-ai/dsh-llm-pi-ai` through `ctx.configEditor` — `providers` is volatile, so the next request
  uses the new ceiling without restarting the host. Refuses to write when the endpoint names a different
  model, when the value is implausible, when the target is pinned, or when the write budget is spent.
- **Compaction threshold custody.** Pushes `thresholdRatio` (default `0.8`, user-changeable) into
  `@deepseek-ai/dsh-compaction-basic`, so automatic compaction fires at the chosen fraction of the
  window; optional `headroomTokens` / `retainRatio` / `retainTokens` overrides leave the host defaults
  untouched when unset. Falls back to running its own `agent/pre-step` pressure check when the threshold
  cannot be written to the backend.
- **Scope.** Only endpoints that are actually local are probed by default: loopback plus RFC1918 /
  CGNAT / link-local / `.local`; configurable to loopback-only or every provider.
- **Settings → Context section** (bilingual, host theme tokens) with the ratio, the switches, the probe
  scope/interval, a per-route table of reported vs effective ceiling, pending-apply markers, an audit
  list, and Probe / Apply / Reset / Clear actions.
- Probe and rewrite state lives in `~/.dsh/storages/context-governor/`; user choices in `settings.json`
  win over `cordis.patch.yml`, which win over built-in defaults.
- Offline self-test (`scripts/selftest.mjs`): 13 numbered groups, no network, never touches the real
  `~/.dsh`.
