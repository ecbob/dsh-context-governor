# dsh-context-governor —— 上下文管家

[English](README.md) | 中文

DSH 插件（宿主侧 + 「设置 → 上下文」分区，零外部依赖）：**按本地模型服务端上报的最大上下文修正当前会话模型的上下文上限，并把自动压缩的触发点托管成你设定的比例（默认到窗口的 0.8 就压缩）。**

> 更新记录：英文 [CHANGELOG.md](CHANGELOG.md) / 中文 [CHANGELOG.zh-CN.md](CHANGELOG.zh-CN.md)（两份一同维护）。

## 解决的问题

DSH 里「这个模型有多大上下文」（`contextWindow`）由 `@deepseek-ai/dsh-llm-pi-ai` 的路由配置声明，而自动压缩（`@deepseek-ai/dsh-compaction-basic`）的触发点就是按这个数算的：

```
阈值 tokens = floor( min( W × thresholdRatio,  W − O − headroomTokens ) )
```

`W` = 该模型生效的 `contextWindow`，`O` = 请求为输出预留的 token，`headroomTokens` 默认 65536。于是本地模型上常见两种错：

- **profile 里没写 `contextWindow`** → 落到路由的 `defaultContextWindow`（宿主默认 **262144**）。服务端明明能开 512K，会话却在 20 万左右就开始压缩，白丢上下文。
- **profile 里写的数比服务端实际能开的大** → 请求直接撞上下文墙（`CONTEXT_WINDOW_EXCEEDED`），要靠溢出恢复才修得回来。

而服务端其实**自己知道**能开多大：Strata 的 `GET /health` 直接回 `max_context`，llama.cpp 的 `GET /props` 回 `default_generation_settings.n_ctx`，vLLM 的 `/server_info` 回 `max_model_len`，Ollama 的 `POST /api/show` 回 `context_length`。本插件就是把这一个数问出来、核对身份、写回 profile 配置，并把压缩阈值一起托管掉。

## 它干的两件事

### 1. 修正上下文上限（写回 profile patch，热生效）

在 `agent/pre-step`（每一步之前）认出这一步要用哪个 `provider/model`，按该 provider 的 `baseURL` 依次问候选端点，第一个「可信且身份不冲突」的上报值胜出：

| # | 端点 | 方法 | 读的字段 |
| --- | --- | --- | --- |
| 1 | `{origin}/health` | GET | `max_context`（Strata；**不要密钥**） |
| 2 | `{baseURL}/models`、`{origin}/v1/models` | GET | 按 id 选中自己那一条，再读 `meta.n_ctx` / `contextWindow` / `context_window` / `context_length` / `max_input_tokens` / `max_model_len` / `max_total_tokens` / `limit.context` |
| 3 | `{origin}/props` | GET | `default_generation_settings.n_ctx` → `general.n_ctx` → `n_ctx`（llama.cpp llama-server） |
| 4 | `{origin}/server_info` | GET | `max_model_len`（vLLM） |
| 5 | `{origin}/info` | GET | `max_total_tokens`（TGI） |
| 6 | `{origin}/api/show` | POST `{"name": <模型>, "verbose": true}` | `context_length` → `model_info["general.context_length"]` → `parameters` 文本里的 `num_ctx`（Ollama） |

密钥按 `probeApiKey` → 该路由配置里的 `apiKeyEnv`（经宿主凭据 seam `ctx.credentials` 解析）→ 同名启动环境/环境变量 的顺序取；拿不到就去掉密钥再试一遍（很多本地服务的 `/health` 本来就不要密钥）。

**连不上就早停**：候选里连续两次都是传输层失败（超时 / 拒连，不是 404、401 这种「服务活着但不认这个路径」）就不再往下等，状态里标成「连不上这个端点」——一台没开的局域网机器不会把一次探测拖成六次超时。

拿到之后：

1. 用 `ctx.llm.resolveModelInfo()` 读当前**生效**的上限（不发网络请求）；
2. 不一样就经 `ctx.configEditor.edit()` 把 profile patch 里 `llm-pi-ai` 那一行的 `providers.<provider>.models[].contextWindow` 改成上报值（列表里没有这个模型就追加一条 `{id, name, contextWindow}`；该路由没有 `models` 列表则退到 `modelOverrides.<model>.contextWindow`）；
3. `providers` 是 **volatile** 配置，落盘即热生效——**下一个请求就按新 W 走，不必重启 DSH**。

