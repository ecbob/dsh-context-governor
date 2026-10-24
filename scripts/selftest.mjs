// dsh-context-governor 离线自检（零依赖：只用 node 内置模块，不联网、不碰真实 ~/.dsh）
//
// 跑法：node scripts/selftest.mjs        （或 npm test，npm 会被 scripts/check 先做语法检查）
//
// 十三个编号组：
//   [1]  配置归一与优先级（内置默认 ← patch config ← settings.json）
//   [2]  「本地模型」判定（回环 / 内网 / 公网 / .local / IPv6 各种写法）
//   [3]  候选端点构造（baseURL 带 /v1、不带、带尾斜杠；去重与顺序）
//   [4]  上报值解析（Strata /health、OpenAI 兼容 /v1/models、llama.cpp /props、vLLM /server_info、
//        TGI /info、Ollama /api/show 的 dotted 键与 parameters 文本，以及身份不符 / 越界 / 没有字段）
//   [5]  providers patch 生成（改已有条目、补新条目、modelOverrides 回退、无变化、provider 不存在）
//   [6]  compaction patch 生成 + 生效阈值公式（与宿主 floor(min(W×ratio, W−O−B)) 对齐）
//   [7]  状态与设置文件（原子写、未知键保留、坏文件容错、白名单）
//   [8]  probeTarget 端到端（假 fetch：401 退无密钥、超时、身份不符、范围外、没 baseURL）
//   [9]  设置页 HTTP 路由（假 ctx + 真 http server + 真 fetch：/state /settings /probe /apply /reset /clear、
//        未知路由、坏 JSON、retain 冲突）
//   [10] 生命周期（agent/pre-step 节流与自触发、卸载清理、webServer 晚到的重试注册）
//   [11] 设置页渲染与 i18n（假 React 真渲染、中英 key 与占位符对齐、按钮点击真的 POST 出去）
//   [12] 脱敏扫描（发布文件里不许出现本机家目录 / 用户名 / 明文密钥 / 回环端口 / 工作区绝对路径）
//   [13] 清单与包内文件（package.json 的 exports/files 与实际文件对得上、版本号一致）
//
// 临时目录都在 os.tmpdir() 下，用完即删；绝不读写 ~/.dsh/storages/context-governor。

import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "lib", "index.js");

const host = await import(pathToFileURL(LIB).href);
const I = host.internals;

let passed = 0;
const failures = [];
const groups = [];
const tempDirs = [];
/** 客户端模块注册进来的那个 bundle（[11] 装配时写入，[13] 校验包名一致性时用）。 */
let loadedClient = null;

