# 更新记录

`dsh-context-governor` 的全部可见变化记在这里；英文版 [`CHANGELOG.md`](CHANGELOG.md) 与此文件一同维护。

## 0.1.0 — 2026-10-25

首个版本。

- **上下文上限自动校正。** 按当前会话路由到的 provider 端点问一遍「这个模型最大能开多少上下文」：
  `GET /health`（`max_context`，Strata）、`GET {baseURL}/models`（`meta.n_ctx`、`contextWindow`、
  `context_length`、`max_input_tokens`、`limit.context`）、llama.cpp 的 `GET /props`
  （`default_generation_settings.n_ctx`）、vLLM 的 `GET /server_info`（`max_model_len`）、TGI 的
  `GET /info`（`max_total_tokens`）、Ollama 的 `POST /api/show`（`context_length`、
  `model_info["general.context_length"]`、`parameters` 文本）。候选里**连续两次传输层失败**（超时 / 拒连）
  就提前收工并报 `unreachable`，一台没开的机器不会拖成六次超时。上报值与生效上限不一致时，经
  `ctx.configEditor` 把它写进 profile patch 里 `@deepseek-ai/dsh-llm-pi-ai` 那一行；`providers` 是
  volatile 配置，下一个请求就按新 W 走，不必重启宿主。服务端回显别的模型、数值不可信、目标被钉死、
  这一小时写入次数用尽，这四种情况一律不写。
- **自动压缩阈值托管。** 把 `thresholdRatio`（默认 0.8，可自定义）写进
  `@deepseek-ai/dsh-compaction-basic`，于是「到窗口 0.8 自动压缩」由本插件设定；`headroomTokens` /
  `retainRatio` / `retainTokens` 不设就不动宿主默认。阈值写不进后端配置时，退成本插件自己在
  `agent/pre-step` 上按同一口径触发压缩。
- **本地范围口径。** 默认只问真·本地端点：回环 + RFC1918 / CGNAT / 链路本地 / `.local`；可改成只回环
  或所有 provider。
- **「设置 → 上下文」分区**（中英双语、用宿主主题 token）：阈值比例、三个开关、探测范围与间隔、
  每条路由「上报值 / 生效上限 / 待应用」的状态表、改写审计，以及立即探测 / 立即应用 / 恢复默认 /
  清空记录四个动作。
- 探测与改写状态落在 `~/.dsh/storages/context-governor/`；生效优先级：设置页（settings.json）>
  `cordis.patch.yml` 的 config > 插件内置默认值。
- 离线自检 `scripts/selftest.mjs`：13 个编号组，不联网、不碰真实的 `~/.dsh`。