绝不瞎写的四道闸：

- **身份核对**：端点回显了模型名却不是本次这个模型 → 判为 `identity_mismatch`，不写（`/v1/models` 按 id 选条目天然核对）。
- **可信区间**：默认只认 1024 … 8388608 之间的整数；字符串数字也认，别的形状一律不猜。
- **钉死名单**：`pins` 里点过的 `provider/model` 永不覆盖。
- **写入限流**：默认一小时最多 10 次、两次之间至少隔 2 秒（服务端反复换模型/换 n_ctx 时不会把 patch 写花）。

### 2. 托管自动压缩阈值

把插件设定的 `thresholdRatio`（**默认 0.8，可在设置页改**）写进 profile patch 里 `compaction-basic` 那一行，于是「到 W 的几成自动压缩」由本插件决定，宿主那套公式与保留策略照原样跑。可选一并覆盖 `headroomTokens` / `retainRatio` / `retainTokens`（**不设就不动宿主默认** 65536 / 0.16）。

- 用户没改过比例时**一次盘都不写**（宿主默认本来就是 0.8）。
- 写之前先在快照上算一遍：`retainRatio ≥ thresholdRatio` 这种宿主会在加载时拒绝的组合，直接挡下并回报原因，不把坏配置写进去。
- **两条写入通道，自动选**：先走 `configEditor`；够不到那一行时改走 profile patch 顶层直写。为什么要第二条路——桌面/Web profile 的 `standard` 预设把压缩三件套装进 `- id: compaction`（`cordis:group` + `isolate: compaction`）里，组里的嵌套条目**没有活 fiber**，`configEditor` 会当场拒（`Configuration entry is no longer available`），`ctx.compaction` 也因 isolate 取不到。而 loader 的 id 索引会**递归进 group 的 config**、宿主对 `cordis.patch.yml` 本身有监听 —— 所以往这份文件追加一条**顶层** `- id: compaction-basic / config: {…}` 就能被认下并热重组（本机实测：写完 6 秒，那一行组合出来的配置就从无变成 `retainRatio: 0.2`）。设置页的「这次后端配置走的是哪条通道」一行说的就是这件事。
- 顶层直写这条通道只做行级文本改写，分寸拿捏在：不解析整份 YAML、不动别人的行、内容一样就不写盘（幂等）、那一段带 `!!js` 表达式就**一律不动**、**删键只删自己写过的**（`retainRatio` / `retainTokens` 并存是宿主禁止的，这种"必须二选一"的删除不问出处）、CRLF 文件保持 CRLF，并且靠一段带 `dsh-context-governor` 字样的注释认回自己写过的那一段（改写时连注释一起换，不会越攒越多）。注意顶层 override 会**整段替换**那条的 config，所以插件先把条目当前组合出来的配置当底并进来再写。
- 阈值写不进后端配置时（`writeCompactionConfig: false`，或两条通道都到不了那条），`ownPressureTrigger: "auto"` 让本插件自己在 `agent/pre-step` 上按同一口径调用 `ctx.compaction.compactIfNeeded()`；`always` = 与后端一起盯，`never` = 完全交给后端。后端被 isolate 在组里时本插件拿不到 `ctx.compaction`，`auto` 正确地不开。
- 组合里**没有压缩后端**时谁都无法自动压缩（`compactIfNeeded` 没人实现）——设置页直接把这件事说出来，而不是静默。

## 「设置 → 上下文」分区

分区（客户端半个插件 `lib/client.js`，走 slots `settings.section`，`order: 64`，与「窗口大小」「桌宠」同一层）里的东西：

