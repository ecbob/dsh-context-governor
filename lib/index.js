// dsh-context-governor —— 本地模型上下文上限自动校正 + 自动压缩阈值托管（host 侧，零外部依赖）
//
// 背景：DSH 的「这个模型有多大上下文」（contextWindow）由 @deepseek-ai/dsh-llm-pi-ai 的路由配置声明。
// 本地模型（Strata / llama.cpp llama-server / vLLM / Olloma 这类 OpenAI 兼容端点）常常不在 profile patch 里
// 写 contextWindow，于是落到路由的 `defaultContextWindow`（宿主默认 262144）；而 @deepseek-ai/dsh-compaction-basic
// 的自动压缩阈值就是按这个 W 算的（floor(min(W×ratio, W−O−headroomTokens))）。W 报小了，会话明明还有空间
// 却早早压缩；W 报大了，请求直接撞服务端的上下文墙。服务端其实知道自己能开多大（Strata 的 GET /health
// 直接回 `max_context`；llama.cpp 的 /props 回 `default_generation_settings.n_ctx`；vLLM 的 /server_info
// 回 `max_model_len`；Ollama 的 POST /api/show 回 `context_length`），本插件就是把这一个数问出来、核对身份、
// 再写回 profile patch 的那条路由配置里。
//
// 两件事：
//   1. 修正上限：按 provider 的 baseURL 依次问候选端点，取到上报值 → 与当前生效上限比较 →
//      不一致就经 `ctx.configEditor.edit()` 把 providers.<provider>.models[].contextWindow 写成上报值
//      （没有该 model 条目就追加一条；该路由没有 `models` 列表则退到 `modelOverrides`）。
//      llm-pi-ai 的 `providers` 是 volatile 配置，落盘即热生效，下一个请求就按新 W 走，不必重启 DSH。
//      写之前做身份核对：服务端回了另一个模型的名字就和本次不匹配，不写。
//   2. 托管阈值：把 `thresholdRatio`（默认 0.8，可在设置页改）写进 compaction-basic 那条的 config，
//      于是「到窗口的 0.8 自动压缩」由本插件设定；顺带可选覆盖 headroomTokens / retainRatio / retainTokens
//      （不设就不动宿主默认 65536 / 0.16）。压缩阈值写不进后端配置时（writeCompactionConfig 关掉，
//      或那条 config 行不归本 profile 写），ownPressureTrigger: "auto" 会让本插件自己在 agent/pre-step
//      上按同一套阈值口径调用 ctx.compaction.compactIfNeeded()，用户的比例照样生效。
//
// 设置页（「设置 → 上下文」分区，客户端半个插件 lib/client.js）通过本文件注册的 HTTP 路由读写：
//   GET  /state            生效设置 + 每条本地路由的「上报值 / 当前生效上限 / 是否待应用」+ 压缩侧现状 + 审计
//   POST /settings         { thresholdRatio, autoFixContextWindow, ... } → 落盘 settings.json + 立刻同步阈值配置
//   POST /probe            { provider?, model?, apply? } → 立即探测（不给 provider 就扫所有在范围内的本地路由）
//   POST /apply            { provider, model, reported? } → 立即把这一条写进 patch
//   POST /reset            设置文件回到 patch config / 内置默认
//   POST /clear            清空探测与改写记录
// 优先级：settings.json（设置页）> cordis.patch.yml 的 config > 插件内置默认值；**改完立刻生效**，不重启宿主。
//
// 零依赖红线：只用 node 内置模块（fs/os/path），不声明任何运行时依赖，也不往包里放二进制。
// profile 装打包产物时声明了的依赖就得在安装那一刻从 registry 解析；用 pnpm link: 链接本目录时 pnpm
// 根本不会去装被链接包自己的依赖 —— 任一运行时依赖解析失败会让 Cordis 插件树整体抛错、DSH 起不来。
// 宿主侧同理：所有框架服务（configEditor / llm / tokenMeter / compaction / credentials / webServer）
// 一律 `ctx.get(...)` 可选取用 + typeof 检查，缺谁就少干什么活，绝不因为拿不到服务而炸。
//
// 状态文件：~/.dsh/storages/context-governor/state.json
//   { "version": 1, "applied": { "<provider>|<model>": {…} }, "probes": {…}, "audit": […], "writes": [ts…] }
// 设置文件：~/.dsh/storages/context-governor/settings.json（设置页写入，原子写，保留未知键）
//   { "version": 1, "thresholdRatio": 0.85, "autoFixContextWindow": true, "updatedAt": "…" }
// 两者都只用同步 fs + 临时文件 rename，绝不写 DSH 的会话日志、也不往会话里注入任何模型可见内容。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const name = "context-governor";
export const inject = [];

const PLUGIN_VERSION = "0.1.0";

/** llm-pi-ai 路由条目在 profile 里的 id / 包名（本插件改的就是这一行的 config.providers）。 */
const LLM_ROW_ID = "llm-pi-ai";
const LLM_ROW_NAME = "@deepseek-ai/dsh-llm-pi-ai";
/** compaction-basic 条目在 profile 里的 id / 包名（本插件改的是它的 thresholdRatio 等）。 */
const COMPACT_ROW_ID = "compaction-basic";
const COMPACT_ROW_NAME = "@deepseek-ai/dsh-compaction-basic";
const API_PREFIX = "/context-governor/api";

/** 宿主 compaction-basic 的内置默认（和它 resolveConfig 里的常量一致，本插件只在展示时引用）。 */
const HOST_DEFAULTS = Object.freeze({
	thresholdRatio: 0.8,
	headroomTokens: 65536,
	retainRatio: 0.16,
	maxTokens: 65536,
	compactionRetries: 1,
	maxOverflowRetries: 1,
	auto: true,
});
/** llm-pi-ai 未声明模型的容量回退（宿主默认），用来判断「这个 W 其实是兜底值」。 */
const HOST_DEFAULT_CONTEXT_WINDOW = 262144;

const RATIO_MIN = 0.05;
const RATIO_MAX = 0.99;

const DEFAULTS = Object.freeze({
	/** 总开关；false 时不探测、不改写、不触发压缩（设置页路由仍注册，能看到状态）。 */
	enabled: true,
	/** 探测到上报值与生效上限不一致时，是否直接写 patch 并热生效；false = 只标记「待应用」。 */
	autoFixContextWindow: true,
	/** 自动压缩阈值比例：到 W×该比例即压缩。可被 settings.json 覆盖。 */
	thresholdRatio: HOST_DEFAULTS.thresholdRatio,
	/** 是否把 thresholdRatio 等写进 compaction-basic 的 patch 配置。 */
	writeCompactionConfig: true,
	/** 本插件自己触发压缩："auto"（默认）= 压缩后端在位但阈值写不进它配置时才自己盯；"always" = 总是；"never" = 从不。 */
	ownPressureTrigger: "auto",
	/** 哪些端点算「本地模型」："loopback-private"（默认）/ "loopback" / "any"。 */
	probeScope: "loopback-private",
	/** 同一 provider+model 两次探测的最小间隔（毫秒）。 */
	probeIntervalMs: 30000,
	/** 单次 HTTP 探测超时（毫秒）。 */
	probeTimeoutMs: 2500,
	/** 探测用的密钥；空 = 按该 provider 配置里的 apiKeyEnv 经凭据 seam 解析，再退到同名环境变量。 */
	probeApiKey: "",
	/** 写进去的上限 = 上报值 × 该比例（0.5–1，默认 1 = 照抄上报值）。 */
	contextSafetyRatio: 1,
	/** 上报值可信区间：区间外一律当不可信，不写。 */
	minReportedContextWindow: 1024,
	maxReportedContextWindow: 8388608,
	/** 防抖：一小时内最多写几次 patch、两次写入的最小间隔。 */
	maxWritesPerHour: 10,
	minWriteIntervalMs: 2000,
	/** 手工钉死：命中 { provider, model } 的条目永不覆盖（contextWindow 仅作显示）。 */
	pins: [],
	/** headroomTokens / retainRatio / retainTokens：null = 不动宿主默认。 */
	headroomTokens: null,
	retainRatio: null,
	retainTokens: null,
	/** 状态文件路径；空串 = ~/.dsh/storages/context-governor/state.json（设置文件在同目录）。 */
	stateFile: "",
	/** 设置页文案语言："auto" 跟随 DSH 当前语言；"zh" / "en" 钉死。 */
	language: "auto",
});

/** 设置页能改的键（probeApiKey 故意不在内：别把密钥落进 storages 目录的明文文件）。 */
const SETTING_KEYS = Object.freeze([
	"enabled",
	"autoFixContextWindow",
	"thresholdRatio",
	"writeCompactionConfig",
	"ownPressureTrigger",
	"probeScope",
	"probeIntervalMs",
	"probeTimeoutMs",
	"contextSafetyRatio",
	"maxWritesPerHour",
	"minWriteIntervalMs",
	"headroomTokens",
	"retainRatio",
	"retainTokens",
	"language",
]);

const OWN_MODES = Object.freeze(["auto", "always", "never"]);
const SCOPES = Object.freeze(["loopback", "loopback-private", "any"]);

/** 抛在 configEditor 的 change 回调里：算完发现没变化，别写盘。 */
class SkipWriteError extends Error {
	constructor(message) {
		super(message ?? "no change");
		this.name = "SkipWriteError";
		this.code = "noop";
	}
}

/** 取个值：框架那边什么都可能抛（服务没挂、会话已关、getter 炸），一律当「没有」处理。 */
function safeCall(fn) {
	try {
		return fn();
	} catch {
		return null;
	}
}

