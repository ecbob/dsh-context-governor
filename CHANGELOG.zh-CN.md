# 更新记录

`dsh-context-governor` 的全部可见变化记在这里；英文版 [`CHANGELOG.md`](CHANGELOG.md) 与此文件一同维护。

## 0.1.2 — 2026-10-25

### 变更

- 补包元数据 `repository` / `bugs` / `homepage`：GitHub 公开仓库 `ecbob/dsh-context-governor` 已建好并推上 `main` 与版本标签。插件行为、配置项、默认值都没动。
- 文档口径按今天的实测更正（README 的「生效时机」与「已知限制」两处）：`contextWindow` 下一个请求就换；压缩后端的 `thresholdRatio` / `retainRatio` 写进 patch 后条目层几秒就换新，但**正在跑的会话里那个压缩实例仍用它启动时那份配置**——本机把阈值降到 0.45、压力超出阈值四步都没压，要到重启才算数。

## 0.1.1 — 2026-10-25

### 新增

- **压缩配置的兜底写入通道。** 桌面/Web profile 的 `standard` 预设把 `compaction-basic` 关进
  `cordis:group` + `isolate: compaction`：那种嵌套条目没有活 fiber，`configEditor` 会当场拒
  （`Configuration entry is no longer available`），`ctx.compaction` 也看不见。这时插件改往 profile 的
  `cordis.patch.yml` 追加/改写一条**顶层** `- id: compaction-basic` override（loader 的 id 索引会递归进
  group 的 config，宿主对这份文件的监听会热重组那一行；本机实测 6 秒内条目配置就换了）。这条通道只做
  行级文本改写：不解析整份 YAML、不动别人的行、内容一样就不写盘（幂等）、那一段带 `!!js` 表达式就一律
  不动、删键只删自己写过的（`retainRatio` / `retainTokens` 并存是宿主硬性禁止的，这种删除不问出处）、
  CRLF 文件保持 CRLF，并用一段带 `dsh-context-governor` 字样的注释认回自己写的那一段。
- 状态载荷与设置页说明补全：`compaction.via` / `writtenKeys` / `lastSyncAt` / `lastSyncCode` /
  `patchWritable` / `onHostRetainTokens`；设置页新增「这次后端配置走的是哪条通道」一行、阈值预览里 O 的
  口径说明，以及「写入安全系数」的解释（值仍按你填的算，插件不替你改）。

### 修复

- **启动时正好需要写一次，会把串行写入队列钉死。** `enqueue` 链里的任务自己再 `enqueue`（同步阈值时套
  `editRow`）会去等"包含它自己的那一段链"，两边互相等：启动同步和其后所有 patch 写入永久排队。重入时
  改为就地执行（本来就已经在那段串行里），`[14]` 组端到端盯住这条。
- 顶层条目的段落边界不再把段尾空行算进去（否则"内容完全一样"也会被误判成需要改写）。

### 测试

- 离线自检新增 `[14]` 组：追加 / 幂等 / 就地改写 / 带 `!!js` 不动 / CRLF 保持 / 缩进里的同名条目不当入口 /
  合并语义（只删自己写过的、互斥不问出处、`retain ≥ threshold` 当场挡住）/ YAML 值渲染形状，以及假
  `configEditor` 直拒之后的完整兜底落盘。现 **14 组 / 232 项**。

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