| 控件 | 作用 |
| --- | --- |
| 启用本插件 / 自动修正上限 / 把阈值写进压缩后端 | 三个开关，点一下就落盘并生效 |
| 比例 + 保存 | 自动压缩阈值 `thresholdRatio`（0.05–0.99）；旁边一行写出宿主公式与当前余量，再一行写清**这次后端配置是从哪条通道落盘的**（`configEditor` 还是 profile patch 顶层直写）和预览里 O 的口径 |
| 探测范围 / 谁来触发压缩 | 下拉：只回环、回环+内网（默认）、所有 provider；auto（默认）/ always / never |
| 间隔 / 超时 / 写入上限比例 / headroomTokens / retainRatio | 数字输入，随「保存高级设置」一起写；「写入上限比例」下面另有一段解释——小于 1 等于把阈值提前多少，插件永远按你填的数算，不替你改 |
| 本分区文案语言 | `auto`（跟随 DSH「设置 → 通用 → 语言」，**切语言立刻生效**）/ 钉死 zh / en |
| 状态表（每条路由一行） | 生效上限 W、服务端上报值与来源端点、生效阈值 tokens、状态（已一致 / **待应用** / 已修正 / 身份不符 / 问不到 / 不在探测范围 / 已钉死），以及每条自己的「探测 / 应用」按钮 |
| 立即探测全部 / 立即应用全部待应用 / 恢复默认设置 / 清空探测记录 / 刷新 | 四个动作 + 刷新 |
| 最近的改写与探测 | 审计列表（哪条路由从多少改到多少、走哪个端点、自触发压缩时压力与阈值） |
| 状态与文件 | 状态文件、设置文件、profile patch 的路径 |

**生效时机**：分区里的选择写进 `settings.json` 后**立刻生效**（改比例会顺带把阈值同步进压缩后端并热生效），下次启动继续沿用；不需要重启 DSH，也不需要重装插件。

## 怎么算「本地模型」

默认口径是 **回环 + 内网**（`probeScope: "loopback-private"`）：

- 回环：`127.0.0.0/8`、`localhost`、`*.localhost`、`::1`、`::ffff:127.x`、`0.0.0.0/8`；
- 内网：`10/8`、`172.16–31/12`、`192.168/16`、`169.254/16`、CGNAT `100.64–127/10`、IPv6 `fe80::/10` 与 `fc00::/7`、`*.local` / `*.internal`；
- 其余（`8.8.8.8`、`api.example.com` 这种）默认**一问都不问**。

`probeScope: "loopback"` 只认第一类；`"any"` 全都问（云端端点会多出网络请求，且上报字段本来就有的网关也会被采纳）。

## 状态文件与设置文件

目录：`~/.dsh/storages/context-governor/`

| 文件 | 谁写 | 内容 |
| --- | --- | --- |
| `state.json` | 插件 | `{ "version": 1, "applied": {"<provider>\|<model>": {at, before, after, reported, kind, endpoint, forced}}, "probes": {…}, "audit": […], "writes": [ts…] }` |
| `settings.json` | 设置页 | 白名单键的当前选择 + `updatedAt`；例如 `{ "version": 1, "thresholdRatio": 0.85, "autoFixContextWindow": true }` |

两个 JSON 都是**原子写**（临时文件 + rename），并发读不会读到半写文件；`settings.json` 改写时**保留别人写的未知键**。手动删 `settings.json` = 设置页回到 patch config / 内置默认；删 `state.json` = 从零开始记。

## 配置（cordis.patch.yml）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关（关掉时设置页路由仍注册，还能看现状） |
| `autoFixContextWindow` | `true` | 不一致就直接写 patch 并热生效；`false` = 只显示「待应用」 |
| `thresholdRatio` | `0.8` | 自动压缩阈值比例（0.05–0.99），写进 compaction-basic |
| `writeCompactionConfig` | `true` | 是否把阈值写进压缩后端的 patch 配置 |
| `ownPressureTrigger` | `"auto"` | `auto` 只在阈值写不进后端配置时自己盯；`always` 总是；`never` 从不 |
| `probeScope` | `"loopback-private"` | 本地口径：`loopback` / `loopback-private` / `any` |
| `probeIntervalMs` | `30000` | 同一 provider+model 两次探测的最小间隔 |
| `probeTimeoutMs` | `2500` | 单次 HTTP 探测超时 |
| `probeApiKey` | `""` | 探测用密钥；空 = 按该路由的 `apiKeyEnv` 经凭据 seam 解析。**别在这里写明文密钥** |
| `contextSafetyRatio` | `1` | 写入值 = 上报值 × 该比例（0.5–1） |
| `minReportedContextWindow` / `maxReportedContextWindow` | `1024` / `8388608` | 上报值可信区间（区间外当噪声；上限至少不低于宿主兜底 262144） |
| `maxWritesPerHour` / `minWriteIntervalMs` | `10` / `2000` | patch 写入限流 |
| `headroomTokens` / `retainRatio` / `retainTokens` | `null` | `null` = 不动宿主默认；`retainRatio` 与 `retainTokens` 互斥（两个都给按 `retainTokens`） |
| `pins` | `[]` | `[{provider, model, contextWindow}]` 手工钉死，插件不覆盖 |
| `stateFile` | 空 | 自定义状态文件路径（设置文件取同目录的 `settings.json`） |
| `language` | `"auto"` | 设置页文案语言：`auto` 跟随 DSH 当前语言，`zh` / `en` 钉死 |