/** 这一步会用哪个 provider/model：优先 durable 的已路由信封，再退 agent.options（与 compaction-basic 同口径）。 */
function routedTargetOf(agent) {
	const header = typeof agent?.session?.requestHeader === "function" ? safeCall(() => agent.session.requestHeader()) : null;
	const fromHeader = header && header.config ? header.config : null;
	if (fromHeader && typeof fromHeader.provider === "string" && fromHeader.provider && typeof fromHeader.model === "string" && fromHeader.model) {
		return { provider: fromHeader.provider, model: fromHeader.model, maxTokens: fromHeader.maxTokens };
	}
	const options = agent && agent.options ? agent.options : null;
	if (options && typeof options.provider === "string" && options.provider && typeof options.model === "string" && options.model) {
		return { provider: options.provider, model: options.model, maxTokens: options.maxTokens };
	}
	return null;
}

function msgOf(err) {
	if (err instanceof Error) return err.message;
	try {
		return String(err);
	} catch {
		return "unknown error";
	}
}

function nowIso() {
	return new Date().toISOString();
}

// ---------- 配置归一 ----------

function asFiniteNumber(raw) {
	if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") return null;
	const n = Number(raw);
	return Number.isFinite(n) ? n : null;
}

/** 比例类字段：只认 [min,max] 内的数，其余退回 def。 */
function clampRatio(raw, def, min = RATIO_MIN, max = RATIO_MAX) {
	const n = asFiniteNumber(raw);
	if (n === null) return def;
	return Math.min(max, Math.max(min, n));
}

/** 正整数字段：只认 [min,max] 内的整数，其余退回 def。 */
function clampInt(raw, def, min, max) {
	const n = asFiniteNumber(raw);
	if (n === null) return def;
	const i = Math.floor(n);
	if (!Number.isSafeInteger(i) || i < min || i > max) return def;
	return i;
}

/** 可空整数字段（null / 空 = 不动宿主默认）；非法值也当 null。 */
function optionalInt(raw, min = 0, max = 16777216) {
	if (raw === null || raw === undefined || raw === "") return null;
	const n = asFiniteNumber(raw);
	if (n === null) return null;
	const i = Math.floor(n);
	if (!Number.isSafeInteger(i) || i < min || i > max) return null;
	return i;
}

function asBool(raw, def) {
	if (typeof raw === "boolean") return raw;
	if (raw === "true") return true;
	if (raw === "false") return false;
	return def;
}

function asEnum(raw, def, allowed) {
	const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
	return allowed.includes(v) ? v : def;
}

function normalizePins(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const provider = typeof item.provider === "string" ? item.provider.trim() : "";
		const model = typeof item.model === "string" ? item.model.trim() : "";
		const value = optionalInt(item.contextWindow, 1);
		if (!provider || !model || value === null) continue;
		const key = `${provider}|${model}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ provider, model, contextWindow: value });
	}
	return out;
}

/** 把任意来源（patch config / settings.json / 设置页请求体）夹成一份可用的部分配置；不认识与非法的一律丢掉。 */
function sanitizeSettingsInput(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const out = {};
	if (Object.hasOwn(src, "enabled")) out.enabled = asBool(src.enabled, DEFAULTS.enabled);
	if (Object.hasOwn(src, "autoFixContextWindow")) out.autoFixContextWindow = asBool(src.autoFixContextWindow, DEFAULTS.autoFixContextWindow);
	if (Object.hasOwn(src, "writeCompactionConfig")) out.writeCompactionConfig = asBool(src.writeCompactionConfig, DEFAULTS.writeCompactionConfig);
	if (Object.hasOwn(src, "thresholdRatio") && asFiniteNumber(src.thresholdRatio) !== null) out.thresholdRatio = clampRatio(src.thresholdRatio);
	if (Object.hasOwn(src, "contextSafetyRatio") && asFiniteNumber(src.contextSafetyRatio) !== null) out.contextSafetyRatio = clampRatio(src.contextSafetyRatio, 1, 0.5, 1);
	if (Object.hasOwn(src, "ownPressureTrigger")) {
		const v = asEnum(src.ownPressureTrigger, OWN_MODES[0], OWN_MODES);
		out.ownPressureTrigger = v;
	}
	if (Object.hasOwn(src, "probeScope")) {
		const v = asEnum(src.probeScope, SCOPES[0], SCOPES);
		out.probeScope = v;
	}
	if (Object.hasOwn(src, "probeIntervalMs")) out.probeIntervalMs = clampInt(src.probeIntervalMs, DEFAULTS.probeIntervalMs, 1000, 86400000);
	if (Object.hasOwn(src, "probeTimeoutMs")) out.probeTimeoutMs = clampInt(src.probeTimeoutMs, DEFAULTS.probeTimeoutMs, 200, 60000);
	if (Object.hasOwn(src, "maxWritesPerHour")) out.maxWritesPerHour = clampInt(src.maxWritesPerHour, DEFAULTS.maxWritesPerHour, 0, 1000);
	if (Object.hasOwn(src, "minWriteIntervalMs")) out.minWriteIntervalMs = clampInt(src.minWriteIntervalMs, DEFAULTS.minWriteIntervalMs, 0, 3600000);
	for (const key of ["headroomTokens", "retainTokens"]) {
		if (Object.hasOwn(src, key)) out[key] = optionalInt(src[key], 0, key === "retainTokens" ? 16777216 : 16777216);
	}
	if (Object.hasOwn(src, "retainRatio")) {
		out.retainRatio = asFiniteNumber(src.retainRatio) === null ? null : clampRatio(src.retainRatio, HOST_DEFAULTS.retainRatio, 0.01, 0.95);
	}
	if (Object.hasOwn(src, "language")) out.language = normalizeLanguageChoice(src.language);
	// patch-only 的键也从这里过一遍，方便 /settings 直接带上（不会带未知键：下面的 applySettings 只取白名单）。
	if (Object.hasOwn(src, "probeApiKey")) out.probeApiKey = typeof src.probeApiKey === "string" ? src.probeApiKey.trim() : DEFAULTS.probeApiKey;
	if (Object.hasOwn(src, "minReportedContextWindow")) out.minReportedContextWindow = clampInt(src.minReportedContextWindow, DEFAULTS.minReportedContextWindow, 128, 16777216);
	if (Object.hasOwn(src, "maxReportedContextWindow")) out.maxReportedContextWindow = clampInt(src.maxReportedContextWindow, DEFAULTS.maxReportedContextWindow, 1024, 268435456);
	if (Object.hasOwn(src, "pins")) out.pins = normalizePins(src.pins);
	if (Object.hasOwn(src, "stateFile")) out.stateFile = typeof src.stateFile === "string" ? src.stateFile.trim() : DEFAULTS.stateFile;
	return out;
}

/** 完整生效配置：内置默认 ← patch config ← settings.json。 */
function resolveConfig(patchConfig, settings) {
	const cfg = {
		...DEFAULTS,
		...sanitizeSettingsInput(patchConfig),
	};
	const fromSettings = settings && typeof settings === "object" ? sanitizeSettingsInput(settings) : {};
	const effective = { ...cfg };
	for (const key of SETTING_KEYS) {
		if (Object.hasOwn(fromSettings, key)) effective[key] = fromSettings[key];
	}
	// retainRatio 与 retainTokens 互斥：两个都给了就按 retainTokens（和宿主的拒绝顺序一致，别写出会被拒的配置）。
	if (effective.retainRatio !== null && effective.retainTokens !== null) effective.retainRatio = null;
	effective.pins = Array.isArray(cfg.pins) ? cfg.pins : [];
	if (effective.minReportedContextWindow > effective.maxReportedContextWindow) {
		effective.maxReportedContextWindow = effective.minReportedContextWindow;
	}
	// 上报可信区间必须容得下宿主默认兜底，否则连 262144 这种值都会被当噪声扔掉
	const reportedMax = Math.max(effective.maxReportedContextWindow, HOST_DEFAULT_CONTEXT_WINDOW);
	effective.maxReportedContextWindow = reportedMax;
	return effective;
}

function normalizeLanguageChoice(value) {
	const v = typeof value === "string" ? value.trim().toLowerCase() : "";
	if (v === "zh" || v === "en") return v;
	return "auto";
}

// ---------- 本地端点判定 ----------

/** 从 baseURL 里取出 host / origin / API 根；非 http(s) 或解析不了返回 null。 */
function endpointInfo(rawBaseUrl) {
	if (typeof rawBaseUrl !== "string" || rawBaseUrl.trim().length === 0) return null;
	let url;
	try {
		url = new URL(rawBaseUrl.trim());
	} catch {
		return null;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return null;
	const host = String(url.hostname || "").toLowerCase();
	if (host.length === 0) return null;
	const pathname = String(url.pathname || "");
	const origin = `${url.protocol}//${url.host}`;
	return { host, origin, apiRoot: origin + pathname.replace(/\/+$/, "") };
}

function stripIpv6Brackets(host) {
	let h = host;
	if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
	const zone = h.indexOf("%");
	if (zone > 0) h = h.slice(0, zone);
	return h;
}

function ipv4Kind(host) {
	const parts = host.split(".");
	if (parts.length !== 4) return null;
	const octets = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
	if (octets.some((o) => o < 0 || o > 255)) return null;
	const [a, b] = octets;
	if (a === 127) return "loopback";
	if (a === 10) return "private";
	if (a === 172 && b >= 16 && b <= 31) return "private";
	if (a === 192 && b === 168) return "private";
	if (a === 169 && b === 254) return "private"; // 链路本地
	if (a === 100 && b >= 64 && b <= 127) return "private"; // CGNAT 100.64/10
	if (a === 0) return "loopback"; // 0.0.0.0/8 本机可达
	return "public";
}