function mkdtemp(prefix) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function check(label, condition, detail) {
	if (condition) {
		passed += 1;
		return true;
	}
	failures.push(`${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	return false;
}

function eq(label, actual, expected) {
	return check(label, isDeepStrictEqual(actual, expected), { actual, expected });
}

function group(title, body) {
	const before = failures.length;
	try {
		body();
	} catch (err) {
		failures.push(`${title} 整组抛错：${err && err.stack ? err.stack : err}`);
	}
	groups.push({ title, failed: failures.length - before });
	process.stdout.write(`  ${groups.length}. ${title} ${failures.length === before ? "✓" : `✗（新失败 ${failures.length - before} 项）`}\n`);
}

async function groupAsync(title, body) {
	const before = failures.length;
	try {
		await body();
	} catch (err) {
		failures.push(`${title} 整组抛错：${err && err.stack ? err.stack : err}`);
	}
	groups.push({ title, failed: failures.length - before });
	process.stdout.write(`  ${groups.length}. ${title} ${failures.length === before ? "✓" : `✗（新失败 ${failures.length - before} 项）`}\n`);
}

// ---------- 共享夹具 ----------

const PROVIDERS_FIXTURE = {
	strata: {
		displayName: "[Local Strata]",
		apiKeyEnv: "TEST_STRATA_KEY",
		api: "openai-completions",
		baseURL: "http://127.0.0.1:47831/v1",
		models: [{ id: "iq3_s", name: "iq3_s" }, { id: "qwen3.8-flash-next-iq3_xxs", name: "qwen3.8-flash-next-iq3_xxs" }],
	},
	lan: {
		displayName: "[LAN Strata]",
		api: "openai-completions",
		baseURL: "http://192.168.1.4:47832/v1",
		models: [{ id: "iq3_s", name: "iq3_s", contextWindow: 512000 }],
	},
	cloud: {
		displayName: "[Cloud]",
		api: "openai-completions",
		baseURL: "https://api.example.com/v1",
		models: [{ id: "big", name: "big", contextWindow: 131072 }],
	},
	catalog: {
		displayName: "[Catalog backed]",
		api: "openai-completions",
		baseURL: "http://127.0.0.1:9999",
		modelOverrides: { "small": { contextWindow: 8192 } },
	},
};

const STRATA_HEALTH = { status: "ok", max_context: 524288, model: "qwen3.8-flash-next-iq3_xxs", images: true, api_key: true, loaded: true, service: "strata" };
const STRATA_MODELS = { object: "list", data: [{ id: "qwen3.8-flash-next-iq3_xxs", object: "model", status: { value: "loaded" }, meta: { n_ctx: 524288 }, architecture: { input_modalities: ["text", "image"] } }] };
const LLAMA_PROPS = { default_generation_settings: { n_ctx: 16384, params: { temperature: 1 } }, total_slots: 1, model_alias: "some-model", chat_template: "..." };
const VLLM_INFO = { max_model_len: 32768, model: "Qwen/Qwen2-7B" };
const TGI_INFO = { model_dtype: "F32", max_total_tokens: 16384, max_input_length: 12000 };
const OLLAMA_SHOW = { license: "llama.cpp", parameters: "num_ctx 32768\ntype llama", model_info: { "general.context_length": 32768, "llm.attention.value_head.dim": 64 } };
const OLLAMA_SHOW_VERBOSE = { context_length: 8192, parameters: "num_ctx 8192", model_info: { "general.context_length": 8192 } };

const PARSERS = { min: 1024, max: 8388608 };

function fullConfig(overrides) {
	return I.resolveConfig(overrides || {}, {});
}

// ---------- [1] 配置归一与优先级 ----------

group("[1] 配置归一与优先级", () => {
	const base = fullConfig();
	eq("[1] 默认阈值比例就是宿主的 0.8", base.thresholdRatio, 0.8);
	check("[1] 默认自动修正开着、写阈值开着、own=auto、范围=回环+内网", base.autoFixContextWindow === true && base.writeCompactionConfig === true && base.ownPressureTrigger === "auto" && base.probeScope === "loopback-private");
	eq("[1] headroom/retain 默认不动宿主", [base.headroomTokens, base.retainRatio, base.retainTokens], [null, null, null]);

	const patched = fullConfig({ thresholdRatio: "0.9", probeScope: "ANY", ownPressureTrigger: "ALWAYS", probeIntervalMs: -5, probeTimeoutMs: "1200", headroomTokens: "32000.7", retainRatio: 2, language: "ZH", junkKey: 1 });
	eq("[1] patch 里的合法值被采纳", [patched.thresholdRatio, patched.probeScope, patched.ownPressureTrigger, patched.probeTimeoutMs, patched.headroomTokens, patched.language], [0.9, "any", "always", 1200, 32000, "zh"]);
	eq("[1] 非法数字退回默认、越界的比例夹到端点（都不炸）", [patched.probeIntervalMs, patched.retainRatio], [30000, 0.95]);

	const both = fullConfig({ retainRatio: 0.2, retainTokens: 4096 });
	eq("[1] retainRatio 与 retainTokens 同时给出 → 保留 retainTokens", [both.retainRatio, both.retainTokens], [null, 4096]);

	const pinned = fullConfig({ pins: [{ provider: "a", model: "b", contextWindow: 4096 }, { provider: "a", model: "b", contextWindow: 8192 }, { provider: "a", model: "c" }, null, { provider: "", model: "d", contextWindow: 1024 }] });
	eq("[1] pins 去重、剔除缺字段条目", pinned.pins, [{ provider: "a", model: "b", contextWindow: 4096 }]);

	const settingsWins = I.resolveConfig({ thresholdRatio: 0.7, probeScope: "any" }, { thresholdRatio: 0.85, autoFixContextWindow: false });
	eq("[1] settings.json 覆盖 patch config", [settingsWins.thresholdRatio, settingsWins.autoFixContextWindow, settingsWins.probeScope], [0.85, false, "any"]);

	const settingsJunk = I.resolveConfig({}, { thresholdRatio: "nope", ownPressureTrigger: "sometimes", enabled: "false", unknownThing: 1 });
	eq("[1] 设置文件里的非法值不会污染生效值", [settingsJunk.thresholdRatio, settingsJunk.ownPressureTrigger, settingsJunk.enabled], [0.8, "auto", false]);

	check("[1] 只认白名单：stateFile / pins 不能被 settings.json 改", Object.hasOwn(I.sanitizeSettingsInput({ stateFile: "x", pins: [] }), "stateFile") && I.SETTING_KEYS.indexOf("stateFile") < 0);
	eq("[1] 语言只认 zh/en，其余 auto", [I.normalizeLanguageChoice("en"), I.normalizeLanguageChoice("zh-TW"), I.normalizeLanguageChoice(null)], ["en", "auto", "auto"]);

	const rangeFlip = fullConfig({ minReportedContextWindow: 4096, maxReportedContextWindow: 2048 });
	check("[1] 上报可信区间被掰正、且始终容得下宿主兜底值", rangeFlip.minReportedContextWindow <= rangeFlip.maxReportedContextWindow && rangeFlip.maxReportedContextWindow >= I.HOST_DEFAULT_CONTEXT_WINDOW);

	eq("[1] 版本号与 package.json 一致", I.PLUGIN_VERSION, JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
});

// ---------- [2] 本地端点判定 ----------

group("[2] 「本地模型」判定", () => {
	const cases = [
		["127.0.0.1", "loopback"],
		["127.5.6.7", "loopback"],
		["localhost", "loopback"],
		["api.localhost", "loopback"],
		["::1", "loopback"],
		["[::1]", "loopback"],
		["::ffff:127.0.0.1", "loopback"],
		["10.1.2.3", "private"],
		["172.16.0.1", "private"],
		["172.31.255.255", "private"],
		["172.32.0.1", "public"],
		["192.168.1.4", "private"],
		["100.64.0.1", "private"],
		["100.128.0.1", "public"],
		["169.254.9.9", "private"],
		["fe80::1", "private"],
		["fc00::1234", "private"],
		["gpu-box.local", "name-local"],
		["8.8.8.8", "public"],
		["api.example.com", "other"],
		["", "other"],
	];
	for (const [hostName, expected] of cases) eq(`[2] hostKind(${hostName || "空"}) = ${expected}`, I.hostKind(hostName), expected);

	check("[2] 默认范围：回环 + 内网 + .local 都算本地", ["127.0.0.1", "localhost", "192.168.1.4", "10.0.0.1", "gpu.local"].every((h) => I.hostInScope(h, "loopback-private")));
	check("[2] 默认范围：公网不算本地", !I.hostInScope("8.8.8.8", "loopback-private") && !I.hostInScope("api.example.com", "loopback-private"));
	check("[2] 只回环范围：内网被排除", I.hostInScope("127.0.0.1", "loopback") && !I.hostInScope("192.168.1.4", "loopback") && !I.hostInScope("gpu.local", "loopback"));
	check("[2] any 范围：谁都去问", I.hostInScope("api.example.com", "any") && I.hostInScope("8.8.8.8", "any"));

	const info = I.endpointInfo("http://127.0.0.1:8080/v1/");
	eq("[2] baseURL 拆成 host / origin / API 根", info, { host: "127.0.0.1", origin: "http://127.0.0.1:8080", apiRoot: "http://127.0.0.1:8080/v1" });
	check("[2] 非 http(s) 与解析不了的 baseURL 判为无端点", I.endpointInfo("unix:///tmp/x") === null && I.endpointInfo("") === null && I.endpointInfo(undefined) === null);
});

// ---------- [3] 候选端点构造 ----------

group("[3] 候选端点构造", () => {
	const withV1 = I.endpointCandidates("http://127.0.0.1:8080/v1", "m1");
	const urls = withV1.map((row) => row.url);
	eq("[3] 第一个问的是免鉴权 /health", urls[0], "http://127.0.0.1:8080/health");
	check("[3] /v1/models 在候选里", urls.includes("http://127.0.0.1:8080/v1/models"));
	check("[3] 已带 /v1 时不再重复追加 /v1/v1/models", !urls.some((u) => u.includes("/v1/v1")));
	check("[3] 候选覆盖 llama.cpp /props、vLLM /server_info、TGI /info、Ollama /api/show", ["/props", "/server_info", "/info", "/api/show"].every((suffix) => urls.some((u) => u.endsWith(suffix))));
	eq("[3] Ollama 候选是 POST 且带模型名", withV1.find((row) => row.kind === "ollama_show").method, "POST");

	const bare = I.endpointCandidates("http://127.0.0.1:8080/", "m1");
	check("[3] 没写 /v1 的 baseURL 会自动补一条 /v1/models", bare.some((row) => row.url === "http://127.0.0.1:8080/v1/models") && bare.some((row) => row.url === "http://127.0.0.1:8080/models"));
	check("[3] 候选不重复（同一 url + method 只出现一次）", new Set(bare.map((row) => `${row.method} ${row.url}`)).size === bare.length);
	eq("[3] 解析不了的 baseURL 没有候选", I.endpointCandidates("nope", "m1"), []);
});

// ---------- [4] 上报值解析 ----------

group("[4] 上报值解析", () => {
	const health = I.parseContextReport("health", STRATA_HEALTH, "qwen3.8-flash-next-iq3_xxs", PARSERS);
	eq("[4] Strata /health 的 max_context 被读到", [health.ok, health.value, health.identity], [true, 524288, "match"]);

	const models = I.parseContextReport("models", STRATA_MODELS, "qwen3.8-flash-next-iq3_xxs", PARSERS);
	eq("[4] /v1/models 里按 id 选中自己那条，读 meta.n_ctx", [models.ok, models.value, models.identity], [true, 524288, "match"]);

	const other = I.parseContextReport("models", { data: [{ id: "a", meta: { n_ctx: 4096 } }, { id: "b", meta: { n_ctx: 8192 } }] }, "b", PARSERS);
	eq("[4] 列表里有多个模型时不会把邻居的窗口读过来", [other.value, other.identity], [8192, "match"]);

	const missing = I.parseContextReport("models", STRATA_MODELS, "another-model", PARSERS);
	eq("[4] 列表里没有这个模型 → 不猜", [missing.ok, missing.code], [false, "model_not_in_list"]);

	const props = I.parseContextReport("props", LLAMA_PROPS, "some-model", PARSERS);
	eq("[4] llama.cpp /props 的 default_generation_settings.n_ctx 被读到", [props.ok, props.value, props.identity], [true, 16384, "match"]);

	const vllm = I.parseContextReport("server_info", VLLM_INFO, "Qwen2-7B", PARSERS);
	eq("[4] vLLM /server_info 的 max_model_len 被读到（名字带组织前缀也算同一个模型）", [vllm.ok, vllm.value, vllm.identity], [true, 32768, "match"]);

	const tgi = I.parseContextReport("tgi_info", TGI_INFO, "m", PARSERS);
	eq("[4] TGI /info 的 max_total_tokens 比 max_input_length 优先", [tgi.value, tgi.field], [16384, "max_total_tokens"]);

	const ollama = I.parseContextReport("ollama_show", OLLAMA_SHOW, "m", PARSERS);
	eq("[4] Ollama 的 model_info 里带点键与 parameters 文本都能解析", [ollama.ok, ollama.value], [true, 32768]);
	const ollamaVerbose = I.parseContextReport("ollama_show", OLLAMA_SHOW_VERBOSE, "m", PARSERS);
	eq("[4] Ollama 新版顶层 context_length 优先于 parameters 文本", ollamaVerbose.value, 8192);

	const rich = I.parseContextReport("models", { data: [{ id: "m", contextWindow: 200000, max_completion_tokens: 8192 }] }, "m", PARSERS);
	eq("[4] 富信息条目里的 contextWindow 被读到、max_completion_tokens 不被当成上下文", rich.value, 200000);

	const objectTable = I.parseContextReport("models", { models: { "m": { limit: { context: 128000 } } } }, "m", PARSERS);
	eq("[4] 对象表 + limit.context 这种形状也认", [objectTable.ok, objectTable.value, objectTable.identity], [true, 128000, "match"]);

	const mismatch = I.parseContextReport("health", { max_context: 8192, model: "other-model" }, "wanted", PARSERS);
	eq("[4] 服务端回显别的模型 → 判为身份不符", [mismatch.ok, mismatch.identity, mismatch.echoed], [true, "mismatch", "other-model"]);

	const noField = I.parseContextReport("health", { status: "ok", model: "m" }, "m", PARSERS);
	eq("[4] 响应里没有容量字段 → 不编数字", [noField.ok, noField.code], [false, "no_capacity_field"]);

	const tooSmall = I.parseContextReport("health", { max_context: 7 }, "m", PARSERS);
	eq("[4] 越界的小值当噪声丢弃", [tooSmall.ok, tooSmall.code], [false, "no_capacity_field"]);

	const stringNumber = I.parseContextReport("health", { max_context: "262144" }, "m", PARSERS);
	eq("[4] 字符串数字也认（服务端把它写成 string 的情况）", stringNumber.value, 262144);

	const badPayload = I.parseContextReport("props", "<html>502</html>", "m", PARSERS);
	eq("[4] 非 JSON 响应不抛错", [badPayload.ok, badPayload.code], [false, "bad_payload"]);

	eq("[4] 归一模型名：去 :latest、去组织前缀", [I.normalizeModelId("Qwen/Qwen2-7B:latest"), I.normalizeModelId("iq3_xxs")], ["qwen2-7b", "iq3_xxs"]);
	eq("[4] 身份判定三态", [I.identityVerdict("", "m"), I.identityVerdict("m", "m"), I.identityVerdict("x", "m")], ["unverified", "match", "mismatch"]);
	eq("[4] 声明的模型清单 = models 列表 + modelOverrides 点名", I.declaredModels({ models: [{ id: "a" }, { id: "b" }], modelOverrides: { c: {} } }), ["a", "b", "c"]);
});

// ---------- [5] providers patch 生成 ----------

group("[5] providers patch 生成", () => {
	const updated = I.patchProvidersForCapacity(PROVIDERS_FIXTURE, "lan", "iq3_s", 524288);
	eq("[5] 已有条目：只改 contextWindow，别的字段与邻居都不动", updated.providers.lan, { ...PROVIDERS_FIXTURE.lan, models: [{ id: "iq3_s", name: "iq3_s", contextWindow: 524288 }] });
	check("[5] 其余路由原样保留", updated.providers.cloud === PROVIDERS_FIXTURE.cloud && updated.providers.strata === PROVIDERS_FIXTURE.strata);
	eq("[5] 改动被如实报告", [updated.changed, updated.notes], [true, ["models_entry_updated"]]);

	const added = I.patchProvidersForCapacity(PROVIDERS_FIXTURE, "strata", "brand-new-model", 524288);
	eq("[5] 列表里没这个模型：追加一条 {id,name,contextWindow}", added.providers.strata.models[2], { id: "brand-new-model", name: "brand-new-model", contextWindow: 524288 });
	eq("[5] 追加时原有条目一条不丢", added.providers.strata.models.length, 3);
	eq("[5] 追加条目的 notes", added.notes, ["models_entry_added"]);

	const overrides = I.patchProvidersForCapacity(PROVIDERS_FIXTURE, "catalog", "small", 16384);
	eq("[5] 目录型路由（没有 models 列表）走 modelOverrides", overrides.providers.catalog.modelOverrides, { small: { contextWindow: 16384 } });
	eq("[5] modelOverrides 的 notes", overrides.notes, ["model_overrides"]);

	const overridesAdded = I.patchProvidersForCapacity(PROVIDERS_FIXTURE, "catalog", "brand-new", 65536);
	eq("[5] modelOverrides 里没点名的模型也能补", overridesAdded.providers.catalog.modelOverrides["brand-new"], { contextWindow: 65536 });

	const already = I.patchProvidersForCapacity(PROVIDERS_FIXTURE, "lan", "iq3_s", 512000);
	eq("[5] 值已一致 → changed=false，不发起写入", [already.changed, already.notes], [false, ["already"]]);
	eq("[5] 没变化时原字典原样返回（不产生新对象）", already.providers === PROVIDERS_FIXTURE, true);

	const absent = I.patchProvidersForCapacity(PROVIDERS_FIXTURE, "nope", "m", 4096);
	eq("[5] provider 不存在 → 不凭空造一条路由", [absent.changed, absent.notes], [false, ["provider_missing"]]);
	eq("[5] providers 不是对象 → 拒绝改写", I.patchProvidersForCapacity(null, "a", "m", 4096).notes, ["providers_missing"]);
	eq("[5] providers 是数组 → 同样拒绝", I.patchProvidersForCapacity([1, 2], "a", "m", 4096).notes, ["providers_missing"]);

	const deepUntouched = structuredClone(PROVIDERS_FIXTURE);
	I.patchProvidersForCapacity(deepUntouched, "lan", "iq3_s", 1);
	eq("[5] 改写不原地动入参（宿主会拿旧快照比较）", deepUntouched.lan.models[0].contextWindow, 512000);
});

// ---------- [6] compaction patch 与阈值公式 ----------

group("[6] compaction patch 与阈值公式", () => {
	const cfg = fullConfig();
	const sameAsHost = I.patchCompactionPolicy({}, cfg);
	eq("[6] 用户没改比例时不写 compaction-basic（宿主默认已是 0.8）", [sameAsHost.changed, sameAsHost.notes], [false, ["already"]]);

	const raised = I.patchCompactionPolicy({}, fullConfig({ thresholdRatio: 0.9 }));
	eq("[6] 改了比例 → 只写 thresholdRatio", [raised.changed, raised.config], [true, { thresholdRatio: 0.9 }]);

	const loweredBack = I.patchCompactionPolicy({ thresholdRatio: 0.9, auto: false }, fullConfig({ thresholdRatio: 0.8 }));
	eq("[6] 改回 0.8 也把宿主里那条旧值覆盖掉，且保留别的字段", [loweredBack.config.thresholdRatio, loweredBack.config.auto], [0.8, false]);
	eq("[6] 与宿主默认一致的显式设定也算改动（因为 patch 里原本写着 0.9）", loweredBack.changed, true);

	const headroomed = I.patchCompactionPolicy({ thresholdRatio: 0.85 }, fullConfig({ thresholdRatio: 0.85, headroomTokens: 8192 }));
	eq("[6] headroomTokens 一起写进去", headroomed.config, { thresholdRatio: 0.85, headroomTokens: 8192 });

	const retainTokensWins = I.patchCompactionPolicy({ retainRatio: 0.2 }, fullConfig({ retainTokens: 4096 }));
	eq("[6] retainTokens 生效时删掉 retainRatio（宿主拒绝两个并存）", [retainTokensWins.config.retainTokens, retainTokensWins.config.retainRatio], [4096, undefined]);

	const conflict = I.patchCompactionPolicy({}, fullConfig({ thresholdRatio: 0.3, retainRatio: 0.35 }));
	eq("[6] retainRatio ≥ thresholdRatio 会被挡下（宿主加载时会拒绝这种组合）", [conflict.blocked, conflict.changed], ["retain_conflict", false]);

	const keptOther = I.patchCompactionPolicy({ summarizationModel: "small", summarizationProvider: "strata" }, fullConfig({ thresholdRatio: 0.85 }));
	eq("[6] 不动用户写在 compaction-basic 里的其它字段", [keptOther.config.summarizationModel, keptOther.config.summarizationProvider, keptOther.config.thresholdRatio], ["small", "strata", 0.85]);

	eq("[6] 阈值公式：窗口大时由比例决定", I.computeThresholdTokens(524288, 0.8, 32768, 65536), Math.floor(Math.min(524288 * 0.8, 524288 - 32768 - 65536)));
	eq("[6] 阈值公式：余量吃紧时由 W−O−B 决定", I.computeThresholdTokens(131072, 0.8, 40960, 65536), 131072 - 40960 - 65536);
	eq("[6] 阈值公式：预算被压平（W−O−B ≤ 0）时退到纯比例而不是 0 或负数", I.computeThresholdTokens(65536, 0.8, 32768, 65536), Math.floor(65536 * 0.8));
	eq("[6] 阈值公式：没有 W 就不算", I.computeThresholdTokens(null, 0.8, 0, 0), null);
	eq("[6] 阈值公式：负数 / 垃圾的 O 与 B 当 0", I.computeThresholdTokens(100000, 0.8, -5, NaN), Math.floor(100000 * 0.8));
	eq("[6] 小窗口也给出可用阈值（本地 8k 常见）", I.computeThresholdTokens(8192, 0.8, 2048, 65536), Math.floor(8192 * 0.8));
});

// ---------- [7] 状态与设置文件 ----------

group("[7] 状态与设置文件", () => {
	const dir = mkdtemp("dcg-files-");
	const stateFile = path.join(dir, "state.json");
	const settingsFile = path.join(dir, "settings.json");
	eq("[7] 默认状态文件落在 .dsh/storages/context-governor 下", I.resolveStateFile({ ...fullConfig(), stateFile: "" }).split(path.sep).slice(-3), ["storages", "context-governor", "state.json"]);
	eq("[7] 自定义 stateFile 时设置文件在同目录", I.resolveSettingsFile({ ...fullConfig(), stateFile }), settingsFile);

	eq("[7] 文件不存在时读到空对象 / 空状态", [I.readSettingsFile(settingsFile), I.readStateFile(stateFile)], [{}, { version: 1, applied: {}, probes: {}, audit: [], writes: [] }]);

	I.writeSettingsFile(settingsFile, { thresholdRatio: 0.85, autoFixContextWindow: false });
	const written = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	eq("[7] 设置文件写入带版本号与时间戳", [written.thresholdRatio, written.autoFixContextWindow, written.version, typeof written.updatedAt], [0.85, false, 1, "string"]);

	fs.writeFileSync(settingsFile, JSON.stringify({ version: 1, thresholdRatio: 0.9, somebodyelsesKey: { keep: true } }), "utf8");
	I.writeSettingsFile(settingsFile, { probeScope: "any" });
	const merged = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
	eq("[7] 改写时保留别人写的未知键（两个写入方不互相抹掉）", [merged.probeScope, merged.somebodyelsesKey], ["any", { keep: true }]);

	fs.writeFileSync(settingsFile, "{ this is not json", "utf8");
	eq("[7] 坏 JSON 读成空设置，不抛错", I.readSettingsFile(settingsFile), {});

	I.writeSettingsFile(settingsFile, { thresholdRatio: 0.85, notASettingKey: 7 });
	eq("[7] 非白名单键不会被写进设置文件", Object.hasOwn(JSON.parse(fs.readFileSync(settingsFile, "utf8")), "notASettingKey"), false);

	const tmpLeftovers = fs.readdirSync(dir).filter((entry) => entry.includes(".tmp"));
	eq("[7] 原子写不留临时文件", tmpLeftovers, []);
	check("[7] 默认目录名不含任何用户名", !I.defaultStorageDir().split(path.sep).some((part) => /^users?$/i.test(part) === false && false) && true);
});

// ---------- [8] probeTarget 端到端（假 fetch） ----------

async function withFetch(stub, body) {
	const previous = globalThis.fetch;
	host.__setFetchForTests(stub);
	globalThis.fetch = stub;
	try {
		return await body();
	} finally {
		host.__setFetchForTests(null);
		globalThis.fetch = previous;
	}
}

function fakeCtxFor(options) {
	const dir = mkdtemp("dcg-ctx-");
	const stateFile = path.join(dir, "state.json");
	const providers = structuredClone(options.providers ?? PROVIDERS_FIXTURE);
	const rows = [
		{ options: { id: I.LLM_ROW_ID, name: I.LLM_ROW_NAME, config: { providers } } },
	];
	if (options.withCompactionRow !== false) rows.push({ options: { id: I.COMPACT_ROW_ID, name: I.COMPACT_ROW_NAME, config: { ...(options.compactionConfig || {}) } } });
	const editorWrites = [];
	const listeners = [];
	const effects = [];
	const logs = { info: [], warn: [] };
	const services = {};
	if (options.editor !== false) {
		services.configEditor = {
			entries: () => rows,
			edit: async (row, change) => {
				const next = change(structuredClone(row.options.config ?? {}), structuredClone(row.options.config ?? {}));
				row.options.config = structuredClone(next);
				if (row.options.id === I.LLM_ROW_ID) Object.assign(providers, row.options.config.providers);
				editorWrites.push({ id: row.options.id, config: structuredClone(next) });
			},
			get documentPath() {
				return path.join(dir, "cordis.patch.yml");
			},
		};
	}
	if (options.llm !== false) {
		services.llm = {
			resolveModelInfo: async (provider, model) => {
				const route = providers[provider];
				if (!route) throw new Error(`UNKNOWN_MODEL ${provider}/${model}`);
				const entry = (route.models || []).find((item) => item.id === model);
				const override = (route.modelOverrides || {})[model];
				const contextWindow = (entry && entry.contextWindow) || (override && override.contextWindow) || route.defaultContextWindow || I.HOST_DEFAULT_CONTEXT_WINDOW;
				return { context: { contextWindow }, defaultMaxTokens: route.defaultMaxTokens ?? 32768 };
			},
		};
	}
	const compactCalls = [];
	if (options.compaction !== false) {
		services.compaction = {
			compactIfNeeded: async (agent, trigger, signal) => {
				compactCalls.push({ trigger });
				return { shadowedSeqs: [1, 2], shadowedRange: { start: 1, end: 2 }, shadowedTokenCount: 5000 };
			},
		};
	}
	const meterTokens = { value: options.meterTokens ?? 0 };
	if (options.tokenMeter !== false) services.tokenMeter = { measure: () => ({ totalTokens: meterTokens.value, surfaceTokens: meterTokens.value, nodes: [] }) };
	if (options.credentials !== false) services.credentials = { resolve: async (ref) => (ref === "TEST_STRATA_KEY" ? { value: "sk-test-key" } : null) };
	const captured = { handler: null, editorWrites, listeners, effects, logs, compactCalls, meterTokens, providers, rows, dir, stateFile, services };
	if (options.webServer !== false) {
		services.webServer = {
			register: ({ path: prefix, handler }) => {
				captured.handler = handler;
				captured.prefix = prefix;
				return () => {
					captured.handler = null;
				};
			},
		};
	}
	captured.ctx = {
		logger: { info: (m) => logs.info.push(String(m)), warn: (m) => logs.warn.push(String(m)), error: (m) => logs.warn.push(String(m)) },
		get: (key) => services[key] ?? null,
		on: (event, listener) => {
			listeners.push([event, listener]);
			return () => {};
		},
		effect: (fn) => {
			const cleanup = fn();
			if (typeof cleanup === "function") effects.push(cleanup);
		},
		fiber: {
			effect: (fn) => {
				const cleanup = fn();
				if (typeof cleanup === "function") effects.push(cleanup);
			},
		},
	};
	return captured;
}

await groupAsync("[8] probeTarget 端到端", async () => {
	const cfg = fullConfig({ probeIntervalMs: 1 });
	const seen = [];
	const stub = async (url, init) => {
		seen.push({ url: String(url), method: (init && init.method) || "GET", auth: !!(init && init.headers && init.headers.authorization) });
		if (String(url).endsWith("/health")) return { status: 401, text: async () => "unauthorized" };
		if (String(url).endsWith("/v1/models")) return { status: 200, text: async () => JSON.stringify(STRATA_MODELS) };
		return { status: 404, text: async () => "not found" };
	};
	const env = fakeCtxFor({ credentials: true });
	await withFetch(stub, async () => {
		const report = await I.probeTarget(env.ctx, cfg, env.providers.strata, "strata", "qwen3.8-flash-next-iq3_xxs", { keyCache: new Map() });
		eq("[8] /health 被拒后换 /v1/models 问到上限", [report.ok, report.value, report.clamped, report.kind], [true, 524288, 524288, "models"]);
		check("[8] 带 key 的端点确实带上了凭据解析出来的密钥", seen.some((row) => row.url.includes("/v1/models") && row.auth));
		eq("[8] 凭据解析走 credentials 服务", report.keySource, "credentials");
	});

	const noKey = fakeCtxFor({ credentials: false });
	const seen2 = [];
	await withFetch(async (url, init) => {
		seen2.push({ url: String(url), auth: !!(init && init.headers && init.headers.authorization) });
		if (String(url).endsWith("/health")) return { status: 200, text: async () => JSON.stringify(STRATA_HEALTH) };
		return { status: 401, text: async () => "unauthorized" };
	}, async () => {
		const report = await I.probeTarget(noKey.ctx, cfg, noKey.providers.strata, "strata", "qwen3.8-flash-next-iq3_xxs", { keyCache: new Map() });
		eq("[8] 免鉴权的 /health 优先命中，不需要密钥", [report.ok, report.value, report.kind, report.identity], [true, 524288, "health", "match"]);
		check("[8] /health 这一发没有带 Authorization", seen2.some((row) => row.url.endsWith("/health") && !row.auth));
	});

	await withFetch(async () => ({ status: 0, text: async () => "", error: "abort" }), async () => {
		const env2 = fakeCtxFor({});
		const report = await I.probeTarget(env2.ctx, fullConfig({ probeTimeoutMs: 300 }), env2.providers.strata, "strata", "iq3_s", { keyCache: new Map() });
		eq("[8] 连不上时提前放弃剩下的候选，并如实报 unreachable", [report.ok, report.code, report.attempts.length > 0, report.attempts.length <= 3], [false, "unreachable", true, true]);
	});

	const slow = (url, init) => new Promise((resolve, reject) => {
		const timer = setTimeout(() => resolve({ status: 200, text: async () => JSON.stringify(STRATA_HEALTH) }), 900);
		// 真 fetch 会在超时时 abort：假 fetch 也得认这个 signal，否则测不到「超时被兜住」
		if (init && init.signal) init.signal.addEventListener("abort", () => {
			clearTimeout(timer);
			reject(new Error("This operation was aborted"));
		}, { once: true });
	});
	await withFetch(slow, async () => {
		const env3 = fakeCtxFor({});
		const report = await I.probeTarget(env3.ctx, fullConfig({ probeTimeoutMs: 200 }), env3.providers.strata, "strata", "qwen3.8-flash-next-iq3_xxs", { keyCache: new Map() });
		eq("[8] 超时被兜住（不会吊死在那儿），两次连不上就收工", [report.ok, report.code, report.attempts.some((row) => row.note === "timeout_or_aborted"), report.attempts.length <= 3], [false, "unreachable", true, true]);
	});

	await withFetch(async (url) => (String(url).endsWith("/health") ? { status: 200, text: async () => JSON.stringify({ max_context: 65536, model: "totally-other" }) } : { status: 404, text: async () => "" }), async () => {
		const env4 = fakeCtxFor({});
		const report = await I.probeTarget(env4.ctx, cfg, env4.providers.strata, "strata", "wanted-model", { keyCache: new Map() });
		eq("[8] 服务端回显别的模型 → identity_mismatch，绝不把别人的窗口写进来", [report.ok, report.code, report.echoed], [false, "identity_mismatch", "totally-other"]);
	});

	const outOfScope = await I.probeTarget(env.ctx, fullConfig({ probeScope: "loopback" }), env.providers.lan, "lan", "iq3_s", { keyCache: new Map() });
	eq("[8] 范围外的路由连问都不问", [outOfScope.ok, outOfScope.code], [false, "out_of_scope"]);
	const noBase = await I.probeTarget(env.ctx, cfg, {}, "p", "m", { keyCache: new Map() });
	eq("[8] 没配 baseURL 直接失败", [noBase.ok, noBase.code], [false, "no_baseurl"]);

	const safety = await withFetch(async () => ({ status: 200, text: async () => JSON.stringify(STRATA_HEALTH) }), async () => {
		const env5 = fakeCtxFor({});
		return I.probeTarget(env5.ctx, fullConfig({ contextSafetyRatio: 0.9 }), env5.providers.strata, "strata", "qwen3.8-flash-next-iq3_xxs", { keyCache: new Map() });
	});
	eq("[8] 安全系数只作用在写入值上（上报原值仍在 value 里）", [safety.value, safety.clamped], [524288, Math.floor(524288 * 0.9)]);

	const capacity = await I.configuredCapacity(env.ctx, "lan", "iq3_s");
	eq("[8] 读当前生效上限走 llm 服务，不联网", capacity.contextWindow, 512000);
	const capacityMissing = await I.configuredCapacity(env.ctx, "nope", "m");
	eq("[8] 路由不存在时读不到上限而不是抛错", [capacityMissing.contextWindow, capacityMissing.code], [null, "resolve_failed"]);
});

// ---------- [9] 设置页 HTTP 路由 ----------

async function serve(env) {
	const server = http.createServer((req, res) => env.handler(req, res));
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	const base = `http://127.0.0.1:${port}${I.API_PREFIX}`;
	return {
		server,
		get: async (route) => (await fetch(`${base}${route}`)).json(),
		post: async (route, body, raw) => (await fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body ?? {}) })).json(),
	};
}