> 优先级：**设置页（`settings.json`）> 本文件的 config > 插件内置默认值**。设置页只认白名单键（`stateFile` 与 `pins` 只能在 patch 里写）。
> patch 里的 config 属 Cordis 配置，改动要重启 DSH 或触发 profile 重组才生效；设置页的选择走 `settings.json`，**不需要**重启。

## 与宿主机制的关系

- 写配置优先走 `@deepseek-ai/dsh-config-editor` 的 `edit(entry, change)`：它带跨进程文件锁、按目标插件的 schema 校验、落盘 `cordis.patch.yml` 并只重组那一行。**副作用**：被改的那一行（`llm-pi-ai` / `compaction-basic`）的 `config` 节点会被整体重写，写在 config **内部**的行内注释可能被抹掉；写在行上方的注释通常保留。要留长说明请写在行上方。
- `cordis:group` + `isolate` 的组合里，成员条目在 `configEditor` 的 `entries()` 里看得见、却因为没有 fiber 而改不动（宿主自己的设置页同样改不动它们）；本插件对这种情况有上面那条顶层 override 兜底。三个实测事实记在这里免得日后重新猜：`applyEntryPatches` 的 id 索引 `buildMap` 会递归进 `group` 的 `config`；同 id 有多个条目时**后建的那个赢**（本机命中的正是组里那条）；`Include` 对自己那份 patch 文件带监听，改完会 `root.update(applyPatches(...))` 热重组。
- 读上限走 `ctx.llm.resolveModelInfo()`（不联网），读压力走 `ctx.tokenMeter.measure()`（只在自己触发时读），压缩动作只调 `ctx.compaction.compactIfNeeded()`，密钥只经 `ctx.credentials`。这些服务一律 `ctx.get(...)` 可选取用 + `typeof` 检查：缺谁就少干那件事，绝不因为拿不到服务而让插件炸。
- 状态页显示的阈值是**预览**：宿主算阈值还要减 O（每次请求给输出预留的量），O 取自会话的请求信封；`resolveModelInfo` 不报 `defaultMaxTokens` 时预览按 0 计，所以显示值可能略高于真实触发点（真实触发只会更早，不会更晚）。
- 不往会话里注入任何模型可见内容，不改系统提示词，不加工具，不写会话日志的新事件类型——只有 profile patch 与自己的两个 JSON 文件会被写。

## 安装 / 重载

```bash
# 普通安装：装打包产物
copy dist\dsh-context-governor-<版本>.tgz %USERPROFILE%\.dsh\.plugin-sources\
dsh plugin --profile desktop add "%USERPROFILE%\.dsh\.plugin-sources\dsh-context-governor-<版本>.tgz"

# 开发期：热装配（免重启）
dev_install_package  dir=<本仓库绝对路径>  profile=desktop
dev_reload_package   dsh-context-governor   # 只换宿主那一半；设置页还得刷新一次
```

卸载：`dsh plugin --profile desktop remove dsh-context-governor`，或 `dev_uninject_plugin dsh-context-governor`。

`<profile>` 填什么：`dir %USERPROFILE%\.dsh\profiles` 里看到什么就填什么（桌面端常见 `desktop`）。**新装/新启用的插件条目要重启 DSH 宿主才会加载**（宿主侧代码之后的改动可以 `dev_reload_package` 热重载；`lib/client.js` 改了还要刷新页面）。

## 离线自检