function ipv6Kind(host) {
	const h = stripIpv6Brackets(host).toLowerCase();
	if (!h.includes(":")) return null;
	if (!/^[0-9a-f:.]+$/.test(h)) return null;
	if (h === "::1" || h === "0:0:0:0:0:0:0:1") return "loopback";
	// 内嵌 IPv4 写法：::ffff:127.0.0.1、::127.0.0.1、0:0:0:0:0:ffff:10.0.0.1
	const dotted = /((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/.exec(h);
	if (dotted) {
		const prefix = h.slice(0, h.length - dotted[1].length);
		// 只有 v4 映射/兼容前缀才按 IPv4 分类，其余带点的写法当公网（形状可疑，不值得冒险）
		if (prefix === "::ffff:" || prefix === "::" || prefix.endsWith(":ffff:")) return ipv4Kind(dotted[1]);
		return "public";
	}
	const firstGroup = /([0-9a-f]{1,4})/.exec(h);
	if (firstGroup) {
		const head = parseInt(firstGroup[1], 16);
		if ((head & 0xfe80) === 0xfe80) return "private"; // 链路本地 fe80::/10
		if ((head & 0xfc00) === 0xfc00) return "private"; // 唯一本地 fc00::/7
	}
	return "public";
}

/** host 属于哪一类：loopback / private / public / name-local / other。 */
function hostKind(rawHost) {
	const host = typeof rawHost === "string" ? rawHost.trim().toLowerCase() : "";
	if (!host) return "other";
	const v4 = ipv4Kind(host);
	if (v4) return v4;
	const v6 = ipv6Kind(host);
	if (v6) return v6;
	if (host === "localhost" || host.endsWith(".localhost")) return "loopback";
	if (host.endsWith(".local") || host.endsWith(".internal")) return "name-local";
	return "other";
}

/** 「本地模型」的口径：loopback 恒真；loopback-private 另算内网与 .local；any 全放行。 */
function hostInScope(rawHost, scope) {
	if (scope === "any") return true;
	const kind = hostKind(rawHost);
	if (kind === "loopback") return true;
	if (scope === "loopback-private" && (kind === "private" || kind === "name-local")) return true;
	return false;
}

// ---------- 候选端点与上报值解析 ----------

/** 一个端点的候选请求（kind 决定用哪个解析器；auth 只表示「带上 key 更可能成功」）。 */
function endpointCandidates(rawBaseUrl, model) {
	const info = endpointInfo(rawBaseUrl);
	if (!info) return [];
	const out = [];
	const roots = new Set([info.apiRoot]);
	if (!/\/v\d+([^/]*)$/.test(info.apiRoot)) roots.add(`${info.apiRoot}/v1`);
	const push = (kind, url, method, body, auth) => {
		if (!url) return;
		if (out.some((row) => row.url === url && row.method === method)) return;
		out.push({ kind, url, method, body: body ?? null, auth: !!auth });
	};
	// 1) 服务健康页：多数本地服务在这里回 max_context，而且不要 key（Strata 实测如此）
	push("health", `${info.origin}/health`, "GET", null, false);
	// 2) OpenAI 兼容模型列表：按 id 找这一条，读容量字段（多数需要 key）
	for (const root of roots) push("models", `${root}/models`, "GET", null, true);
	// 3) llama.cpp llama-server /props、vLLM /server_info、TGI /info
	push("props", `${info.origin}/props`, "GET", null, true);
	push("server_info", `${info.origin}/server_info`, "GET", null, true);
	push("tgi_info", `${info.origin}/info`, "GET", null, false);
	// 4) Ollama：POST /api/show 的 context_length（verbose 才带 parameters）
	push("ollama_show", `${info.origin}/api/show`, "POST", { name: model, verbose: true }, false);
	return out;
}

/** 容量字段名按可信度排序（都小写比对）。 */
const CONTEXT_KEY_PRIORITY = Object.freeze([
	"max_context",
	"maxcontext",
	"contextwindow",
	"context_window",
	"context_length",
	"contextlength",
	"max_total_tokens",
	"max_model_len",
	"n_ctx",
	"num_ctx",
	"max_context_window",
	"n_positions",
	"max_input_tokens",
	"limit_context",
]);

const CONTEXT_KEYS = new Set(CONTEXT_KEY_PRIORITY);
const DOTTED_CONTEXT_KEYS = new Set(["general.context_length", "general.n_ctx", "llm.context_length"]);
const OLLAMA_PARAM_RE = /\b(num_ctx|n_ctx|max_context_window)\b[^\d]{0,12}(\d+)/i;

const IDENTITY_KEYS = Object.freeze(["model", "model_alias", "loaded_model", "model_name", "name", "id", "alias"]);

function identityOf(container) {
	if (!container || typeof container !== "object") return "";
	for (const key of IDENTITY_KEYS) {
		const value = container[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return "";
}

/** 把 report 的 id 归一（去 :latest、去组织前缀、小写），用来和服务端回显的名字比。 */
function normalizeModelId(value) {
	let v = String(value ?? "").trim().toLowerCase();
	if (!v) return "";
	v = v.replace(/:latest(only)?$/i, "");
	const slash = v.lastIndexOf("/");
	if (slash >= 0) v = v.slice(slash + 1);
	return v;
}

/** match = 服务端点明了同一个模型；unverified = 服务端没回显身份；mismatch = 明确是另一个模型。 */
function identityVerdict(echoed, requested) {
	if (!echoed) return "unverified";
	const a = normalizeModelId(echoed);
	const b = normalizeModelId(requested);
	if (!a || !b) return "unverified";
	if (a === b) return "match";
	if (a.includes(b) || b.includes(a)) return "match";
	return "mismatch";
}

function plausibleCapacity(value, min, max) {
	const n = typeof value === "string" ? Number(value) : value;
	if (typeof n !== "number" || !Number.isFinite(n)) return null;
	const i = Math.floor(n);
	if (!Number.isSafeInteger(i) || i < min || i > max) return null;
	return i;
}

function collectCapacities(node, pathPrefix, depth, found, limits, budget) {
	if (budget.left <= 0 || depth > limits.maxDepth) return budget.left;
	if (Array.isArray(node)) {
		for (const item of node.slice(0, 64)) {
			collectCapacities(item, pathPrefix, depth + 1, found, limits, budget);
			if (budget.left <= 0) return budget.left;
		}
		return budget.left;
	}
	if (!node || typeof node !== "object") return budget.left;
	for (const [key, value] of Object.entries(node)) {
		if (budget.left <= 0) return budget.left;
		const lowerKey = String(key).toLowerCase();
		const here = pathPrefix ? `${pathPrefix}.${key}` : String(key);
		const push = (name, raw) => {
			const capacity = plausibleCapacity(raw, limits.min, limits.max);
			if (capacity === null) return;
			budget.left -= 1;
			found.push({ name, key: here, value: capacity, depth, identity: identityOf(node) });
		};
		if (CONTEXT_KEYS.has(lowerKey)) push(lowerKey, value);
		else if (DOTTED_CONTEXT_KEYS.has(lowerKey)) push(lowerKey.split(".").pop(), value);
		else if (lowerKey === "limit" && value && typeof value === "object") push("limit_context", value.context ?? value.context_window ?? value.contextWindow);
		else if (typeof value === "string" && (lowerKey === "parameters" || lowerKey === "raw_parameters" || lowerKey === "template_kv")) {
			const hit = OLLAMA_PARAM_RE.exec(value);
			if (hit) push(hit[1].toLowerCase(), hit[2]);
		} else if (typeof value === "object" && value !== null) collectCapacities(value, here, depth + 1, found, limits, budget);
	}
	return budget.left;
}

/** 在（子）对象里挑最可信的一个容量字段：按字段名优先级，其次按离根的层次浅优先。 */
function pickCapacity(found) {
	const sorted = [...found].sort((a, b) => {
		const pa = CONTEXT_KEY_PRIORITY.indexOf(a.name);
		const pb = CONTEXT_KEY_PRIORITY.indexOf(b.name);
		if (pa !== pb) return (pa < 0 ? 999 : pa) - (pb < 0 ? 999 : pb);
		return a.depth - b.depth;
	});
	return sorted[0] ?? null;
}

/**
 * 解析一个端点的响应：拿到上报容量 + 身份判定。
 * `models` 一类列表响应先按 id 选中自己那一条，只在该条目里找容量，避免把邻居模型的窗口读过来。
 */
function parseContextReport(kind, payload, requestedModel, limits) {
	const root = payload && typeof payload === "object" ? payload : null;
	if (!root) return { ok: false, code: "bad_payload" };
	if (kind === "models") {
		const wanted = normalizeModelId(requestedModel);
		const candidates = [];
		const list = Array.isArray(root.data) ? root.data : Array.isArray(root.models) ? root.models : null;
		if (Array.isArray(list)) {
			for (const entry of list) {
				if (!entry || typeof entry !== "object") continue;
				const id = typeof entry.id === "string" ? entry.id : typeof entry.name === "string" ? entry.name : "";
				const verdict = wanted && id ? identityVerdict(id, requestedModel) : "unverified";
				candidates.push({ entry, id, verdict });
			}
			// 只认「点到自己」的条目；没点名要找哪个模型时，列表只有一条才将就（多了不猜）
			const exact = candidates.find((row) => row.verdict === "match");
			const lone = candidates.length === 1 && (!wanted || candidates[0].verdict === "unverified") ? candidates[0] : null;
			const chosen = exact ?? lone;
			if (!chosen) return { ok: false, code: wanted ? "model_not_in_list" : "no_models" };
			const found = [];
			collectCapacities(chosen.entry, "", 0, found, { ...limits, maxDepth: 4 }, { left: 64 });
			const best = pickCapacity(found);
			if (!best) return { ok: false, code: "no_capacity_field" };
			return {
				ok: true,
				value: best.value,
				field: best.key,
				identity: chosen.id ? identityVerdict(chosen.id, requestedModel) : "unverified",
				echoed: chosen.id,
			};
		}
		const table = root.models && typeof root.models === "object" && !Array.isArray(root.models) ? root.models : null;
		if (table) {
			const keys = Object.keys(table);
			const hitKey = keys.find((key) => identityVerdict(key, requestedModel) === "match")
				?? (keys.length === 1 && (!wanted || identityVerdict(keys[0], requestedModel) === "unverified") ? keys[0] : null);
			if (!hitKey) return { ok: false, code: wanted ? "model_not_in_list" : "no_models" };
			const entry = table[hitKey];
			const found = [];
			collectCapacities(entry, "", 0, found, { ...limits, maxDepth: 4 }, { left: 64 });
			const best = pickCapacity(found);
			if (!best) return { ok: false, code: "no_capacity_field" };
			return { ok: true, value: best.value, field: best.key, identity: identityVerdict(hitKey, requestedModel), echoed: hitKey };
		}
		return { ok: false, code: "bad_payload" };
	}
	if (kind === "props") {
		const found = [];
		collectCapacities(root, "", 0, found, { ...limits, maxDepth: 4 }, { left: 96 });
		const own = found.filter((row) => /^(default_generation_settings\.n_ctx|general\.n_ctx|n_ctx)$/i.test(row.key));
		const best = pickCapacity(own.length ? own : found);
		if (!best) return { ok: false, code: "no_capacity_field" };
		const echoed = identityOf(root) || (root.model_path ? path.basename(String(root.model_path)) : "");
		return { ok: true, value: best.value, field: best.key, identity: identityVerdict(echoed, requestedModel), echoed };
	}
	const found = [];
	collectCapacities(root, "", 0, found, { ...limits, maxDepth: 4 }, { left: 128 });
	const best = pickCapacity(found);
	if (!best) return { ok: false, code: "no_capacity_field" };
	return { ok: true, value: best.value, field: best.key, identity: identityVerdict(best.identity, requestedModel), echoed: best.identity };
}

// ---------- patch 配置改写 ----------

/** 把 providers 字典里某条路由的某个模型上限改成 value；返回新字典与「真的改了吗」。 */
function patchProvidersForCapacity(providers, provider, model, value) {
	const notes = [];
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return { providers, changed: false, notes: ["providers_missing"] };
	if (!Object.hasOwn(providers, provider)) return { providers, changed: false, notes: ["provider_missing"] };
	const route = providers[provider] && typeof providers[provider] === "object" ? providers[provider] : null;
	if (!route) return { providers, changed: false, notes: ["provider_missing"] };
	const nextRoute = { ...route };
	const models = Array.isArray(route.models) ? route.models : null;
	if (models) {
		const index = models.findIndex((entry) => entry && typeof entry === "object" && identityVerdict(entry.id ?? entry.name, model) === "match");
		if (index >= 0) {
			const entry = models[index];
			if (entry.contextWindow === value) return { providers, changed: false, notes: ["already"] };
			const nextModels = models.slice();
			nextModels[index] = { ...entry, contextWindow: value };
			nextRoute.models = nextModels;
			notes.push("models_entry_updated");
		} else {
			nextRoute.models = [...models, { id: model, name: model, contextWindow: value }];
			notes.push("models_entry_added");
		}
	} else {
		const overrides = route.modelOverrides && typeof route.modelOverrides === "object" && !Array.isArray(route.modelOverrides) ? route.modelOverrides : {};
		const entry = overrides[model] && typeof overrides[model] === "object" ? overrides[model] : {};
		if (entry.contextWindow === value) return { providers, changed: false, notes: ["already"] };
		nextRoute.modelOverrides = { ...overrides, [model]: { ...entry, contextWindow: value } };
		notes.push("model_overrides");
	}
	return { providers: { ...providers, [provider]: nextRoute }, changed: true, notes };
}

/** 把压缩侧的策略并进 compaction-basic 的 config；互斥与会被宿主拒绝的组合在这里挡掉。 */
function patchCompactionPolicy(current, cfg) {
	const base = current && typeof current === "object" && !Array.isArray(current) ? { ...current } : {};
	const notes = [];
	const ratio = clampRatio(cfg.thresholdRatio, HOST_DEFAULTS.thresholdRatio);
	const currentRatio = clampRatio(base.thresholdRatio, HOST_DEFAULTS.thresholdRatio);
	if (base.thresholdRatio === undefined || base.thresholdRatio !== ratio) {
		if (base.thresholdRatio !== undefined || ratio !== HOST_DEFAULTS.thresholdRatio) {
			base.thresholdRatio = ratio;
			notes.push("thresholdRatio");
		}
	}
	if (cfg.headroomTokens !== null && cfg.headroomTokens !== undefined) {
		if (base.headroomTokens !== cfg.headroomTokens) {
			base.headroomTokens = cfg.headroomTokens;
			notes.push("headroomTokens");
		}
	}
	if (cfg.retainTokens !== null && cfg.retainTokens !== undefined) {
		if (base.retainTokens !== cfg.retainTokens) {
			base.retainTokens = cfg.retainTokens;
			notes.push("retainTokens");
		}
		if (base.retainRatio !== undefined) {
			delete base.retainRatio;
			notes.push("retainRatio_cleared");
		}
	} else if (cfg.retainRatio !== null && cfg.retainRatio !== undefined) {
		if (base.retainRatio !== cfg.retainRatio) {
			base.retainRatio = cfg.retainRatio;
			notes.push("retainRatio");
		}
		if (base.retainTokens !== undefined) {
			delete base.retainTokens;
			notes.push("retainTokens_cleared");
		}
	}
	const effectiveRatio = clampRatio(base.thresholdRatio, HOST_DEFAULTS.thresholdRatio);
	const effectiveRetainRatio = base.retainRatio === undefined ? HOST_DEFAULTS.retainRatio : Number(base.retainRatio);
	if (base.retainRatio !== undefined && effectiveRetainRatio >= effectiveRatio) {
		return { config: base, changed: false, blocked: "retain_conflict", notes: [...notes, "retain_conflict"] };
	}
	const changed = notes.filter((note) => !note.endsWith("_cleared")).length > 0;
	if (!changed) return { config: current, changed: false, notes: ["already"] };
	return { config: base, changed: true, notes };
}

/** 生效阈值（与宿主同一口径）：floor(min(W×ratio, W−O−headroom))；预算被压平时退到纯比例。 */
function computeThresholdTokens(contextWindow, ratio, reservedOutputTokens, headroomTokens) {
	const window = plausibleCapacity(contextWindow, 1, 268435456);
	if (window === null) return null;
	const output = Number.isFinite(reservedOutputTokens) && reservedOutputTokens > 0 ? Math.floor(reservedOutputTokens) : 0;
	const headroom = Number.isFinite(headroomTokens) && headroomTokens > 0 ? Math.floor(headroomTokens) : 0;
	const byRatio = Math.floor(window * clampRatio(ratio, HOST_DEFAULTS.thresholdRatio, 0.01, 1));
	const budget = window - output - headroom;
	if (budget <= 0) return byRatio;
	return Math.floor(Math.min(byRatio, budget));
}

// ---------- 状态与设置文件 ----------

function defaultStorageDir() {
	return path.join(os.homedir(), ".dsh", "storages", "context-governor");
}

function resolveStateFile(cfg) {
	if (typeof cfg.stateFile === "string" && cfg.stateFile.trim()) return cfg.stateFile;
	return path.join(defaultStorageDir(), "state.json");
}

function resolveSettingsFile(cfg) {
	return path.join(path.dirname(resolveStateFile(cfg)), "settings.json");
}

function readJsonFile(file) {
	try {
		const raw = JSON.parse(fs.readFileSync(file, "utf8"));
		return raw && typeof raw === "object" ? raw : null;
	} catch {
		return null;
	}
}

function writeJsonFileAtomic(file, payload) {
	try {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
		fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/** 设置文件：只认白名单键，读回来的未知键保留不动。 */
function readSettingsFile(file) {
	const raw = readJsonFile(file);
	if (!raw) return {};
	const picked = {};
	for (const key of SETTING_KEYS) {
		if (Object.hasOwn(raw, key)) picked[key] = raw[key];
	}
	if (typeof raw.updatedAt === "string") picked.updatedAt = raw.updatedAt;
	return sanitizeSettingsInput(picked);
}

function writeSettingsFile(file, patch) {
	// 以**原始文件**为底合并：白名单视图（readSettingsFile）会把别人写的键过滤掉，
	// 用它当底就会在每次落盘时静默删掉不属于本插件的键。
	const raw = readJsonFile(file) || {};
	const next = { version: 1, ...raw, ...sanitizeSettingsInput(patch), updatedAt: nowIso() };
	writeJsonFileAtomic(file, next);
	return next;
}

function emptyState() {
	return { version: 1, applied: {}, probes: {}, audit: [], writes: [] };
}

function readStateFile(file) {
	const raw = readJsonFile(file);
	if (!raw || typeof raw !== "object") return emptyState();
	const state = emptyState();
	if (raw.applied && typeof raw.applied === "object" && !Array.isArray(raw.applied)) state.applied = { ...raw.applied };
	if (raw.probes && typeof raw.probes === "object" && !Array.isArray(raw.probes)) state.probes = { ...raw.probes };
	if (Array.isArray(raw.audit)) state.audit = raw.audit.filter((row) => row && typeof row === "object").slice(-80);
	if (Array.isArray(raw.writes)) state.writes = raw.writes.filter((row) => Number.isFinite(row)).slice(-200);
	return state;
}

// ---------- 框架服务的可选取用 ----------

function getService(ctx, key) {
	try {
		if (ctx && typeof ctx.get === "function") return ctx.get(key) ?? null;
	} catch {
		/* 服务没挂载或取用抛错：少干这件事，不炸插件 */
	}
	return null;
}

function listEntries(ctx) {
	const editor = getService(ctx, "configEditor");
	if (!editor || typeof editor.entries !== "function") return [];
	try {
		const rows = editor.entries();
		return Array.isArray(rows) ? rows.filter((row) => row && typeof row === "object" && row.options) : [];
	} catch {
		return [];
	}
}

function findRow(ctx, id, name) {
	const rows = listEntries(ctx);
	return rows.find((row) => row.options.id === id) ?? rows.find((row) => row.options.name === name) ?? null;
}

function rowConfig(row) {
	const config = row && row.options && row.options.config;
	return config && typeof config === "object" && !Array.isArray(config) ? config : {};
}

function patchDocumentPath(ctx) {
	const editor = getService(ctx, "configEditor");
	try {
		return typeof editor?.documentPath === "string" ? editor.documentPath : null;
	} catch {
		return null;
	}
}

// ---------- 探测 ----------

/** 测试缝：自检注入假 fetch；线上仍是 globalThis.fetch。 */
let fetchImpl = (input, init) => globalThis.fetch(input, init);
export function __setFetchForTests(fn) {
	fetchImpl = typeof fn === "function" ? fn : (input, init) => globalThis.fetch(input, init);
}

/** 一次 HTTP 往返：只回状态码与解析出来的 JSON，任何失败都不抛。 */
async function httpJson(url, { method = "GET", body, apiKey, timeoutMs = 2500, signal } = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), Math.max(100, Number(timeoutMs) || 2500));
	const abortFromParent = () => controller.abort();
	if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", abortFromParent);
	try {
		const headers = { accept: "application/json" };
		if (body) headers["content-type"] = "application/json";
		if (apiKey) headers.authorization = /^bearer /i.test(String(apiKey)) ? String(apiKey) : `Bearer ${apiKey}`;
		const response = await fetchImpl(url, { method: body ? "POST" : method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
		const status = Number(response && response.status) || 0;
		let text = "";
		try {
			text = await response.text();
		} catch {
			text = "";
		}
		let json = null;
		try {
			json = text ? JSON.parse(text) : null;
		} catch {
			json = null;
		}
		return { ok: status >= 200 && status < 300, status, json, text: text.slice(0, 400) };
	} catch (err) {
		const message = msgOf(err);
		return { ok: false, status: 0, json: null, text: "", error: /abort/i.test(message) ? "timeout_or_aborted" : message };
	} finally {
		clearTimeout(timer);
		if (signal && typeof signal.removeEventListener === "function") signal.removeEventListener("abort", abortFromParent);
	}
}

async function resolveApiKey(ctx, cfg, refName, cache) {
	if (typeof cfg.probeApiKey === "string" && cfg.probeApiKey.trim()) return { key: cfg.probeApiKey.trim(), source: "config" };
	const ref = typeof refName === "string" ? refName.trim() : "";
	if (!ref) return { key: "", source: "none" };
	if (cache && cache.has(ref)) return { key: cache.get(ref), source: "cache" };
	let key = "";
	let source = "none";
	const credentials = getService(ctx, "credentials");
	if (credentials && typeof credentials.resolve === "function") {
		try {
			const hit = await credentials.resolve(ref);
			const value = hit && typeof hit.value === "string" ? hit.value : "";
			if (value) {
				key = value;
				source = "credentials";
			}
		} catch {
			/* 凭据 seam 不认这个写法 / 没这条记录：继续退环境变量 */
		}
	}
	if (!key) {
		try {
			const launch = getService(ctx, "launchEnvironment");
			const hit = launch && typeof launch.get === "function" ? launch.get(ref) : null;
			const value = hit && typeof hit.value === "string" ? hit.value : "";
			if (value) {
				key = value;
				source = "launchEnvironment";
			}
		} catch { /* 同上 */ }
	}
	if (!key) {
		try {
			const value = process.env[ref];
			if (typeof value === "string" && value) {
				key = value;
				source = "env";
			}
		} catch { /* 同上 */ }
	}
	if (cache) cache.set(ref, key);
	return { key, source };
}

/** 路由配置里声明的模型 id 清单（models 列表 + modelOverrides 点名的）。 */
function declaredModels(route) {
	const out = [];
	const seen = new Set();
	const push = (id) => {
		const value = typeof id === "string" ? id.trim() : "";
		if (!value || seen.has(value)) return;
		seen.add(value);
		out.push(value);
	};
	if (Array.isArray(route?.models)) for (const entry of route.models) push(entry && typeof entry === "object" ? entry.id ?? entry.name : entry);
	if (route?.modelOverrides && typeof route.modelOverrides === "object" && !Array.isArray(route.modelOverrides)) for (const key of Object.keys(route.modelOverrides)) push(key);
	return out;
}

/** 问一遍这个 provider+model：依次试候选端点，第一个「可信且身份不冲突」的上报值即胜出。 */
async function probeTarget(ctx, cfg, route, provider, model, { signal, keyCache, attemptLogLimit = 6 } = {}) {
	const at = Date.now();
	const info = endpointInfo(route?.baseURL);
	if (!info) return { at, ok: false, code: "no_baseurl", provider, model };
	if (!hostInScope(info.host, cfg.probeScope)) return { at, ok: false, code: "out_of_scope", provider, model, host: info.host, hostKind: hostKind(info.host) };
	const { key, source: keySource } = await resolveApiKey(ctx, cfg, route?.apiKeyEnv, keyCache);
	const limits = { min: cfg.minReportedContextWindow, max: cfg.maxReportedContextWindow, maxDepth: 4 };
	const attempts = [];
	let mismatched = null;
	let unreachable = 0;
	let gaveUp = false;
	for (const candidate of endpointCandidates(route.baseURL, model)) {
		let response = await httpJson(candidate.url, { method: candidate.method, body: candidate.body, apiKey: key, timeoutMs: cfg.probeTimeoutMs, signal });
		if (!response.ok && (response.status === 401 || response.status === 403) && key) {
			// 带着 key 被拒：再去掉 key 试一次（很多本地服务的 /health 本来就不要密钥）
			response = await httpJson(candidate.url, { method: candidate.method, body: candidate.body, timeoutMs: cfg.probeTimeoutMs, signal });
		}
		if (!response.ok) {
			attempts.push({ url: candidate.url, kind: candidate.kind, status: response.status, note: response.error ?? `http_${response.status}` });
			// 连着两次都是连不上（不是 404/401 这种「服务活着但不认这个路径」）：这台机器多半没开，别把六个端点都等一遍超时
			if (response.status === 0) {
				unreachable += 1;
				if (unreachable >= 2) {
					gaveUp = true;
					attempts.push({ url: candidate.url, kind: "giveup", status: 0, note: "unreachable" });
					break;
				}
			}
			continue;
		}
		const parsed = parseContextReport(candidate.kind, response.json, model, limits);
		if (!parsed.ok) {
			attempts.push({ url: candidate.url, kind: candidate.kind, status: response.status, note: parsed.code });
			continue;
		}
		if (parsed.identity === "mismatch") {
			mismatched = { value: parsed.value, echoed: parsed.echoed, url: candidate.url, kind: candidate.kind };
			attempts.push({ url: candidate.url, kind: candidate.kind, status: response.status, note: `identity_mismatch:${parsed.echoed || "?"}` });
			continue;
		}
		const clamped = Math.max(cfg.minReportedContextWindow, Math.floor(parsed.value * clampRatio(cfg.contextSafetyRatio, 1, 0.5, 1)));
		return {
			at,
			ok: true,
			provider,
			model,
			value: parsed.value,
			clamped,
			field: parsed.field,
			identity: parsed.identity,
			echoed: parsed.echoed || "",
			endpoint: candidate.url,
			kind: candidate.kind,
			keySource,
			attempts: attempts.slice(0, attemptLogLimit),
		};
	}
	if (mismatched) return { at, ok: false, code: "identity_mismatch", provider, model, reported: mismatched.value, echoed: mismatched.echoed, endpoint: mismatched.url, attempts: attempts.slice(0, attemptLogLimit) };
	return { at, ok: false, code: gaveUp ? "unreachable" : "no_report", provider, model, attempts: attempts.slice(0, attemptLogLimit) };
}

/** 当前生效的上限：问 llm 服务这个路由解析出来的容量（不发网络请求）。 */
async function configuredCapacity(ctx, provider, model) {
	const llm = getService(ctx, "llm");
	if (!llm || typeof llm.resolveModelInfo !== "function") return { contextWindow: null, code: "no_llm_service" };
	try {
		const info = await llm.resolveModelInfo(provider, model);
		const contextWindow = info && info.context && typeof info.context === "object" ? info.context.contextWindow ?? null : null;
		return {
			contextWindow: typeof contextWindow === "number" && Number.isFinite(contextWindow) ? Math.floor(contextWindow) : null,
			defaultMaxTokens: typeof info?.defaultMaxTokens === "number" ? info.defaultMaxTokens : null,
		};
	} catch (err) {
		return { contextWindow: null, code: "resolve_failed", error: msgOf(err) };
	}
}

// ---------- 入口 ----------

export function apply(ctx, config = {}) {
	const patchConfig = sanitizeSettingsInput(config);
	const stateFile = resolveStateFile(patchConfig);
	const settingsFile = path.join(path.dirname(stateFile), "settings.json");
	const state = readStateFile(stateFile);

	let stopped = false;
	let cfg = resolveConfig(patchConfig, readSettingsFile(settingsFile));
	const keyCache = new Map();
	const capacityCache = new Map();
	const inflightProbes = new Set();
	const seenTargets = new Map();
	const warnedOnce = new Set();
	const controllers = new Set();
	let lastWriteAt = state.writes.length > 0 ? Math.max(...state.writes.slice(-8)) : 0;

	const logger = ctx && ctx.logger ? ctx.logger : null;
	const logInfo = (message) => {
		try {
			logger?.info?.(`context-governor: ${message}`);
		} catch { /* 日志不能影响功能 */ }
	};
	const logWarn = (message) => {
		try {
			logger?.warn?.(`context-governor: ${message}`);
		} catch { /* 同上 */ }
	};
	const warnOnce = (key, message) => {
		if (warnedOnce.has(key)) return;
		warnedOnce.add(key);
		logWarn(message);
	};

	const saveState = () => {
		state.writes = state.writes.filter((ts) => Date.now() - ts < 3600000).slice(-200);
		if (state.audit.length > 80) state.audit = state.audit.slice(-80);
		writeJsonFileAtomic(stateFile, { version: 1, applied: state.applied, probes: state.probes, audit: state.audit, writes: state.writes });
	};
	const pushAudit = (entry) => {
		state.audit = [...state.audit, { at: nowIso(), ...entry }].slice(-80);
		saveState();
	};

	// patch 写入串行化：configEditor 自己带文件锁，但同进程里两个写入互相等更干净（也便于限流）。
	const chain = { task: Promise.resolve() };
	const enqueue = (label, task) => {
		chain.task = chain.task
			.then(async () => {
				if (stopped) return null;
				try {
					return await task();
				} catch (err) {
					logWarn(`${label}: ${msgOf(err)}`);
					return { ok: false, code: "throw", error: msgOf(err) };
				}
			})
			.catch(() => null);
		return chain.task;
	};

	const editRow = (row, label, mutate) =>
		enqueue(label, async () => {
			const editor = getService(ctx, "configEditor");
			if (!editor || typeof editor.edit !== "function") return { ok: false, code: "no_config_editor" };
			if (!row) return { ok: false, code: "row_missing" };
			try {
				await editor.edit(row, (current, inherited) => mutate(current || {}, inherited || {}));
			} catch (err) {
				// change 回调里抛 SkipWriteError = 算完发现没变化：不是失败，也不写盘
				if (err instanceof SkipWriteError) return { ok: false, code: "noop", error: msgOf(err) };
				throw err;
			}
			return { ok: true };
		});

	const capacityOf = async (provider, model, force) => {
		const key = `${provider}|${model}`;
		const hit = capacityCache.get(key);
		if (!force && hit && Date.now() - hit.at < 15000) return hit;
		const result = await configuredCapacity(ctx, provider, model);
		const value = { ...result, at: Date.now() };
		capacityCache.set(key, value);
		return value;
	};

	const writeCapacity = async ({ provider, model, value, before, endpoint, kind, identity, force = false }) => {
		const target = Math.max(cfg.minReportedContextWindow, Math.floor(value));
		const beforeCapacity = before ?? (await capacityOf(provider, model, true)).contextWindow;
		// 值已经对了就直说：限流与 pins 是给「真要写」的请求设的闸，不该把 no-op 也报成失败
		if (beforeCapacity === target) return { ok: true, code: "already", before: beforeCapacity, after: target };
		const pin = cfg.pins.find((row) => row.provider === provider && row.model === model);
		if (pin && !force) return { ok: false, code: "pinned", pinned: pin.contextWindow };
		const recent = state.writes.filter((ts) => Date.now() - ts < 3600000);
		if (recent.length >= cfg.maxWritesPerHour) return { ok: false, code: "rate_limited", recent: recent.length };
		if (Date.now() - lastWriteAt < cfg.minWriteIntervalMs) return { ok: false, code: "too_soon" };
		const row = findRow(ctx, LLM_ROW_ID, LLM_ROW_NAME);
		if (!row) return { ok: false, code: "row_missing" };
		const result = await editRow(row, `patch ${provider}/${model}`, (current, inherited) => {
			const base = current.providers ?? inherited.providers ?? {};
			const patched = patchProvidersForCapacity(base, provider, model, target);
			if (!patched.changed) throw new SkipWriteError(`${provider}/${model} 的上限已是 ${target}`);
			return { ...current, providers: patched.providers };
		});
		if (!result) return { ok: false, code: "no_result" };
		if (!result.ok) {
			if (result.code === "noop") return { ok: true, code: "already", before: beforeCapacity, after: target };
			pushAudit({ kind: "capacity_write_failed", provider, model, reported: target, code: result.code, error: result.error });
			return { ok: false, code: result.code ?? "write_failed", error: result.error, before: beforeCapacity };
		}
		lastWriteAt = Date.now();
		state.writes = [...state.writes, lastWriteAt].slice(-200);
		const key = `${provider}|${model}`;
		state.applied[key] = {
			at: nowIso(),
			before: beforeCapacity ?? null,
			after: target,
			reported: value,
			endpoint: endpoint ?? null,
			kind: kind ?? null,
			identity: identity ?? null,
			forced: !!force,
		};
		saveState();
		logInfo(`${provider}/${model} 上下文上限 ${beforeCapacity ?? "?"} → ${target}（来源 ${kind ?? "?"}，端点 ${endpoint ?? "?"}）`);
		pushAudit({ kind: "capacity_applied", provider, model, before: beforeCapacity ?? null, after: target, reported: value, sourceKind: kind ?? null, endpoint: endpoint ?? null, forced: !!force });
		return { ok: true, code: "applied", before: beforeCapacity ?? null, after: target };
	};

	const syncCompactionPolicy = async () => {
		if (!cfg.writeCompactionConfig) return { ok: false, code: "write_off" };
		const row = findRow(ctx, COMPACT_ROW_ID, COMPACT_ROW_NAME);
		if (!row) return { ok: false, code: "row_missing" };
		// 先在快照上算一遍：会被宿主拒绝的组合（retain ≥ threshold）根本不发起写入，
		// 已是设定值也不发起写入（省一次 patch 落盘 + 条目热重组）。
		const preview = patchCompactionPolicy(rowConfig(row), cfg);
		if (preview.blocked) return { ok: false, code: "retain_conflict", notes: preview.notes };
		if (!preview.changed) return { ok: true, code: "already", notes: preview.notes };
		const result = await editRow(row, "compaction policy", (current) => {
			const patched = patchCompactionPolicy(current, cfg);
			if (patched.blocked) throw new Error(`retain 配置与 thresholdRatio 冲突：${patched.blocked}`);
			return patched.changed ? patched.config : current;
		});
		if (!result) return { ok: false, code: "no_result" };
		if (!result.ok) return result.code === "noop" ? { ok: true, code: "already" } : result;
		logInfo(`compaction-basic thresholdRatio 已设为 ${cfg.thresholdRatio}${cfg.headroomTokens !== null ? `，headroomTokens ${cfg.headroomTokens}` : ""}`);
		pushAudit({ kind: "compaction_synced", thresholdRatio: cfg.thresholdRatio, headroomTokens: cfg.headroomTokens, retainRatio: cfg.retainRatio, retainTokens: cfg.retainTokens });
		return { ok: true, code: "applied" };
	};

	/**
	 * 「谁来触发自动压缩」：
	 * never 从不开自己盯；always 总是自己盯一遍；auto（默认）= 压缩后端在位、但它的阈值配置我们写不进去
	 * （writeCompactionConfig 关着，或那条 config 行不在本 profile 的可写范围里）才自己盯。
	 * 组合里根本没有压缩后端时自己盯也没用（compactIfNeeded 无人实现），这时状态页会直接说明。
	 */
	const ownTriggerActive = () => {
		if (cfg.ownPressureTrigger === "never") return false;
		if (cfg.ownPressureTrigger === "always") return true;
		if (getService(ctx, "compaction") === null) return false;
		if (!cfg.writeCompactionConfig) return true;
		return findRow(ctx, COMPACT_ROW_ID, COMPACT_ROW_NAME) === null;
	};

	const probeNow = async (provider, model, { signal } = {}) => {
		const providersConfig = rowConfig(findRow(ctx, LLM_ROW_ID, LLM_ROW_NAME)).providers ?? {};
		const route = providersConfig[provider];
		if (!route) return { at: Date.now(), ok: false, code: "provider_missing", provider, model };
		const controller = new AbortController();
		controllers.add(controller);
		if (signal && typeof signal.addEventListener === "function") signal.addEventListener("abort", () => controller.abort(), { once: true });
		try {
			const report = await probeTarget(ctx, cfg, route, provider, model, { signal: controller.signal, keyCache });
			const key = `${provider}|${model}`;
			state.probes[key] = report;
			saveState();
			capacityCache.delete(key);
			return report;
		} finally {
			controllers.delete(controller);
		}
	};

	const scheduleProbe = (provider, model, { force = false } = {}) => {
		if (!cfg.enabled) return null;
		const key = `${provider}|${model}`;
		const stored = state.probes[key];
		const last = stored && typeof stored.at === "number" && Number.isFinite(stored.at) ? stored.at : 0;
		if (!force && (inflightProbes.has(key) || Date.now() - last < cfg.probeIntervalMs)) return null;
		if (inflightProbes.has(key)) return null;
		inflightProbes.add(key);
		const job = Promise.resolve()
			.then(async () => {
				const report = await probeNow(provider, model);
				if (!report || !report.ok) {
					if (report && report.code === "identity_mismatch") {
						warnOnce(`mismatch:${key}`, `${provider}/${model} 的服务端回显的是另一个模型（${report.echoed || "?"}），本次不改上限`);
					}
					return report;
				}
				if (!cfg.autoFixContextWindow) return report;
				const applied = await writeCapacity({
					provider,
					model,
					value: report.clamped,
					endpoint: report.endpoint,
					kind: report.kind,
					identity: report.identity,
				});
				return { ...report, applied };
			})
			.catch((err) => {
				logWarn(`probe ${provider}/${model}: ${msgOf(err)}`);
				return { ok: false, code: "throw", error: msgOf(err) };
			})
			.then((report) => {
				inflightProbes.delete(key);
				return report;
			});
		return job;
	};

	const ownPressureCheck = async (agent, target, signal) => {
		const compaction = getService(ctx, "compaction");
		const meter = getService(ctx, "tokenMeter");
		if (!compaction || typeof compaction.compactIfNeeded !== "function" || !meter || typeof meter.measure !== "function") {
			warnOnce("own-trigger-unavailable", "ownPressureTrigger 已启用但组合里没有 compaction 后端或 tokenMeter，跳过自动压缩");
			return null;
		}
		const info = await capacityOf(target.provider, target.model);
		const windowTokens = info.contextWindow;
		if (!windowTokens) return null;
		const headroom = cfg.headroomTokens ?? null;
		const requestHeader = typeof agent?.session?.requestHeader === "function" ? safeCall(() => agent.session.requestHeader()) : null;
		const reserved = requestHeader?.config?.maxTokens ?? info.defaultMaxTokens ?? 0;
		const threshold = computeThresholdTokens(windowTokens, cfg.thresholdRatio, reserved, headroom ?? HOST_DEFAULTS.headroomTokens);
		if (threshold === null) return null;
		let measurement = null;
		try {
			measurement = meter.measure(agent.session);
		} catch {
			return null;
		}
		const pressure = measurement && Number.isFinite(measurement.totalTokens) ? measurement.totalTokens : 0;
		if (pressure < threshold) return null;
		logInfo(`自触发压缩：${target.provider}/${target.model} 压力 ${pressure} ≥ 阈值 ${threshold}`);
		const result = await compaction.compactIfNeeded(agent, "pressure", signal);
		if (result) pushAudit({ kind: "own_compaction", provider: target.provider, model: target.model, pressure, threshold, shadowed: result.shadowedSeqs ? result.shadowedSeqs.length : null, freed: result.shadowedTokenCount ?? null });
		return result;
	};

	// ---------- 自动路径：agent 每步前 ----------
	if (typeof ctx.on === "function") {
		safeCall(() =>
			ctx.on("agent/pre-step", async ({ agent, signal }, next) => {
				if (cfg.enabled && !stopped) {
					const target = routedTargetOf(agent);
					if (target) {
						const sessionId = String(agent?.session?.id ?? "");
						seenTargets.set(sessionId || target.provider, { ...target, at: Date.now() });
						scheduleProbe(target.provider, target.model);
						if (ownTriggerActive()) {
							try {
								await ownPressureCheck(agent, target, signal);
							} catch (err) {
								logWarn(`step compaction: ${msgOf(err)}`);
							}
						}
					}
				}
				return next();
			}),
		);
	}

	// ---------- 设置页 HTTP 路由 ----------

	const localRoutes = () => {
		const providersConfig = rowConfig(findRow(ctx, LLM_ROW_ID, LLM_ROW_NAME)).providers ?? {};
		const rows = [];
		for (const [provider, route] of Object.entries(providersConfig)) {
			if (!route || typeof route !== "object") continue;
			const info = endpointInfo(route.baseURL);
			const kind = info ? hostKind(info.host) : "other";
			const inScope = !!info && hostInScope(info.host, cfg.probeScope);
			const models = declaredModels(route);
			const extra = [];
			for (const seen of seenTargets.values()) {
				if (seen.provider === provider && !models.includes(seen.model)) extra.push(seen.model);
			}
			for (const appliedKey of Object.keys(state.applied)) {
				const [appliedProvider, appliedModel] = appliedKey.split("|");
				if (appliedProvider === provider && appliedModel && !models.includes(appliedModel) && !extra.includes(appliedModel)) extra.push(appliedModel);
			}
			const all = [...models, ...extra];
			if (all.length === 0 && inScope) all.push("");
			for (const model of all) rows.push({ provider, route, info, kind, inScope, model });
		}
		return rows;
	};

	const buildStatePayload = async () => {
		const editor = getService(ctx, "configEditor");
		const compactionRow = findRow(ctx, COMPACT_ROW_ID, COMPACT_ROW_NAME);
		const compactionConfig = rowConfig(compactionRow);
		const entries = listEntries(ctx);
		const rowsOut = [];
		for (const row of localRoutes()) {
			const key = `${row.provider}|${row.model}`;
			const probe = state.probes[key] ?? null;
			const applied = state.applied[key] ?? null;
			const capacity = await capacityOf(row.provider, row.model);
			const threshold = computeThresholdTokens(capacity.contextWindow, cfg.thresholdRatio, capacity.defaultMaxTokens ?? 0, cfg.headroomTokens ?? HOST_DEFAULTS.headroomTokens);
			const pin = cfg.pins.find((item) => item.provider === row.provider && item.model === row.model) ?? null;
			const pending = !!(probe && probe.ok) && probe.identity !== "mismatch" && capacity.contextWindow !== null && probe.clamped !== capacity.contextWindow;
			rowsOut.push({
				provider: row.provider,
				displayName: typeof row.route.displayName === "string" && row.route.displayName ? row.route.displayName : row.provider,
				baseURL: typeof row.route.baseURL === "string" ? row.route.baseURL : "",
				api: typeof row.route.api === "string" ? row.route.api : "",
				host: row.info ? row.info.host : "",
				hostKind: row.kind,
				inScope: row.inScope,
				model: row.model,
				configuredCapacity: capacity.contextWindow,
				capacityIsHostFallback: capacity.contextWindow !== null && capacity.contextWindow === HOST_DEFAULT_CONTEXT_WINDOW && !(row.route.models || []).some((entry) => entry && entry.id === row.model && entry.contextWindow !== undefined) && !((row.route.modelOverrides || {})[row.model] || {}).contextWindow,
				defaultMaxTokens: capacity.defaultMaxTokens ?? null,
				thresholdTokens: threshold,
				reported: probe ? (probe.ok ? probe.clamped : probe.reported ?? null) : null,
				reportField: probe && probe.field ? probe.field : null,
				reportEndpoint: probe ? probe.endpoint ?? null : null,
				reportKind: probe ? probe.kind ?? null : null,
				reportAt: probe ? probe.at ?? null : null,
				reportIdentity: probe ? probe.identity ?? null : null,
				reportEchoed: probe && probe.echoed ? probe.echoed : null,
				probeCode: probe && !probe.ok ? probe.code : null,
				probeAttempts: probe && probe.attempts ? probe.attempts : [],
				appliedAt: applied ? applied.at : null,
				appliedBefore: applied && Object.hasOwn(applied, "before") ? applied.before : null,
				pendingApply: pending,
				pinned: pin ? pin.contextWindow : null,
			});
		}
		const recentWrites = state.writes.filter((ts) => Date.now() - ts < 3600000).length;
		return {
			ok: true,
			version: PLUGIN_VERSION,
			plugin: name,
			enabled: cfg.enabled,
			language: normalizeLanguageChoice(cfg.language),
			settings: {
				enabled: cfg.enabled,
				autoFixContextWindow: cfg.autoFixContextWindow,
				thresholdRatio: cfg.thresholdRatio,
				writeCompactionConfig: cfg.writeCompactionConfig,
				ownPressureTrigger: cfg.ownPressureTrigger,
				probeScope: cfg.probeScope,
				probeIntervalMs: cfg.probeIntervalMs,
				probeTimeoutMs: cfg.probeTimeoutMs,
				contextSafetyRatio: cfg.contextSafetyRatio,
				maxWritesPerHour: cfg.maxWritesPerHour,
				minWriteIntervalMs: cfg.minWriteIntervalMs,
				headroomTokens: cfg.headroomTokens,
				retainRatio: cfg.retainRatio,
				retainTokens: cfg.retainTokens,
				language: cfg.language,
				pins: cfg.pins,
				minReportedContextWindow: cfg.minReportedContextWindow,
				maxReportedContextWindow: cfg.maxReportedContextWindow,
			},
			defaults: { ...DEFAULTS, ...{ pins: [] } },
			limits: { ratioMin: RATIO_MIN, ratioMax: RATIO_MAX },
			compaction: {
				rowFound: !!compactionRow,
				editable: !!editor && !!compactionRow,
				engineMounted: getService(ctx, "compaction") !== null,
				tokenMeterMounted: getService(ctx, "tokenMeter") !== null,
				onHostThresholdRatio: compactionConfig.thresholdRatio ?? HOST_DEFAULTS.thresholdRatio,
				onHostHeadroomTokens: compactionConfig.headroomTokens ?? HOST_DEFAULTS.headroomTokens,
				onHostRetainRatio: compactionConfig.retainRatio ?? HOST_DEFAULTS.retainRatio,
				ownTriggerActive: ownTriggerActive(),
				writeConfigEnabled: cfg.writeCompactionConfig,
			},
			contextServiceMounted: getService(ctx, "llm") !== null,
			configEditorMounted: !!editor,
			credentialServiceMounted: getService(ctx, "credentials") !== null,
			probing: [...inflightProbes],
			writesLastHour: recentWrites,
			rows: rowsOut,
			audit: state.audit.slice(-24).reverse(),
			sessions: [...seenTargets.entries()].slice(-12).map(([sessionId, target]) => ({ sessionId, provider: target.provider, model: target.model, at: target.at })),
			paths: {
				stateFile,
				settingsFile,
				patchFile: patchDocumentPath(ctx),
			},
			settingsUpdatedAt: (readJsonFile(settingsFile) || {}).updatedAt ?? null,
		};
	};

	function readRequestBody(req) {
		return new Promise((resolve) => {
			let data = "";
			req.on("data", (chunk) => {
				data += chunk;
				if (data.length > 65536) req.destroy();
			});
			req.on("end", () => resolve(data));
			req.on("error", () => resolve(data));
		});
	}

	function sendJson(res, status, payload) {
		try {
			res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
			res.end(JSON.stringify(payload));
		} catch { /* 客户端提前断开 */ }
	}

	async function readJsonBody(req) {
		const raw = await readRequestBody(req);
		if (!String(raw).trim()) return { body: {} };
		try {
			const parsed = JSON.parse(raw);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { body: parsed };
			return { body: {}, error: "body_not_object" };
		} catch {
			return { body: {}, error: "bad_json_body" };
		}
	}

	async function handleApiRequest(req, res) {
		const method = String(req.method ?? "").toUpperCase();
		// 前缀注册不保证 handler 拿到的 req.url 是完整路径：按 URL 解析后再剥前缀，两种都给过就能对上。
		const parsedUrl = safeCall(() => new URL(String(req.url ?? "/"), "http://dsh.invalid")) || { pathname: String(req.url ?? "/") };
		const pathname = String(parsedUrl.pathname || "/");
		const route = (pathname.startsWith(API_PREFIX) ? pathname.slice(API_PREFIX.length) : pathname).replace(/\/+$/, "") || "/";
		try {
			if (method === "GET" && (route === "/state" || route === "/")) {
				return sendJson(res, 200, await buildStatePayload());
			}
			if (method === "POST" && route === "/settings") {
				const { body, error: bodyError } = await readJsonBody(req);
				if (bodyError) return sendJson(res, 400, { ok: false, code: bodyError });
				const picked = {};
				for (const key of SETTING_KEYS) {
					if (body && Object.hasOwn(body, key)) picked[key] = body[key];
				}
				const sanitized = sanitizeSettingsInput(picked);
				if (Object.keys(sanitized).length === 0) return sendJson(res, 400, { ok: false, code: "no_fields" });
				const ratioIn = sanitized.thresholdRatio !== undefined ? sanitized.thresholdRatio : null;
				const retainRatioIn = Object.hasOwn(sanitized, "retainRatio") ? sanitized.retainRatio : cfg.retainRatio;
				const retainTokensIn = Object.hasOwn(sanitized, "retainTokens") ? sanitized.retainTokens : cfg.retainTokens;
				const effectiveRetain = retainTokensIn !== null && retainTokensIn !== undefined ? null : retainRatioIn;
				if (ratioIn !== null && effectiveRetain !== null && effectiveRetain !== undefined && effectiveRetain >= ratioIn) {
					return sendJson(res, 400, { ok: false, code: "retain_conflict", params: { ratio: ratioIn, retainRatio: effectiveRetain } });
				}
				writeSettingsFile(settingsFile, sanitized);
				cfg = resolveConfig(patchConfig, readSettingsFile(settingsFile));
				capacityCache.clear();
				const synced = await syncCompactionPolicy();
				return sendJson(res, 200, { ok: true, code: "saved", sync: synced, state: await buildStatePayload() });
			}
			if (method === "POST" && route === "/probe") {
				const { body, error: bodyError } = await readJsonBody(req);
				if (bodyError) return sendJson(res, 400, { ok: false, code: bodyError });
				const shouldApply = body && (body.apply === true || body.apply === "true");
				const provider = body && typeof body.provider === "string" ? body.provider.trim() : "";
				const model = body && typeof body.model === "string" ? body.model.trim() : "";
				const reports = [];
				if (provider && model) {
					const report = await probeNow(provider, model);
					reports.push(report);
					if (shouldApply && report && report.ok) {
						const applied = await writeCapacity({ provider, model, value: report.clamped, endpoint: report.endpoint, kind: report.kind, identity: report.identity, force: body.force === true });
						reports[reports.length - 1] = { ...report, applied };
					}
				} else {
					for (const row of localRoutes()) {
						if (!row.inScope || !row.model) continue;
						const report = await probeNow(row.provider, row.model);
						if (shouldApply && report && report.ok) {
							const applied = await writeCapacity({ provider: row.provider, model: row.model, value: report.clamped, endpoint: report.endpoint, kind: report.kind, identity: report.identity });
							reports.push({ ...report, applied });
						} else {
							reports.push(report);
						}
					}
				}
				return sendJson(res, 200, { ok: true, code: "probed", reports, state: await buildStatePayload() });
			}
			if (method === "POST" && route === "/apply") {
				const { body, error: bodyError } = await readJsonBody(req);
				if (bodyError) return sendJson(res, 400, { ok: false, code: bodyError });
				const provider = body && typeof body.provider === "string" ? body.provider.trim() : "";
				const model = body && typeof body.model === "string" ? body.model.trim() : "";
				if (!provider || !model) return sendJson(res, 400, { ok: false, code: "bad_request" });
				let value = plausibleCapacity(body && body.reported, cfg.minReportedContextWindow, cfg.maxReportedContextWindow);
				let meta = { endpoint: body && body.endpoint ? String(body.endpoint) : null, kind: body && body.kind ? String(body.kind) : null, identity: "unverified" };
				if (value === null) {
					const stored = state.probes[`${provider}|${model}`];
					if (!stored || !stored.ok) return sendJson(res, 400, { ok: false, code: "no_report_to_apply" });
					value = stored.clamped;
					meta = { endpoint: stored.endpoint, kind: stored.kind, identity: stored.identity };
				}
				const result = await writeCapacity({ provider, model, value, ...meta, force: true });
				return sendJson(res, result.ok ? 200 : 409, { ok: result.ok, code: result.code, result, state: await buildStatePayload() });
			}
			if (method === "POST" && (route === "/reset" || route === "/clear")) {
				if (route === "/reset") {
					try {
						fs.rmSync(settingsFile, { force: true });
					} catch { /* 文件本就不在 */ }
					cfg = resolveConfig(patchConfig, readSettingsFile(settingsFile));
					capacityCache.clear();
					inflightProbes.clear();
				} else {
					state.applied = {};
					state.probes = {};
					state.audit = [{ at: nowIso(), kind: "cleared" }];
					state.writes = [];
					lastWriteAt = 0;
					saveState();
					capacityCache.clear();
				}
				const synced = await syncCompactionPolicy();
				return sendJson(res, 200, { ok: true, code: route === "/reset" ? "settings_reset" : "records_cleared", sync: synced, state: await buildStatePayload() });
			}
			return sendJson(res, 404, { ok: false, code: "unknown_route", params: { method, route } });
		} catch (err) {
			return sendJson(res, 500, { ok: false, code: "internal_error", error: msgOf(err) });
		}
	}

	const registerRoutes = () => {
		const server = getService(ctx, "webServer");
		if (!server || typeof server.register !== "function") return false;
		const off = safeCall(() => server.register({ kind: "prefix", path: API_PREFIX, handler: handleApiRequest }));
		if (off === null) return false;
		safeCall(() => ctx.effect(() => (typeof off === "function" ? off : () => {}), "context-governor: api routes"));
		return true;
	};
	if (!registerRoutes()) {
		let attempts = 0;
		const retry = setInterval(() => {
			attempts += 1;
			if (registerRoutes() || attempts >= 10) clearInterval(retry);
		}, 1500);
		if (typeof retry.unref === "function") retry.unref();
		safeCall(() => ctx.effect(() => () => clearInterval(retry), "context-governor: route retry"));
	}

	// 启动即把阈值对齐（用户没改过就什么都不写；改过则一次落盘并热生效）。
	if (cfg.enabled) enqueue("startup compaction sync", syncCompactionPolicy);

	logInfo(`已启用：阈值比例 ${cfg.thresholdRatio}，自动修正上限 ${cfg.autoFixContextWindow ? "开" : "关"}，探测范围 ${cfg.probeScope}，状态文件 ${stateFile}`);

	const cleanup = () => {
		if (stopped) return;
		stopped = true;
		for (const controller of controllers) {
			try {
				controller.abort();
			} catch { /* 已结束 */ }
		}
		controllers.clear();
		inflightProbes.clear();
		saveState();
	};
	try {
		if (ctx.fiber && typeof ctx.fiber.effect === "function") ctx.fiber.effect(() => cleanup, "context-governor");
		else if (typeof ctx.effect === "function") ctx.effect(() => cleanup, "context-governor");
		else if (typeof ctx.dispose === "function") ctx.dispose(cleanup);
		else if (typeof ctx.onDispose === "function") ctx.onDispose(cleanup);
	} catch { /* 没有生命周期钩子也不影响：定时器已 unref，写入都是即时落盘 */ }
}

/** 自检与排障用的纯函数出口（不是公共 API，未来版本可能改名）。 */
export const internals = {
	PLUGIN_VERSION,
	API_PREFIX,
	LLM_ROW_ID,
	LLM_ROW_NAME,
	COMPACT_ROW_ID,
	COMPACT_ROW_NAME,
	HOST_DEFAULTS,
	HOST_DEFAULT_CONTEXT_WINDOW,
	DEFAULTS,
	SETTING_KEYS,
	SkipWriteError,
	normalizeLanguageChoice,
	sanitizeSettingsInput,
	resolveConfig,
	endpointInfo,
	hostKind,
	hostInScope,
	endpointCandidates,
	declaredModels,
	parseContextReport,
	patchProvidersForCapacity,
	patchCompactionPolicy,
	computeThresholdTokens,
	identityVerdict,
	normalizeModelId,
	plausibleCapacity,
	readJsonFile,
	writeJsonFileAtomic,
	readSettingsFile,
	writeSettingsFile,
	readStateFile,
	defaultStorageDir,
	resolveStateFile,
	resolveSettingsFile,
	safeCall,
	routedTargetOf,
	httpJson,
	probeTarget,
	configuredCapacity,
};