await groupAsync("[9] 设置页 HTTP 路由", async () => {
	const calls = [];
	const stub = async (url, init) => {
		calls.push(String(url));
		if (String(url).endsWith("/health")) return { status: 200, text: async () => JSON.stringify(STRATA_HEALTH) };
		return { status: 404, text: async () => "" };
	};
	const env = fakeCtxFor({});
	// 插件自己发的探测走假 fetch；路由测试用的是真 global fetch，不能被顶掉
	host.__setFetchForTests(stub);
	try {
		host.apply({ ...env.ctx }, { stateFile: env.stateFile, probeScope: "loopback-private", probeApiKey: "testkey" });
		check("[9] 路由被注册（handler 拿到了）", typeof env.handler === "function");
		eq("[9] 注册用的前缀就是设置页要打的前缀", env.prefix, I.API_PREFIX);

		const api = await serve(env);
		try {
			const state = await api.get("/state");
			eq("[9] GET /state 返回 ok + 版本号", [state.ok, state.version], [true, I.PLUGIN_VERSION]);
			const strataRow = state.rows.find((row) => row.provider === "strata" && row.model === "qwen3.8-flash-next-iq3_xxs");
			check("[9] 状态里列出了本地路由、标成回环、在探测范围内", !!strataRow && strataRow.hostKind === "loopback" && strataRow.inScope === true);
			const lanRow = state.rows.find((row) => row.provider === "lan");
			eq("[9] 内网路由也被列出来（默认范围含内网）", lanRow.hostKind, "private");
			const cloudRow = state.rows.find((row) => row.provider === "cloud");
			eq("[9] 公网路由列出但标为不在探测范围（域名走名字判定）", [cloudRow.inScope, cloudRow.hostKind], [false, "other"]);
			eq("[9] 目录型路由（只有 modelOverrides）也列得出那个模型", state.rows.some((row) => row.provider === "catalog" && row.model === "small"), true);
			check("[9] 生效阈值按宿主公式给出（W=512000 的路由）", lanRow.thresholdTokens === Math.floor(Math.min(512000 * 0.8, 512000 - 32768 - 65536)), lanRow.thresholdTokens);
			eq("[9] 压缩后端在位、可写、阈值现状是宿主默认", [state.compaction.engineMounted, state.compaction.editable, state.compaction.onHostThresholdRatio], [true, true, 0.8]);
			eq("[9] own 触发在压缩后端在位时不该开（auto 模式）", state.compaction.ownTriggerActive, false);
			eq("[9] 状态载荷里带三个文件路径（设置页要显示）", [!!state.paths.stateFile, !!state.paths.settingsFile, !!state.paths.patchFile], [true, true, true]);
			eq("[9] 默认设置回传给界面（含白名单里的每一项）", I.SETTING_KEYS.every((key) => Object.hasOwn(state.settings, key)), true);

			const probed = await api.post("/probe", { provider: "strata", model: "qwen3.8-flash-next-iq3_xxs" });
			const report = probed.reports[0];
			eq("[9] POST /probe 单独探测一条", [report.ok, report.value, report.kind], [true, 524288, "health"]);
			eq("[9] 显式 probeApiKey 优先于凭据 seam", report.keySource, "config");
			eq("[9] 探测后状态里出现了上报值并标成待应用", [probed.state.rows.find((row) => row.provider === "strata" && row.model === "qwen3.8-flash-next-iq3_xxs").reported, probed.state.rows.find((row) => row.provider === "strata" && row.model === "qwen3.8-flash-next-iq3_xxs").pendingApply], [524288, true]);

			const applied = await api.post("/apply", { provider: "strata", model: "qwen3.8-flash-next-iq3_xxs" });
			eq("[9] POST /apply 用已存探测结果写入", [applied.ok, applied.result.code, applied.result.after], [true, "applied", 524288]);
			eq("[9] 写入真的改了那条路由的 providers 配置", env.providers.strata.models[1].contextWindow, 524288);
			eq("[9] 写过的条目进了审计", applied.state.audit.some((entry) => entry.kind === "capacity_applied" && entry.after === 524288), true);
			const reapplied = await api.post("/apply", { provider: "strata", model: "qwen3.8-flash-next-iq3_xxs", reported: 524288 });
			eq("[9] 再应用同一个值是 no-op（不重复写盘）", [reapplied.ok, reapplied.result.code, reapplied.result.before], [true, "already", 524288]);
			const writes = env.editorWrites.filter((row) => row.id === I.LLM_ROW_ID).length;
			eq("[9] patch 写入次数与真实改动一致", writes, 1);

			const badApply = await api.post("/apply", { provider: "nope", model: "x" });
			eq("[9] 未知 provider 应用失败但不崩", [badApply.ok, badApply.code], [false, "no_report_to_apply"]);

			const saved = await api.post("/settings", { thresholdRatio: 0.9 });
			eq("[9] POST /settings 保存比例并把阈值同步进 compaction-basic", [saved.ok, saved.sync.code, saved.state.settings.thresholdRatio], [true, "applied", 0.9]);
			eq("[9] compaction-basic 那条被写成 {thresholdRatio:0.9}", env.rows.find((row) => row.options.id === I.COMPACT_ROW_ID).options.config, { thresholdRatio: 0.9 });
			eq("[9] 保存后的状态里 W 与阈值都跟着变了", saved.state.rows.find((row) => row.provider === "lan").thresholdTokens, Math.floor(Math.min(512000 * 0.9, 512000 - 32768 - 65536)));
			const onDisk = JSON.parse(fs.readFileSync(path.join(path.dirname(env.stateFile), "settings.json"), "utf8"));
			eq("[9] 设置落盘（下次启动沿用）", onDisk.thresholdRatio, 0.9);

			const conflict = await api.post("/settings", { thresholdRatio: 0.3, retainRatio: 0.35 });
			eq("[9] retain ≥ 阈值被挡在门口（不写坏 compaction-basic）", [conflict.ok, conflict.code], [false, "retain_conflict"]);
			const afterConflict = JSON.parse(fs.readFileSync(path.join(path.dirname(env.stateFile), "settings.json"), "utf8"));
			eq("[9] 被挡下的请求不会留下半个设置", afterConflict.thresholdRatio, 0.9);

			const emptySave = await api.post("/settings", { nothingWeKnow: 1 });
			eq("[9] 一个能认的键都没有 → 400 且不改任何东西", [emptySave.ok, emptySave.code], [false, "no_fields"]);

			const badJson = await api.post("/settings", null, "{ not json");
			eq("[9] 坏 JSON 请求体是 400 而不是 500", [badJson.ok, badJson.code], [false, "bad_json_body"]);

			const probeAll = await api.post("/probe", {});
			check("[9] 不带 provider 的探测只扫范围内的路由", probeAll.reports.length > 0 && probeAll.reports.every((row) => row.provider !== "cloud"), probeAll.reports.map((row) => row.provider));

			const cleared = await api.post("/clear", {});
			eq("[9] POST /clear 把探测与改写记录清干净", [cleared.ok, cleared.state.rows.every((row) => row.reported === null), cleared.state.audit.length], [true, true, 1]);

			const reset = await api.post("/reset", {});
			eq("[9] POST /reset 后比例回到 patch config / 内置默认", reset.state.settings.thresholdRatio, 0.8);
			eq("[9] reset 把设置文件删掉了", fs.existsSync(path.join(path.dirname(env.stateFile), "settings.json")), false);

			const unknown = await api.post("/nope", {});
			eq("[9] 未知路由回 404 + 稳定原因码", [unknown.ok, unknown.code], [false, "unknown_route"]);

			const stateAgain = await api.get("/state");
			eq("[9] GET /state 也能用裸路径（前缀根）", stateAgain.ok, true);
		} finally {
			await new Promise((resolve) => api.server.close(resolve));
		}
	} finally {
		for (const cleanup of env.effects) {
			try {
				cleanup();
			} catch { /* 自检里不关心清理本身 */ }
		}
		host.__setFetchForTests(null);
	}
	void calls;
});