```bash
node scripts/selftest.mjs        # 或 npm test（先 node --check 三个文件）
```

14 个编号组、不联网、临时目录都在系统 tmp 下（**不碰**真实的 `~/.dsh/storages/context-governor`）：配置归一与优先级、「本地模型」判定（含 IPv6 各种写法与 CGNAT）、候选端点构造、上报值解析（Strata `/health` 与 `/v1/models`、llama.cpp `/props`、vLLM `/server_info`、TGI `/info`、Ollama 的点键与 `parameters` 文本，加身份不符 / 越界 / 没有字段 / 坏 JSON）、providers patch 生成（改条目 / 补条目 / `modelOverrides` 回退 / 无变化 / 不原地改入参）、compaction patch 与阈值公式（含预算被压平时退纯比例）、状态与设置文件（原子写、未知键保留、坏文件容错）、`probeTarget` 端到端（假 fetch：`/health` 401 退到 `/v1/models`、带 key、超时、连不上两次就早停、身份不符、范围外、安全系数）、设置页 HTTP 路由（假 ctx + 真 http server + 真 fetch：`/state` `/settings` `/probe` `/apply` `/reset` `/clear`、未知路由、坏 JSON、`retain` 冲突）、生命周期（`agent/pre-step` 节流、`next()` 交还、own 触发三种口径、卸载后不空转、webServer 晚到的重试注册）、假 React 真渲染中英两版界面（词典逐 key 与占位符对齐、英文里不留中文、不把内部 key 甩成文案、开关与按钮真的 POST 出去）、脱敏扫描、清单一致性（`package.json` 的 exports/files 与实际文件、版本号与宿主里那份一致）、profile patch 顶层直写（追加 / 幂等 / 就地改写连注释 / 带 `!!js` 不动 / CRLF 保持 / 缩进里的同名条目不当入口 / 合并语义 / YAML 值渲染，以及假 `configEditor` 直拒后的完整兜底落盘——顺带盯住「链里再 enqueue」不得把自己等死）。

## 零依赖红线

只用 node 内置模块（`fs`/`os`/`path`），不声明任何运行时依赖，也不放二进制；客户端半个插件只用客户端模块加载器注入的 `react`。装打包产物时声明了的依赖要在安装那一刻解析；用 `link:` 调试时 pnpm 根本不装被链接包自己的依赖——任一运行时依赖解析失败会让 Cordis 插件树整体抛错、DSH 起不来。

## 已知限制

- **上报值是服务端口径，不是 DSH 口径**：服务端报的是「窗口总量」，DSH 还要从中扣请求输出预留与压缩余量；本插件只负责把 `W` 写对，不动 `O`/`B` 的语义。
- **没回显模型名的端点只能「未核对」地接受**：状态里会写明「服务端没回显模型名」。这类端点若在同一端口上换过模型，本插件只能靠 TTL 内的下一次探测追上来。
- **只改 `contextWindow`，不改 `maxTokens`**：输出预留来自请求信封或路由默认值，本插件不碰。
- **`modelOverrides` 只在目录型路由上可用**：手工声明且没有 `models` 列表的路由（极少），宿主不接受 `modelOverrides`，此时插件会报 `row_missing`/写入失败而不是硬写。
- **同一 profile 内多个宿主进程并发写 patch** 由 configEditor 的文件锁串行；本插件额外把写入排成一条队。**兜底那条通道不受这把锁管**（它写的是 `cordis.patch.yml` 而不是 `package.json`）：插件在写之前会重读全文再改自己那一段，窗口很小，但如果同一瞬间宿主也在改这份文件，理论上是"后写的赢"。不想承担这点风险就把 `writeCompactionConfig` 关掉，自己维护那一行。
- **手工写在 patch 里的那一行可能被本插件改写**：兜底通道认的是顶层 `- id: compaction-basic` 这一段，内容不一致就会整段换成它算出来的样子（别人写的键会并进来当底，但格式与注释不保留）。想让那一行完全归你，就把「把阈值写进压缩后端」关掉。
- **压缩本身仍由压缩后端做**（本插件只在写不进阈值时顶上），摘要质量与 `/compact` 行为都属于 `dsh-compaction-basic`。

## 许可

MIT，见 LICENSE。
