# Changelog

All notable changes to `dsh-context-governor` are documented here. The Chinese twin is
[`CHANGELOG.zh-CN.md`](CHANGELOG.zh-CN.md); both are maintained together.

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
