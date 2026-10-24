# dsh-context-governor

English | [中文](README_zh.md)

A DSH plugin (host half + a bilingual **Settings → Context** section, zero external dependencies): **it reads the maximum context your local model endpoint reports, corrects the current session model's context ceiling with it, and keeps automatic compaction firing at the ratio you choose (default: once the session reaches 0.8 of the window).**

> Updates: [CHANGELOG.md](CHANGELOG.md) / [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md) (kept together).

## The problem

In DSH the size of a model's context (`contextWindow`) is declared by the `@deepseek-ai/dsh-llm-pi-ai` route configuration, and `@deepseek-ai/dsh-compaction-basic` derives its automatic trigger from that number:

```
threshold tokens = floor( min( W × thresholdRatio,  W − O − headroomTokens ) )
```

`W` = the model's effective `contextWindow`, `O` = the tokens the request reserves for output, `headroomTokens` defaults to 65536. With local models two mistakes are common:

- **no `contextWindow` in the profile** → the route falls back to `defaultContextWindow` (host default **262144**). The server happily allows 512K, yet the session starts summarizing around 200K and throws away context for nothing.
- **a declared number larger than the server really allows** → requests hit the wall (`CONTEXT_WINDOW_EXCEEDED`) and only recover afterwards.

The server actually **knows** its own limit: Strata answers `max_context` on `GET /health`, llama.cpp reports `default_generation_settings.n_ctx` on `GET /props`, vLLM reports `max_model_len` on `/server_info`, Ollama reports `context_length` on `POST /api/show`. This plugin asks for exactly that number, verifies which model it belongs to, writes it into the profile patch, and takes custody of the compaction threshold while it is at it.

## What it does

### 1. Corrects the context ceiling (writes the profile patch; effective immediately)

On `agent/pre-step` (before every step) it works out which `provider/model` this step is about to use, then questions the candidate endpoints of that provider's `baseURL` in order; the first plausible report whose model identity does not conflict wins:

| # | Endpoint | Method | Fields read |
| --- | --- | --- | --- |
| 1 | `{origin}/health` | GET | `max_context` (Strata; **no key required**) |
| 2 | `{baseURL}/models`, `{origin}/v1/models` | GET | selects the entry whose id is this model, then `meta.n_ctx` / `contextWindow` / `context_window` / `context_length` / `max_input_tokens` / `max_model_len` / `max_total_tokens` / `limit.context` |
| 3 | `{origin}/props` | GET | `default_generation_settings.n_ctx` → `general.n_ctx` → `n_ctx` (llama.cpp llama-server) |
| 4 | `{origin}/server_info` | GET | `max_model_len` (vLLM) |
| 5 | `{origin}/info` | GET | `max_total_tokens` (TGI) |
| 6 | `{origin}/api/show` | POST `{"name": <model>, "verbose": true}` | `context_length` → `model_info["general.context_length"]` → `num_ctx` inside the `parameters` text (Ollama) |

The key is taken from `probeApiKey`, else the route's own `apiKeyEnv` resolved through the host credential seam (`ctx.credentials`), else the same-named launch environment / environment variable; if nothing resolves, the request is retried unauthenticated (many local servers never required a key on `/health`).

**Give up early**: two consecutive transport-level failures (timeout / refused, not a 404 or 401 that proves the server is alive and just does not know the path) end the sweep instead of waiting out every candidate — a machine that is switched off does not turn one probe into six timeouts, and the status says "endpoint unreachable".

Then:

1. read the **effective** ceiling with `ctx.llm.resolveModelInfo()` (no network call);
2. if it differs, write the reported value into `providers.<provider>.models[].contextWindow` on the `llm-pi-ai` row of the profile patch via `ctx.configEditor.edit()` — when the `models` list has no such entry one `{id, name, contextWindow}` is appended; when the route declares no `models` list at all it falls back to `modelOverrides.<model>.contextWindow`;
3. `providers` is **volatile** configuration, so the change is live as soon as it is persisted — **the next request runs against the new W, no DSH restart**.

Four gates keep it from guessing:

- **identity check** — if the endpoint names a different model, that is `identity_mismatch` and nothing is written (`/v1/models` selects by id, which is a check in itself);
- **plausibility range** — only integers within 1024 … 8388608 by default (numeric strings accepted, anything else ignored);
- **pin list** — targets in `pins` are never overwritten;
- **write budget** — at most 10 patch writes per hour and at least 2 s apart, so a server that keeps swapping models or `n_ctx` cannot churn the patch.

### 2. Custody of the automatic compaction threshold

The plugin's `thresholdRatio` (**default 0.8, changeable in the section**) is written into the `compaction-basic` row of the profile patch, so "compact at which fraction of the window" is decided here while the host keeps its own formula and retention strategy. `headroomTokens` / `retainRatio` / `retainTokens` can also be overridden; **unset leaves the host defaults (65536 / 0.16) alone**.

- If the ratio was never changed, **nothing is written at all** (the host default already is 0.8).
- The pair is validated before writing: `retainRatio ≥ thresholdRatio` is a combination the host would reject at load time, so it is refused here with a stated reason instead of writing a broken config.
- **Two writers, chosen automatically**: `configEditor` first, and a top-level patch write when that row is out of its reach. The reason a second path exists — in the desktop/Web profile the `standard` preset seals the compaction trio inside `- id: compaction` (`cordis:group` + `isolate: compaction`), and a group member has **no live fiber**, so `configEditor` refuses it outright (`Configuration entry is no longer available`) while `isolate` also hides `ctx.compaction`. But the loader's id index *recurses into group configs*, and the host watches `cordis.patch.yml` itself — so appending a **top-level** `- id: compaction-basic / config: {…}` to that file is honoured and the row is recomposed hot (measured here: within 6 seconds of writing, that row's composed config went from absent to `retainRatio: 0.2`). The section's "which writer did the backend config land through" line reports exactly this.
- That fallback path stays line-level: it never parses the whole YAML, never touches other people's lines, skips the write when the rendered block is identical (idempotent), refuses outright if the block contains a `!!js` expression, **deletes only keys it wrote itself** (`retainRatio` / `retainTokens` may not coexist — that either-or deletion asks no questions), preserves CRLF, and recognizes its own block through a comment stamped `dsh-context-governor` (rewritten together with the block, so it never accumulates). A top-level override **replaces** that row's whole config, so the plugin first merges the row's current composed config underneath it.
- When the threshold cannot be pushed to the backend (`writeCompactionConfig: false`, or neither writer reaches that row), `ownPressureTrigger: "auto"` makes the plugin run its own `agent/pre-step` pressure check with the same formula via `ctx.compaction.compactIfNeeded()`; `always` watches alongside the backend, `never` leaves it entirely to the backend. With the backend isolated inside a group the plugin cannot see `ctx.compaction` either, and `auto` correctly stays off.
- If the composition has **no compaction backend at all**, nothing can compact automatically (`compactIfNeeded` has no implementation) — the section says so plainly instead of going silent.

## Settings → Context

The section (client half `lib/client.js`, slot `settings.section`, `order: 64`, same layer as "Window size") offers:

| Control | Effect |
| --- | --- |
| Enable this plugin / Fix the ceiling automatically / Push the threshold into the compaction backend | three switches; each click persists and takes effect |
| Ratio + Save | `thresholdRatio` (0.05–0.99); the host formula and the current headroom are printed beside it, together with a line saying **which writer the backend config actually landed through** (`configEditor` or a top-level write into the profile patch) and how the O in the preview is counted |
| Probe scope / Who triggers compaction | selects: loopback only, loopback + LAN (default), every provider; auto (default) / always / never |
| Interval / timeout / written-ceiling factor / headroomTokens / retainRatio | number inputs, committed by "Save advanced settings"; under the written-ceiling factor there is an explanation of how much earlier each step compaction comes — the plugin always uses the number you typed and never overwrites it |
| Language of this section | `auto` (follows DSH "Settings → General → Language", **switching applies instantly**) / pinned `zh` or `en` |
| Status table (one row per route) | effective W, the reported ceiling with its source endpoint, effective threshold tokens, status (in sync / **pending** / fixed / model mismatch / no answer / out of probe scope / pinned), plus per-row Probe and Apply buttons |
| Probe all now / Apply all pending / Reset to defaults / Clear probe records / Refresh | four actions plus refresh |
| Recent writes and probes | audit list (which route changed from what to what, through which endpoint, and the pressure/threshold pair when the plugin compacted itself) |
| State and files | paths of the state file, the settings file and the profile patch |