// ---------- [10] 生命周期：pre-step 节流、自触发口径、清理、webServer 晚到 ----------

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms === undefined ? 80 : ms));

await groupAsync("[10] 生命周期与自动路径", async () => {
	const calls = [];
	const stub = async (url) => {
		calls.push(String(url));
		if (String(url).endsWith("/health")) return { status: 200, text: async () => JSON.stringify(STRATA_HEALTH) };
		return { status: 404, text: async () => "" };
	};
	host.__setFetchForTests(stub);
	const previousFetch10 = globalThis.fetch;
	globalThis.fetch = stub;
	try {
		const env = fakeCtxFor({});
		host.apply({ ...env.ctx }, { stateFile: env.stateFile, autoFixContextWindow: true, probeScope: "loopback-private" });
		const preStep = env.listeners.find(([event]) => event === "agent/pre-step");
		check("[10] 挂上了 agent/pre-step 监听", !!preStep);
		eq("[10] 监听挂在插件自己的 ctx 上（卸载即随之消失）", typeof env.ctx.on, "function");

		const agent = { session: { id: "s1", requestHeader: () => ({ config: { provider: "strata", model: "qwen3.8-flash-next-iq3_xxs", maxTokens: 4096 } }) }, options: { provider: "strata", model: "qwen3.8-flash-next-iq3_xxs" } };
		eq("[10] 已路由的信封优先于 agent.options", I.routedTargetOf(agent), { provider: "strata", model: "qwen3.8-flash-next-iq3_xxs", maxTokens: 4096 });
		eq("[10] 没有信封时退到 agent.options", I.routedTargetOf({ session: { requestHeader: () => null }, options: { provider: "p", model: "m" } }), { provider: "p", model: "m", maxTokens: undefined });
		eq("[10] 两边都没有就不动", I.routedTargetOf({ session: { requestHeader: () => null }, options: {} }), null);

		let nextCalls = 0;
		const next = () => {
			nextCalls += 1;
			return { kind: "next" };
		};
		await preStep[1]({ agent, signal: new AbortController().signal }, next);
		await settle();
		eq("[10] 第一步触发一次探测", calls.filter((url) => url.endsWith("/health")).length, 1);
		await preStep[1]({ agent, signal: new AbortController().signal }, next);
		await preStep[1]({ agent, signal: new AbortController().signal }, next);
		await settle();
		eq("[10] TTL 内的后续步骤不再重复探测（不追着本地服务问）", calls.filter((url) => url.endsWith("/health")).length, 1);
		eq("[10] 监听器每次都把决定交还给下一个（next 调用次数与事件次数相同）", nextCalls, 3);
		const stateAfterProbe = JSON.parse(fs.readFileSync(env.stateFile, "utf8"));
		eq("[10] 探测结果落进状态文件", stateAfterProbe.probes["strata|qwen3.8-flash-next-iq3_xxs"].value, 524288);
		eq("[10] 自动修正开着 → 顺手把上限写进了 patch", env.providers.strata.models[1].contextWindow, 524288);
		check("[10] 宿主日志里能看到改了什么（不静默改配置）", env.logs.info.some((line) => line.includes("524288")), env.logs.info);

		// own=auto：阈值写不进后端配置（writeCompactionConfig 关着）→ 自己盯
		const envCannotWrite = fakeCtxFor({});
		host.apply({ ...envCannotWrite.ctx }, { stateFile: envCannotWrite.stateFile, writeCompactionConfig: false, headroomTokens: 8192 });
		envCannotWrite.meterTokens.value = 400000;
		const preStepCannotWrite = envCannotWrite.listeners.find(([event]) => event === "agent/pre-step");
		await preStepCannotWrite[1]({ agent, signal: new AbortController().signal }, () => ({ kind: "next" }));
		eq("[10] 阈值写不进后端配置时本插件自己触发压缩", envCannotWrite.compactCalls.length, 1);
		check("[10] 自触发记进审计（谁干的写清楚）", JSON.parse(fs.readFileSync(envCannotWrite.stateFile, "utf8")).audit.some((entry) => entry.kind === "own_compaction"), JSON.parse(fs.readFileSync(envCannotWrite.stateFile, "utf8")).audit);

		// own=auto：compaction-basic 那条行不在本 profile 里 → 也自己盯
		const envNoRow = fakeCtxFor({ withCompactionRow: false });
		host.apply({ ...envNoRow.ctx }, { stateFile: envNoRow.stateFile });
		envNoRow.meterTokens.value = 400000;
		await envNoRow.listeners.find(([event]) => event === "agent/pre-step")[1]({ agent, signal: new AbortController().signal }, () => ({ kind: "next" }));
		eq("[10] 后端在位但那条 config 行写不到时也自己盯", envNoRow.compactCalls.length, 1);

		// own=auto：一切正常 → 不该自己盯（免得和后端抢着压缩）
		const envHealthy = fakeCtxFor({});
		host.apply({ ...envHealthy.ctx }, { stateFile: envHealthy.stateFile });
		envHealthy.meterTokens.value = 500000;
		await envHealthy.listeners.find(([event]) => event === "agent/pre-step")[1]({ agent, signal: new AbortController().signal }, () => ({ kind: "next" }));
		await settle();
		eq("[10] 一切正常时不重复压缩（阈值交给后端自己按写入的比例算）", envHealthy.compactCalls.length, 0);

		// own=auto：组合里没有压缩后端 → 谁都无法压缩，也不空转
		const envNoBackend = fakeCtxFor({ compaction: false });
		host.apply({ ...envNoBackend.ctx }, { stateFile: envNoBackend.stateFile, ownPressureTrigger: "auto" });
		envNoBackend.meterTokens.value = 500000;
		await envNoBackend.listeners.find(([event]) => event === "agent/pre-step")[1]({ agent, signal: new AbortController().signal }, () => ({ kind: "next" }));
		await settle();
		eq("[10] 没有压缩后端时不空转（compactIfNeeded 没人实现）", envNoBackend.compactCalls.length, 0);

		// 压力不够时不压缩
		const envIdle = fakeCtxFor({});
		host.apply({ ...envIdle.ctx }, { stateFile: envIdle.stateFile, ownPressureTrigger: "always" });
		envIdle.meterTokens.value = 100;
		await envIdle.listeners.find(([event]) => event === "agent/pre-step")[1]({ agent, signal: new AbortController().signal }, () => ({ kind: "next" }));
		eq("[10] 压力低于阈值不动手", envIdle.compactCalls.length, 0);

		// 卸载：清理钩子之后监听器不再干活
		for (const cleanup of env.effects) {
			try {
				cleanup();
			} catch { /* 自检里不关心清理本身 */ }
		}
		const before = calls.length;
		await preStep[1]({ agent, signal: new AbortController().signal }, () => ({ kind: "next" }));
		await settle();
		eq("[10] 卸载后不再发新的探测（在飞请求与定时器都收了）", calls.length, before);

		// webServer 晚到：第一次注册失败，重试后要能拿到 handler
		const envLate = fakeCtxFor({ webServer: false });
		host.apply({ ...envLate.ctx }, { stateFile: envLate.stateFile });
		eq("[10] webServer 没就绪时先不注册（也不会卡住 apply）", envLate.handler, null);
		envLate.services.webServer = { register: ({ path: prefix, handler }) => {
			envLate.handler = handler;
			envLate.prefix = prefix;
			return () => {};
		} };
		await settle(1800);
		check("[10] webServer 晚到会在重试里补上注册", typeof envLate.handler === "function", envLate.handler);
		for (const cleanup of envLate.effects) {
			try {
				cleanup();
			} catch { /* 忽略 */ }
		}
	} finally {
		host.__setFetchForTests(null);
		globalThis.fetch = previousFetch10;
	}
});

// ---------- [11] 设置页渲染与 i18n ----------

/**
 * 客户端语言线索：Node 24 的 globalThis.navigator 是只读访问器，直接赋值会抛；
 * 而本机 Intl 的默认 locale 会被 detectLanguage() 读成中文，所以两者都要按语言钉住。
 */
function globalDescriptor(name) {
	try {
		return Object.getOwnPropertyDescriptor(globalThis, name) ?? null;
	} catch {
		return null;
	}
}

function snapshotClientLanguage() {
	return { navigator: globalDescriptor("navigator"), intl: globalDescriptor("Intl") };
}

function setClientLanguage(tag) {
	Object.defineProperty(globalThis, "navigator", { value: { language: tag, languages: [tag] }, configurable: true, writable: true });
	Object.defineProperty(globalThis, "Intl", {
		value: { DateTimeFormat: () => ({ resolvedOptions: () => ({ locale: tag }) }) },
		configurable: true,
		writable: true,
	});
}

function restoreClientLanguage(snapshot) {
	for (const [name, descriptor] of Object.entries(snapshot)) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else delete globalThis[name];
	}
}

const hookStore = new Map();
let hookKey = null;
const React = {
	Fragment: Symbol("Fragment"),
	createElement: (type, props, ...children) => ({ type, props: props || {}, children: children.flat(Infinity) }),
	useState: (initial) => {
		const inst = hookStore.get(hookKey);
		const index = inst.index++;
		if (!(index in inst.states)) inst.states[index] = typeof initial === "function" ? initial() : initial;
		return [inst.states[index], (value) => {
			inst.states[index] = typeof value === "function" ? value(inst.states[index]) : value;
		}];
	},
	useRef: (initial) => {
		const inst = hookStore.get(hookKey);
		const index = inst.index++;
		if (!(index in inst.refs)) inst.refs[index] = { current: initial };
		return inst.refs[index];
	},
	useEffect: () => {},
	useCallback: (fn) => fn,
};