**When it takes effect (measured here — the two things are not equally fast)**: choices land in `settings.json` and apply **immediately** for everything this plugin itself decides (probing, pending detection, the preview threshold) — the next `agent/pre-step` already uses them, and they survive the next start; no DSH restart, no reinstall. That "immediately", though, stops there: a changed `contextWindow` is read fresh by the host on every request, so the next request uses the new W (verified here). For the compaction backend, a `thresholdRatio` / `retainRatio` written into the patch updates the *entry* within seconds, yet **the compaction instance already serving this session kept the config it was constructed with** — here the ratio was temporarily set to 0.45 (threshold 217,054) while session pressure sat at 245k above it for four consecutive steps and nothing compacted. A rebuilt instance (host restart) is expected to use the new values, but that last step was not measured without restarting. So "when does a custom threshold really take effect" should be answered **next restart**; do not plan around it flipping the instant you click.

## What counts as a "local model"

Default scope is **loopback + private LAN** (`probeScope: "loopback-private"`):

- loopback: `127.0.0.0/8`, `localhost`, `*.localhost`, `::1`, `::ffff:127.x`, `0.0.0.0/8`;
- private: `10/8`, `172.16–31/12`, `192.168/16`, `169.254/16`, CGNAT `100.64–127/10`, IPv6 `fe80::/10` and `fc00::/7`, `*.local` / `*.internal`;
- everything else is **not asked at all** by default.

`"loopback"` accepts only the first group; `"any"` asks every provider (cloud endpoints then take an extra request, and gateways that already report capacity get adopted too).

## State and settings files

Directory: `~/.dsh/storages/context-governor/`

| File | Written by | Contents |
| --- | --- | --- |
| `state.json` | plugin | `{ "version": 1, "applied": {"<provider>\|<model>": {at, before, after, reported, kind, endpoint, forced}}, "probes": {…}, "audit": […], "writes": [ts…] }` |
| `settings.json` | the section | the whitelisted keys currently chosen plus `updatedAt`, e.g. `{ "version": 1, "thresholdRatio": 0.85, "autoFixContextWindow": true }` |

Both are **atomic writes** (temporary file + rename), so a concurrent reader never sees half a file, and rewriting `settings.json` **keeps unknown keys** somebody else put there. Deleting `settings.json` returns the section to patch config / built-in defaults; deleting `state.json` starts the records over.