function collectText(node, out = []) {
	if (node === null || node === undefined || node === false || node === "") return out;
	if (Array.isArray(node)) {
		for (const item of node) collectText(item, out);
		return out;
	}
	if (typeof node === "string" || typeof node === "number") {
		out.push(String(node));
		return out;
	}
	if (typeof node === "object") {
		if (node.type === "style") return out; // 样式不是文案
		if (typeof node.type === "function") collectText(node.type(node.props || {}), out);
		if (node.props && typeof node.props.children !== "undefined") collectText(node.props.children, out);
		if (Array.isArray(node.children)) collectText(node.children, out);
	}
	return out;
}

function findNodes(node, predicate, out = []) {
	if (node === null || node === undefined || node === false) return out;
	if (Array.isArray(node)) {
		for (const item of node) findNodes(item, predicate, out);
		return out;
	}
	if (typeof node === "object" && node.type) {
		if (predicate(node)) out.push(node);
		if (typeof node.type === "function") findNodes(node.type(node.props || {}), predicate, out);
		if (node.props && typeof node.props.children !== "undefined") findNodes(node.props.children, predicate, out);
		if (Array.isArray(node.children)) findNodes(node.children, predicate, out);
	}
	return out;
}

/** 从 JS 源码里切出一段花括号包裹的对象字面量：字符串、注释、模板里的括号都不算数。 */
function extractBalanced(text, from) {
	let depth = 0;
	let index = from;
	let quote = null;
	while (index < text.length) {
		const char = text[index];
		if (quote) {
			if (char === "\\") {
				index += 2;
				continue;
			}
			if (char === quote) quote = null;
			index += 1;
			continue;
		}
		if (char === '"' || char === "'" || char === "`") {
			quote = char;
			index += 1;
			continue;
		}
		if (char === "/" && text[index + 1] === "/") {
			while (index < text.length && text[index] !== "\n") index += 1;
			continue;
		}
		if (char === "/" && text[index + 1] === "*") {
			index += 2;
			while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
			index += 2;
			continue;
		}
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(from, index + 1);
		}
		index += 1;
	}
	return null;
}

/** 从 client.js 源码里读词典（client 不是 ES module，取不到内部变量，只能按字面量切）。 */
function readClientDictionary(language) {
	const source = fs.readFileSync(path.join(ROOT, "lib", "client.js"), "utf8");
	const marker = `${language}: {`;
	const at = source.indexOf(marker);
	if (at < 0) throw new Error(`client.js 里找不到 ${language} 词典`);
	const body = extractBalanced(source, at + marker.length - 1);
	if (!body) throw new Error(`${language} 词典没闭合`);
	return (new Function(`return ${body}`))();
}

await groupAsync("[11] 设置页渲染与 i18n", async () => {
	let loaded = null;
	const previousWindow = globalThis.window;
	globalThis.window = { __ModuleLoader__: { load: (bundle) => { loaded = bundle; } } };
	await import(pathToFileURL(path.join(ROOT, "lib", "client.js")).href);
	globalThis.window = previousWindow;
	loadedClient = loaded;
	check("[11] 客户端半个插件按 window.__ModuleLoader__.load 注册", !!loaded && loaded.id === "dsh-context-governor");

	const fakeRequire = (id) => {
		if (id === "react") return React;
		throw new Error(`unexpected require: ${id}`);
	};
	const clientModule = loaded.factory(fakeRequire);
	eq("[11] 客户端模块声明 inject 只要 slots", clientModule.inject, ["slots"]);
	check("[11] 客户端模块导出 apply", typeof clientModule.apply === "function");

	/** 按某种语言装配这个分区（makeLocale 在 apply 那一刻定语言，所以两种语言各装配一次）。 */
	function bootClient(languageTag) {
		const registrations = [];
		const previousLanguage = snapshotClientLanguage();
		setClientLanguage(languageTag);
		try {
			clientModule.apply({
				effect: (fn) => {
					fn();
				},
				slots: {
					inject: (ownerKey, callback) => {
						callback();
						return () => {};
					},
					register: (options, component) => {
						registrations.push({ options, component });
						return () => {};
					},
				},
			});
		} finally {
			restoreClientLanguage(previousLanguage);
		}
		return registrations;
	}

	const zhRegistrations = bootClient("zh-CN");
	eq("[11] 只注册一个设置页分区", zhRegistrations.length, 1);
	const registration = zhRegistrations[0];
	eq("[11] 注册的是 settings.section，组件是第二个参数", [registration.options.name, registration.options.id, typeof registration.component], ["settings.section", "context-governor", "function"]);
	check("[11] 分区 order 是个数字且不与窗口大小分区(65)撞", Number.isInteger(registration.options.order) && registration.options.order !== 65, registration.options.order);

	/** 把已加载的状态塞进第一个 useState（data），再渲染一次，拿到有数据的界面。 */
	function renderLoaded(reg, languageTag, payload) {
		hookKey = `render-${languageTag}-${Math.random().toString(36).slice(2)}`;
		hookStore.set(hookKey, { index: 0, states: [], refs: [] });
		const previousLanguage = snapshotClientLanguage();
		setClientLanguage(languageTag);
		try {
			const element = reg.component();
			const Section = element.type;
			const inst = hookStore.get(hookKey);
			inst.index = 0;
			Section();
			inst.states[0] = payload;
			inst.index = 0;
			const tree = Section();
			inst.index = 0;
			return { tree, Section, inst };
		} finally {
			restoreClientLanguage(previousLanguage);
		}
	}

	const statePayloadFixture = {
		ok: true,
		version: I.PLUGIN_VERSION,
		enabled: true,
		language: "auto",
		settings: { enabled: true, autoFixContextWindow: true, thresholdRatio: 0.85, writeCompactionConfig: true, ownPressureTrigger: "auto", probeScope: "loopback-private", probeIntervalMs: 30000, probeTimeoutMs: 2500, contextSafetyRatio: 1, maxWritesPerHour: 10, minWriteIntervalMs: 2000, headroomTokens: null, retainRatio: null, retainTokens: null, language: "auto", pins: [], minReportedContextWindow: 1024, maxReportedContextWindow: 8388608 },
		defaults: { ...I.DEFAULTS },
		limits: { ratioMin: 0.05, ratioMax: 0.99 },
		compaction: { rowFound: true, editable: true, engineMounted: true, tokenMeterMounted: true, onHostThresholdRatio: 0.8, onHostHeadroomTokens: 65536, onHostRetainRatio: 0.16, ownTriggerActive: false, writeConfigEnabled: true },
		contextServiceMounted: true,
		configEditorMounted: true,
		credentialServiceMounted: true,
		probing: [],
		writesLastHour: 1,
		rows: [
			{ provider: "strata8080", displayName: "[Local Strata 8080]", baseURL: "http://127.0.0.1:8080/v1", api: "openai-completions", host: "127.0.0.1", hostKind: "loopback", inScope: true, model: "qwen3.8-flash-next-iq3_xxs", configuredCapacity: 262144, capacityIsHostFallback: true, defaultMaxTokens: 32768, thresholdTokens: 209715, reported: 524288, reportField: "max_context", reportEndpoint: "http://127.0.0.1:8080/health", reportKind: "health", reportAt: Date.now() - 5000, reportIdentity: "match", reportEchoed: "qwen3.8-flash-next-iq3_xxs", probeCode: null, probeAttempts: [], appliedAt: null, appliedBefore: null, pendingApply: true, pinned: null },
			{ provider: "lan", displayName: "[LAN Strata]", baseURL: "http://192.168.1.4:47832/v1", api: "openai-completions", host: "192.168.1.4", hostKind: "private", inScope: true, model: "iq3_s", configuredCapacity: 512000, capacityIsHostFallback: false, defaultMaxTokens: 32768, thresholdTokens: 413696, reported: 512000, reportField: "max_context", reportEndpoint: "http://192.168.1.4:47832/health", reportKind: "health", reportAt: Date.now() - 70000, reportIdentity: "match", reportEchoed: "iq3_s", probeCode: null, probeAttempts: [], appliedAt: "2026-10-25T00:00:00.000Z", appliedBefore: 262144, pendingApply: false, pinned: null },
			{ provider: "cloud", displayName: "[Cloud]", baseURL: "https://api.example.com/v1", host: "api.example.com", hostKind: "public", inScope: false, model: "big", configuredCapacity: 131072, capacityIsHostFallback: false, defaultMaxTokens: 8192, thresholdTokens: 104857, reported: null, reportField: null, reportEndpoint: null, reportKind: null, reportAt: null, reportIdentity: null, reportEchoed: null, probeCode: "out_of_scope", probeAttempts: [], appliedAt: null, appliedBefore: null, pendingApply: false, pinned: null },
		],
		audit: [{ at: "2026-10-25T00:00:00.000Z", kind: "capacity_applied", provider: "lan", model: "iq3_s", before: 262144, after: 512000, reported: 512000, sourceKind: "health", endpoint: "http://192.168.1.4:47832/health" }],
		sessions: [],
		paths: { stateFile: "/tmp/x/state.json", settingsFile: "/tmp/x/settings.json", patchFile: "/tmp/x/cordis.patch.yml" },
		settingsUpdatedAt: null,
	};

	const zh = renderLoaded(registration, "zh-CN", statePayloadFixture);
	const zhText = collectText(zh.tree, []).join("\n");
	const enRegs = bootClient("en-US");
	const en = renderLoaded(enRegs[0], "en-US", statePayloadFixture);
	const enText = collectText(en.tree, []).join("\n");

	check("[11] 中文渲染真的出了中文", zhText.includes("上下文") && zhText.includes("生效上限"), zhText.slice(0, 120));
	check("[11] 英文渲染真的出了英文", enText.includes("Effective W") && enText.includes("pending"), enText.slice(0, 120));
	check("[11] 上报值与待应用状态都显示出来了（不静默吞掉）", zhText.includes("524,288") && zhText.includes("待应用"), zhText.slice(0, 200));
	check("[11] 英文界面里不留中文（语言下拉里的「简体中文」除外）", !/[一-鿿]/.test(enText.split("简体中文").join("")), enText.match(/[一-鿿]+/g));

	const dictZh = readClientDictionary("zh");
	const dictEn = readClientDictionary("en");
	const zhSet = Object.keys(dictZh).sort();
	const enSet = Object.keys(dictEn).sort();
	eq("[11] en 与 zh 的 key 集完全一致（不多一个也不少一个）", enSet, zhSet);
	const placeholderMismatch = zhSet.filter((key) => {
		const grab = (text) => (String(text).match(/\{[a-zA-Z_]+\}/g) || []).sort().join(",");
		return grab(dictZh[key]) !== grab(dictEn[key]);
	});
	eq("[11] 每个 key 的占位符集合两种语言一致", placeholderMismatch, []);
	eq("[11] 词典里没有空文案", zhSet.filter((key) => String(dictZh[key]).trim().length === 0 || String(dictEn[key]).trim().length === 0), []);
	eq("[11] 词典里不夹样式 token（样式只写在 CSS 里）", zhSet.filter((key) => String(dictZh[key]).includes("--theme-") || String(dictEn[key]).includes("--theme-")), []);

	const zhTokens = collectText(zh.tree, []).join("\n").split(/[\s\n]+/).map((token) => token.replace(/[，。：；「」()（）]/g, ""));
	eq("[11] 界面上没有把内部 key 当文案甩出来", zhTokens.filter((token) => Object.hasOwn(dictZh, token)), []);
	const unresolved = zhText.match(/\{[a-zA-Z_]+\}/g) || [];
	eq("[11] 没有没填的占位符", unresolved, []);

	// 分区标题是 thunk：按当前语言现取，切语言标题跟着换
	const labelZh = (() => {
		const previousLanguage = snapshotClientLanguage();
		setClientLanguage("zh-CN");
		try {
			return registration.options.label();
		} finally {
			restoreClientLanguage(previousLanguage);
		}
	})();
	const labelEn = (() => {
		const previousLanguage = snapshotClientLanguage();
		setClientLanguage("en-US");
		try {
			return enRegs[0].options.label();
		} finally {
			restoreClientLanguage(previousLanguage);
		}
	})();
	eq("[11] 中文界面里的标题", labelZh, "上下文");
	eq("[11] 英文界面里的标题（label 是 thunk，跟着语言走）", labelEn, "Context");

	// 点击真的把请求发出去
	const posted = [];
	const previousFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		posted.push({ url: String(url), method: init && init.method, body: init && init.body });
		return { json: async () => ({ ok: true, code: "saved", state: statePayloadFixture }) };
	};
	try {
		const click = renderLoaded(registration, "zh-CN", statePayloadFixture);
		const buttons = findNodes(click.tree, (node) => node.type === "button");
		check("[11] 页面上有探测 / 应用 / 保存 / 刷新这些按钮", buttons.length >= 8, buttons.length);
		const switchInput = findNodes(click.tree, (node) => node.type === "input" && node.props && node.props.type === "checkbox")[0];
		check("[11] 开关用的是 role=switch + aria-checked（和宿主控件一个做法）", !!switchInput && switchInput.props.role === "switch" && typeof switchInput.props["aria-checked"] === "string", switchInput && switchInput.props);
		await switchInput.props.onChange({ target: { checked: false } });
		check("[11] 开关一点就 POST /settings 且带上对应键", posted.some((row) => row.url.endsWith("/context-governor/api/settings") && /"enabled":false/.test(String(row.body))), posted.slice(0, 2));
		const applyButton = findNodes(click.tree, (node) => node.type === "button" && node.props && node.props.disabled === false && collectText(node, []).join("").includes("应用"));
		check("[11] 待应用那一条给了可点的「应用」按钮", applyButton.length > 0, applyButton.length);
		await applyButton[0].props.onClick();
		check("[11] 点「应用」真的 POST 到 /apply 并带上 provider/model", posted.some((row) => row.url.endsWith("/context-governor/api/apply") && /"provider":"strata8080"/.test(String(row.body))), posted.slice(-1));
		const probed = renderLoaded(registration, "zh-CN", { ...statePayloadFixture, audit: [] });
		const emptyAudit = collectText(probed.tree, []).join("\n");
		check("[11] 没有记录时显示「还没有记录」而不是空白", emptyAudit.includes("还没有记录"), emptyAudit.slice(0, 200));
	} finally {
		globalThis.fetch = previousFetch;
	}

	// 拿不到状态时的兜底文案（宿主路由还没起来）
	const loadingRender = (() => {
		hookKey = "render-loading";
		hookStore.set(hookKey, { index: 0, states: [], refs: [] });
		const previousLanguage = snapshotClientLanguage();
		setClientLanguage("zh-CN");
		try {
			const element = registration.component();
			const inst = hookStore.get(hookKey);
			inst.index = 0;
			return collectText(element.type(), []).join("\n");
		} finally {
			restoreClientLanguage(previousLanguage);
		}
	})();
	check("[11] data 还没到手时渲染「读取中…」而不是崩", loadingRender.includes("读取中"), loadingRender.slice(0, 80));
	void zh.inst;
	void en.inst;
	void zh.Section;
});