## Configuration (cordis.patch.yml)

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch (with it off the section's routes are still registered and state is still visible) |
| `autoFixContextWindow` | `true` | write the patch as soon as values differ; `false` only marks it pending |
| `thresholdRatio` | `0.8` | compaction ratio (0.05–0.99) pushed into compaction-basic |
| `writeCompactionConfig` | `true` | whether the threshold is written into the backend's patch config |
| `ownPressureTrigger` | `"auto"` | `auto` = only when the threshold cannot be written; `always`; `never` |
| `probeScope` | `"loopback-private"` | `loopback` / `loopback-private` / `any` |
| `probeIntervalMs` | `30000` | minimum gap between probes of the same provider+model |
| `probeTimeoutMs` | `2500` | per-probe HTTP timeout |
| `probeApiKey` | `""` | key used for probing; empty resolves the route's `apiKeyEnv` through the credential seam. **Do not put a literal key here** |
| `contextSafetyRatio` | `1` | written value = reported × this ratio (0.5–1) |
| `minReportedContextWindow` / `maxReportedContextWindow` | `1024` / `8388608` | plausibility range (values outside are noise; the ceiling never sits below the host fallback 262144) |
| `maxWritesPerHour` / `minWriteIntervalMs` | `10` / `2000` | patch write throttle |
| `headroomTokens` / `retainRatio` / `retainTokens` | `null` | `null` leaves the host default alone; `retainRatio` and `retainTokens` are mutually exclusive (`retainTokens` wins) |
| `pins` | `[]` | `[{provider, model, contextWindow}]` targets the plugin must not overwrite |
| `stateFile` | empty | custom state file path (settings file lives next to it as `settings.json`) |
| `language` | `"auto"` | section language: `auto` follows DSH, `zh` / `en` pin it |

> Precedence: **the section (`settings.json`) > this file's config > built-in defaults**. The section only accepts whitelisted keys (`stateFile` and `pins` can only be set in the patch).
> A patch `config` is Cordis configuration: editing it needs a DSH restart or a profile recomposition; the section's choices go through `settings.json` and need **no** restart.

## How it relates to host mechanisms

- Configuration prefers `@deepseek-ai/dsh-config-editor`'s `edit(entry, change)`: it holds a cross-process file lock, validates against the target plugin's own schema, persists `cordis.patch.yml` and reconciles just that row. **Side effect**: the edited row's (`llm-pi-ai` / `compaction-basic`) `config` node is re-serialized as a whole, so comments *inside* the config may be dropped; comments above the row survive. Put long explanations above the row.
- Inside a `cordis:group` with `isolate`, member rows show up in `configEditor`'s `entries()` but cannot be edited, because they have no live fiber — the host's own settings page cannot edit them either; the top-level override described above is this plugin's answer. Three measured facts, recorded so nobody has to guess again: `applyEntryPatches`'s `buildMap` recurses into a `group`'s `config`; when an id appears twice the **later** entry wins the map slot (on this machine the patch landed on the row inside the group); and `Include` watches its own patch file, so an edit triggers `root.update(applyPatches(...))` — a hot recomposition.
- The effective ceiling comes from `ctx.llm.resolveModelInfo()` (no network), pressure from `ctx.tokenMeter.measure()` (only read when self-triggering), compaction through `ctx.compaction.compactIfNeeded()`, keys via `ctx.credentials`. All of them are taken with `ctx.get(...)` plus `typeof` checks: a missing service costs one capability, it never throws the plugin.
- The threshold shown in the section is a **preview**: the host also subtracts O (what each request reserves for output), taken from the session's request envelope; when `resolveModelInfo` reports no `defaultMaxTokens` the preview counts O as 0, so the shown number can sit slightly above the real trigger (the real trigger is only ever earlier, never later).
- The plugin adds nothing model-visible to the conversation, changes no system prompt, registers no tool and introduces no new session event type — only the profile patch and its own two JSON files are written.

## Install / reload

Repository: <https://github.com/ecbob/dsh-context-governor> (public, `main` plus version tags). `<version>` below is whatever `package.json` says.

```bash
# regular install: ship the packed artifact
copy dist\dsh-context-governor-<version>.tgz %USERPROFILE%\.dsh\.plugin-sources\
dsh plugin --profile desktop add "%USERPROFILE%\.dsh\.plugin-sources\dsh-context-governor-<version>.tgz"

# from source: clone and pack it yourself (the repo carries no build artifact; the tgz is made by npm run pack)
git clone https://github.com/ecbob/dsh-context-governor.git
cd dsh-context-governor && npm test && npm run pack   # lands in dist\

# development: hot composition (no restart)
dev_install_package  dir=<absolute path of this checkout>  profile=desktop
dev_reload_package   dsh-context-governor   # host half only; refresh the page for the section
```

Uninstall: `dsh plugin --profile desktop remove dsh-context-governor`, or `dev_uninject_plugin dsh-context-governor`.

Which `<profile>`: whatever `dir %USERPROFILE%\.dsh\profiles` shows (desktop builds usually say `desktop`). **A newly installed plugin row needs a DSH host restart to load**; later host-side code changes can be hot-reloaded with `dev_reload_package`, and `lib/client.js` changes additionally need a page refresh.

## Offline self-test

```bash
node scripts/selftest.mjs        # or npm test, which first runs node --check on all three files
```

14 numbered groups, no network, everything under the system temp directory — it **never touches** the real `~/.dsh/storages/context-governor`: configuration normalization and precedence, "is this local" (including IPv6 spellings and CGNAT), candidate endpoint construction, report parsing (Strata `/health` and `/v1/models`, llama.cpp `/props`, vLLM `/server_info`, TGI `/info`, Ollama dotted keys and `parameters` text, plus identity mismatch, implausible values, missing field, malformed JSON), providers patch generation (update entry / append entry / `modelOverrides` fallback / no-op / arguments never mutated in place), compaction patch and the threshold formula (including the pure-ratio fallback when the budget collapses), state and settings files (atomic write, unknown keys kept, corrupt-file tolerance), `probeTarget` end to end (fake fetch: `/health` 401 falling back to `/v1/models`, key attached, timeout, give-up after two transport failures, mismatch, out of scope, safety factor), the section's HTTP routes (fake ctx + real http server + real fetch: `/state` `/settings` `/probe` `/apply` `/reset` `/clear`, unknown route, bad JSON, `retain` conflict), lifecycle (`agent/pre-step` throttling, `next()` always returned, the three ownership modes, no spinning after unload, retry registration when `webServer` arrives late), real rendering of both languages through a fake React (dictionary key and placeholder parity, no Chinese left in the English UI, internal keys never shown as copy, switches and buttons really POST), sensitive-data scan, manifest consistency (exports/files vs. the real tree, version matching the host module), and the top-level profile-patch writer (append / idempotency / in-place rewrite including its own comment / `!!js` refusal / CRLF preserved / indented same-id rows not treated as the target / merge semantics / YAML value rendering, plus the complete fallback write after a fake `configEditor` refuses — which also pins down that re-entering the write queue must not await itself).

## The zero-dependency rule

Node built-ins only (`fs`/`os`/`path`) on the host side, no declared runtime dependency, no binaries in the package; the client half uses only the `react` the client module loader injects. Declared dependencies must resolve at install time when the packed artifact is installed, and `link:` installs never resolve the linked package's own dependencies — one failing resolution throws the whole Cordis plugin tree and DSH will not start.

## Known limitations

- **A reported value is the server's accounting, not DSH's**: servers report the total window while DSH still subtracts the request's output reservation and the compaction headroom. This plugin only gets `W` right; it does not redefine `O` or `B`.
- **Endpoints that do not echo a model name can only be accepted unverified** — the status says "endpoint did not echo the model". If such a server swaps models on the same port, the plugin catches up on the next probe after the TTL.
- **Only `contextWindow` is changed, never `maxTokens`**: the output reservation comes from the request envelope or the route default and is left alone.
- **`modelOverrides` only works on catalog-backed routes**: a manually declared route with no `models` list would be rejected by the host, so the plugin reports a failed write instead of forcing one.
- **Concurrent patch writes from another host process** are serialized by configEditor's file lock; this plugin additionally keeps its own writes in one queue. **The fallback writer is not covered by that lock** (it edits `cordis.patch.yml`, not `package.json`): it re-reads the whole file and rewrites only its own block, so the window is small, but a host edit landing at the same instant is theoretically "last writer wins". If you would rather not carry that risk, turn `writeCompactionConfig` off and keep the row yourself.
- **A row you hand-maintained in the patch may be rewritten by this plugin**: the fallback recognizes the top-level `- id: compaction-basic` block and, when the content differs, replaces the whole block with what it computed (foreign keys are merged in as the base, but formatting and comments are not preserved). To keep that row entirely yours, switch off "write the threshold into the compaction backend".
- **The backend applies its config slower than the write lands**: the patch update reaches the entry within seconds, but the compaction instance already serving this session keeps the config it was constructed with — measured here by dropping `thresholdRatio` to 0.45 (threshold 217,054) while session pressure sat at 245k above it for four consecutive steps with no compaction. Only a rebuilt instance (host restart) counts. The ceiling is not affected: `providers` is read per request, and the next request used the new W in the same measurement.
- **Compaction itself still belongs to the backend** (the plugin only steps in when the threshold cannot be written): summary quality and `/compact` behavior remain `dsh-compaction-basic`'s business.

## License

MIT, see LICENSE.