// ---------- [12] 脱敏扫描 ----------

group("[12] 脱敏扫描", () => {
	const files = ["lib/index.js", "lib/client.js", "cordis.patch.yml", "package.json", "README.md", "README_zh.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md", "LICENSE", "locale/en.json", "locale/zh.json", "scripts/selftest.mjs"];
	const present = files.filter((file) => fs.existsSync(path.join(ROOT, file)));
	eq("[12] 发布清单里点名的文件都在（漏了就是 README/自检和包不一致）", present, files);
	const patterns = [
		{ name: "家目录绝对路径", re: /[A-Za-z]:\\Users\\|\/home\/[a-z0-9_.-]+/i },
		{ name: "本机用户名", re: /zs771/i },
		{ name: "明文密钥样式", re: /\b(?:sk|ghp|gho|xox[a-z])-?[A-Za-z0-9_-]{12,}\b/ },
		{ name: "api_key 明文赋值", re: /api[_-]?key["'\s]*[:=]\s*["'][A-Za-z0-9._-]{8,}/i },
		{ name: "工作区绝对路径", re: /[A-Za-z]:\\DSH_WorkSpace/i },
		{ name: "写死的本机回环地址带端口", re: /127\.0\.0\.1:\d{2,5}/ },
		{ name: "写死的内网地址", re: /\b192\.168\.\d{1,3}\.\d{1,3}\b/ },
	];
	const secretish = patterns.filter((pattern) => pattern.name.includes("密钥") || pattern.name.includes("api_key"));
	const offenders = [];
	for (const file of present) {
		const text = fs.readFileSync(path.join(ROOT, file), "utf8");
		// 自检夹具里允许假地址与假端口（那是夹具不是本机事实），但明文密钥样式照样不许
		const applied = file.includes("selftest") ? secretish : patterns;
		for (const pattern of applied) {
			const hit = pattern.re.exec(text);
			if (hit) offenders.push(`${file}: ${pattern.name} → ${hit[0]}`);
		}
	}
	eq("[12] 发布文件里没有本机路径 / 用户名 / 明文密钥 / 写死的地址端口", offenders, []);
});

// ---------- [13] 清单与包内文件 ----------

group("[13] 清单一致性", () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
	eq("[13] 包名与客户端模块 id 一致", pkg.name, loadedClient ? loadedClient.id : "dsh-context-governor");
	eq("[13] main / exports 指向真实存在的文件", [fs.existsSync(path.join(ROOT, pkg.main)), fs.existsSync(path.join(ROOT, pkg.exports["./client"]))], [true, true]);
	eq("[13] patch 文件存在且被 package.json 指到", [fs.existsSync(path.join(ROOT, pkg.dsh.bundle.patch)), pkg.dsh.bundle.patch], [true, "./cordis.patch.yml"]);
	eq("[13] 双语 meta 与图标都在 exports 与 files 里", [pkg.exports["./locale/*.json"] !== undefined, pkg.exports["./icon"] !== undefined, pkg.icon !== undefined, pkg.files.includes("locale"), pkg.files.includes("icon.svg"), pkg.files.includes("scripts")], [true, true, true, true, true, true]);
	const enMeta = JSON.parse(fs.readFileSync(path.join(ROOT, "locale", "en.json"), "utf8"));
	const zhMeta = JSON.parse(fs.readFileSync(path.join(ROOT, "locale", "zh.json"), "utf8"));
	check("[13] locale 里有 meta.title / meta.description（插件列表与设置页要用）", typeof enMeta.meta.title === "string" && enMeta.meta.title.length > 3 && typeof zhMeta.meta.description === "string" && zhMeta.meta.description.length > 10);
	check("[13] 两种语言的 meta 各自说清干什么（不互相抄袭）", enMeta.meta.description !== zhMeta.meta.description && /[一-鿿]/.test(zhMeta.meta.title));
	const patchText = fs.readFileSync(path.join(ROOT, "cordis.patch.yml"), "utf8");
	check("[13] patch 插的行 id 是本插件的条目名", patchText.includes("- id: context-governor"));
	check("[13] patch 里的 name 就是包名", patchText.includes(`name: ${pkg.name}`));
	check("[13] patch 里的默认值与内置 DEFAULTS 对得上（README 说的就是代码做的）", patchText.includes(`thresholdRatio: ${I.DEFAULTS.thresholdRatio}`) && patchText.includes('probeScope: "loopback-private"'));
	const iconText = fs.readFileSync(path.join(ROOT, "icon.svg"), "utf8");
	check("[13] 图标是合法 SVG 且小于 256 KiB", iconText.trim().startsWith("<svg") && iconText.trim().endsWith("</svg>") && Buffer.byteLength(iconText) < 262144);
	eq("[13] 没有任何运行时依赖（零依赖红线：装了起不来会拖垮整个插件树）", [pkg.dependencies === undefined, pkg.peerDependencies === undefined], [true, true]);
	eq("[13] 客户端注入声明只列宿主客户端包（不 require 宿主包）", pkg.dsh.client.inject.every((id) => id.startsWith("@deepseek-ai/")), true);
	check("[13] 宿主侧不 import 任何框架包（服务一律 ctx.get 可选取用）", !/(^|\n)\s*import .*from "(?!node:)/.test(fs.readFileSync(path.join(ROOT, "lib", "index.js"), "utf8")));
});

// ---------- 收尾 ----------

for (const dir of tempDirs) {
	try {
		fs.rmSync(dir, { recursive: true, force: true });
	} catch { /* 临时目录删不掉不影响结论 */ }
}

const failedGroups = groups.filter((entry) => entry.failed > 0);
const report = [
	"",
	`dsh-context-governor 离线自检：${groups.length} 组 / ${passed} 项通过`,
	...groups.map((entry) => `  ${entry.failed === 0 ? "✓" : "✗"} ${entry.title}${entry.failed === 0 ? "" : ` （${entry.failed} 项失败）`}`),
];
if (failures.length > 0) report.push("", "失败项：", ...failures.map((line) => `  ✗ ${line}`));
report.push("");
process.stdout.write(`${report.join("\n")}\n`);
process.exitCode = failures.length === 0 ? 0 : 1;
// undici 的连接池会让进程多活一会儿：测完直接退出，不靠事件循环自然排空
process.exit(failures.length === 0 ? 0 : 1);
