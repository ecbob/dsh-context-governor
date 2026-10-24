// dsh-context-governor 的**客户端半个插件**（跑在 DSH 桌面端 / Web UI 里）。
//
// 作用：在 DSH 设置页里加「上下文」分区——显示每条本地模型路由「服务端上报的最大上下文」与
// 「当前生效的 contextWindow」是否一致、待应用的是哪几条，并能改自动压缩阈值比例（默认 0.8）、
// 开关（自动修正 / 写阈值进 compaction-basic / 本插件自己触发）、探测范围与间隔，
// 以及「立即探测 / 立即应用 / 恢复默认 / 清空记录」。
//
// 与宿主侧的通道：宿主在 lib/index.js 里用 webServer.register 注册了 `/context-governor/api`
//   GET  /state
//   POST /settings   { thresholdRatio, autoFixContextWindow, ... }（只认白名单键）
//   POST /probe      { provider?, model?, apply? }
//   POST /apply      { provider, model, reported? }
//   POST /reset      设置文件回到 patch config / 内置默认
//   POST /clear      清空探测与改写记录
// 宿主只发数据 + 稳定原因码（`code`），中英两份都不翻译；文案全在本文件的词典里。
//
// 文案语言，按这个顺序定（与 dsh-window-size-keeper 同一套已验证做法）：
//   1. patch config / settings.json 的 `language`（"zh" / "en" 钉死，经宿主 /state 下发）；
//   2. DSH 客户端当前语言（`ctx.locale`，即「设置 → 通用 → 语言」；切语言立刻生效，不重启不刷新）；
//   3. 插件自带 detectLanguage()：只有简体中文走中文，zh-TW / zh-Hant 与其余语言一律英文。
//
// ⚠️ 不把 "locale" 写进 inject：声明了运行时没有的服务会让这半个插件整块起不来（分区消失且不报错）。
//    语言服务是较新客户端才有的，所以对 ctx.locale 用可选访问 + try/catch，拿不到就退回第 3 步。
// ⚠️ 槽位契约：组件是 slots.register(options, component) 的**第二个参数**，工厂必须返回 React 元素；
//    ctx.effect 管注册的清理，渲染的清理归 useEffect 的返回函数。样式作为 <style> 子节点渲染，卸载即消失。
// ⚠️ 只用宿主主题 token（--dsw-alias-*），每个都带十六进制兜底：token 改名只会让外观降级，不会让渲染炸。

window.__ModuleLoader__.load({
	id: "dsh-context-governor",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		// React 由客户端模块加载器注入（与 dsh-window-size-keeper / dshmarket 同源），不是新增依赖。
		const React = require("react");
		const h = React.createElement;
		const inject = ["slots"];
		const API = "/context-governor/api";
		const REFRESH_MS = 10000;
		const NS = "context-governor";
		const LANGS = ["zh", "en"];

		// ---- 词典：zh 是 key 集权威，en 必须逐 key 对齐（scripts/selftest.mjs 盯着）----
		const dictionaries = {
			zh: {
				"lang.code": "zh",
				"nav.title": "上下文",
				"page.title": "上下文",
				"page.hint": "问本地模型服务端「你现在这个模型最大能开多少上下文」，把答出来的数写回 profile 配置里那条路由的 contextWindow；自动压缩阈值按你定的比例算（默认到窗口的 0.8 就压缩）。写盘走宿主的配置写入通道，改完下一个请求就生效，不用重启 DSH。",
				"section.summary": "现状",
				"summary.line": "生效阈值比例 {ratio}　压缩后端 {engine}　本插件自触发 {own}　配置写入通道 {editor}",
				"summary.formula": "阈值 tokens = floor( min( W × {ratio},  W − O − {headroom} ) )　W = 该模型生效的 contextWindow，O = 请求预留的输出 token，{headroom} = 压缩余量（不设置就用宿主默认）。",
				"summary.noEditor": "拿不到配置写入通道（configEditor）：这个 profile 里只能看状态，写不进 patch。",
				"summary.noEngine": "组合里没有压缩后端：自动压缩无从触发（compactIfNeeded 没人实现）。请在 profile 里挂 @deepseek-ai/dsh-compaction-basic。",
				"summary.viaPatch": "压缩后端那条配置被关在 isolate 的组里，configEditor 够不到；这几个键改走 profile patch 顶层直写：{keys}（{ago}）——宿主对本文件的监听会热重组那一行。",
				"summary.viaEditor": "压缩后端的配置走宿主的配置写入通道落盘：{keys}（{ago}）。",
				"summary.formulaO": "这一栏是预览：O（每次请求给输出预留的量）宿主不报数时按 0 计，所以真实触发点只会比它更早，不会更晚。",
				"summary.pending": "待应用：{n} 条路由",
				"card.switch": "开关",
				"switch.enabled": "启用本插件",
				"switch.enabled.alias": "关掉后不探测、不写配置、也不触发压缩（设置页仍能看到现状）",
				"switch.autoFix": "自动修正上限",
				"switch.autoFix.alias": "上报值与生效上限不一致就直接写进 profile patch 并热生效；关掉则只显示「待应用」，由你点「立即应用」才写",
				"switch.writeCompaction": "把阈值写进压缩后端",
				"switch.writeCompaction.alias": "关掉则不动 compaction-basic 的配置，自动压缩改由 ownPressureTrigger 决定",
				"card.threshold": "自动压缩阈值",
				"threshold.ratio": "比例",
				"threshold.ratioHint": "到 W×该比例即压缩（0.05–0.99）。宿主默认也是 0.8：你改成别的值才会写 patch。",
				"threshold.save": "保存比例",
				"threshold.invalid": "比例必须是 {min}–{max} 之间的数字",
		"threshold.saved": "已保存：阈值比例 {ratio}",
				"card.probe": "探测",
				"probe.scope": "探测范围",
				"probe.scope.loopback": "只回环（127.x / localhost）",
				"probe.scope.loopback-private": "回环 + 内网（10.x / 172.16–31.x / 192.168.x / 100.64–127.x / .local）",
				"probe.scope.any": "所有 provider 端点都问",
				"probe.interval": "同一模型两次探测的最小间隔（秒）",
				"probe.timeout": "单次探测超时（毫秒）",
				"probe.safety": "写入上限 = 上报值 ×",
				"probe.safetyHint": "1 就是照抄服务端报的数；小于 1 是把上限再收一档。宿主算阈值时已经扣掉输出预留与压缩余量，所以这里每收 0.01 大约等于提前「0.01 × W」个 token 触发压缩（524288 配 0.92 就把触发点从 419430 提前到 385875）。值仍按你填的算，本插件不替你改。",
				"probe.actions": "操作",
				"action.probeAll": "立即探测全部",
				"action.applyPending": "立即应用全部待应用",
				"action.reset": "恢复默认设置",
				"action.clear": "清空探测记录",
				"action.refresh": "刷新",
				"action.probeOne": "探测",
				"action.applyOne": "应用",
				"action.saving": "保存中…",
				"action.busy": "处理中…",
				"card.advanced": "高级",
				"advanced.headroom": "压缩余量 headroomTokens（留空 = 宿主默认 65536）",
				"advanced.retainRatio": "逐字保留比例 retainRatio（留空 = 宿主默认 0.16）",
				"advanced.language": "本分区文案语言",
				"advanced.language.auto": "跟随 DSH 当前语言",
				"advanced.language.zh": "简体中文",
				"advanced.language.en": "English",
				"advanced.own": "自动压缩由谁触发",
				"advanced.own.auto": "只在阈值写不进后端配置时本插件自己盯（默认）",
				"advanced.own.always": "本插件总是自己盯一遍",
				"advanced.own.never": "完全交给压缩后端",
				"advanced.save": "保存高级设置",
				"table.route": "路由 / 端点",
				"table.model": "模型",
				"table.configured": "生效上限 W",
				"table.reported": "服务端上报",
				"table.threshold": "生效阈值",
				"table.status": "状态",
				"row.host.loopback": "回环",
				"row.host.private": "内网",
				"row.host.name-local": "本机名",
				"row.host.public": "公网",
				"row.host.other": "未知",
				"row.noBase": "该路由没配 baseURL",
				"row.noModel": "该路由没声明模型",
				"state.matched": "已一致",
				"state.pending": "待应用",
				"state.applied": "已修正 {ago}",
					"state.pinned": "已钉死 {value}",
				"state.unprobed": "还没探测",
				"state.outOfScope": "不在探测范围",
				"state.mismatch": "服务端回显的是别的模型（{echoed}）",
				"state.noReport": "问不到（{detail}）",
				"state.unreachable": "连不上这个端点（服务没开？已提前放弃剩下的候选）",
				"state.identityUnverified": "已修正 {ago}（服务端没回显模型名）",
				"state.fallback": "当前 W 是宿主兜底值 262144",
				"ago.seconds": "{n} 秒前",
				"ago.minutes": "{n} 分钟前",
				"ago.hours": "{n} 小时前",
				"ago.days": "{n} 天前",
				"audit.title": "最近的改写与探测",
				"audit.capacity": "{provider}/{model} 上限 {before} → {after}（上报 {reported}，来源 {kind}）",
				"audit.capacity_failed": "{provider}/{model} 写入失败：{code}",
				"audit.compaction": "压缩阈值已写入：ratio {ratio}{extra}",
				"audit.own": "自触发压缩：{provider}/{model} 压力 {pressure} ≥ 阈值 {threshold}",
				"audit.cleared": "记录已清空",
				"audit.empty": "还没有记录",
				"meta.title": "状态与文件",
				"meta.line": "状态文件：{state}　设置文件：{settings}　profile 配置：{patch}",
				"msg.probed": "已探测 {n} 条路由",
				"msg.applied": "已写入 {provider}/{model}：{before} → {after}",
				"msg.appliedAll": "已应用 {n} 条",
				"msg.syncViaPatch": "后端配置已直接写进 profile patch（那一行被关在 isolate 组里，configEditor 够不到）",
				"msg.none": "所有本地路由都已经一致，无需改动",
				"msg.settingsSaved": "设置已保存",
				"msg.reset": "设置已恢复到 patch 配置 / 内置默认",
				"msg.cleared": "探测与改写记录已清空",
				"msg.rateLimited": "这一小时的 patch 写入次数已到上限（{limit} 次/小时），稍后再试",
				"msg.tooSoon": "两次写入间隔太近，稍后再试",
				"msg.pinned": "这条已在 pins 里钉死，插件不覆盖",
				"msg.retainConflict": "retain 设定不小于阈值比例，宿主会拒绝这种组合：先把比例调大或清空 retain",
				"msg.noReportToApply": "还没有这一条的探测结果，先点「探测」",
				"msg.writeOff": "「把阈值写进压缩后端」是关着的，所以阈值只改本插件自己触发时才算数",
				"msg.noEditor": "这个 profile 里没有配置写入通道，写不进 patch",
				"msg.rowMissing": "找不到要改的那条配置行（llm-pi-ai / compaction-basic 未在本 profile 装配）",
				"msg.unknown": "操作失败：{detail}",
				"errors.loading": "读取中…",
				"errors.fetch": "读不到状态（宿主路由没起来？等几秒会自动重试）",
			},
			en: {
				"lang.code": "en",
				"nav.title": "Context",
				"page.title": "Context",
				"page.hint": "Asks each local model endpoint how much context the loaded model actually allows, writes that number into the profile patch as the routed model's contextWindow, and sets the automatic compaction threshold to the ratio you choose (default: 0.8 of the window). Writes go through the host's configuration channel and take effect on the next request — no restart.",
				"section.summary": "Current state",
				"summary.line": "Effective ratio {ratio}　Compaction backend {engine}　This plugin triggers itself {own}　Config writer {editor}",
				"summary.formula": "threshold tokens = floor( min( W × {ratio},  W − O − {headroom} ) )　W = the model's effective contextWindow, O = tokens the request reserves for output, {headroom} = compaction headroom (host default when unset).",
				"summary.noEditor": "No configuration writer (configEditor) available: this profile can show state but cannot persist patch changes.",
				"summary.noEngine": "No compaction backend in this composition: nothing can trigger automatic compaction (compactIfNeeded has no implementation). Mount @deepseek-ai/dsh-compaction-basic.",
				"summary.viaPatch": "The compaction backend's config row is sealed inside an isolated group, out of configEditor's reach; those keys go through a top-level row written straight into the profile patch instead: {keys} ({ago}) — the host watches this file and recomposes that row.",
				"summary.viaEditor": "The compaction backend's config lands through the host's configuration writer: {keys} ({ago}).",
				"summary.formulaO": "This line is a preview: when the host reports no per-request output reservation, O counts as 0, so the real trigger can only be earlier than this, never later.",
				"summary.pending": "pending: {n} route(s)",
				"card.switch": "Switches",
				"switch.enabled": "Enable this plugin",
				"switch.enabled.alias": "Off stops probing, writing and compacting (the section still shows state)",
				"switch.autoFix": "Fix the ceiling automatically",
				"switch.autoFix.alias": "Write the reported ceiling into the profile patch as soon as it differs; off shows it as pending until you press Apply",
				"switch.writeCompaction": "Push the threshold into the compaction backend",
				"switch.writeCompaction.alias": "Off leaves compaction-basic's own config alone; ownPressureTrigger then decides who compacts",
				"card.threshold": "Automatic compaction threshold",
				"threshold.ratio": "Ratio",
				"threshold.ratioHint": "Compact once the session reaches W × ratio (0.05–0.99). The host default is 0.8 too: only a different value gets written to the patch.",
				"threshold.save": "Save ratio",
				"threshold.invalid": "Ratio must be a number between {min} and {max}",
				"threshold.saved": "Saved: threshold ratio {ratio}",
				"card.probe": "Probe",
				"probe.scope": "Probe scope",
				"probe.scope.loopback": "Loopback only (127.x / localhost)",
				"probe.scope.loopback-private": "Loopback + private LAN (10.x / 172.16–31.x / 192.168.x / 100.64–127.x / .local)",
				"probe.scope.any": "Ask every provider endpoint",
				"probe.interval": "Minimum gap between probes of the same model (seconds)",
				"probe.timeout": "Per-probe timeout (milliseconds)",
				"probe.safety": "Written ceiling = reported ×",
				"probe.safetyHint": "1 copies exactly what the server reports; below 1 trims the ceiling a notch. The host already subtracts the output reservation and the compaction headroom when it computes the threshold, so every 0.01 here is roughly 0.01 × W tokens earlier (524288 at 0.92 moves the trigger from 419430 to 385875). The value stays whatever you typed — this plugin never overwrites your choice.",
				"probe.actions": "Actions",
				"action.probeAll": "Probe all now",
				"action.applyPending": "Apply all pending",
				"action.reset": "Reset to defaults",
				"action.clear": "Clear probe records",
				"action.refresh": "Refresh",
				"action.probeOne": "Probe",
				"action.applyOne": "Apply",
				"action.saving": "Saving…",
				"action.busy": "Working…",
				"card.advanced": "Advanced",
				"advanced.headroom": "Compaction headroom headroomTokens (blank = host default 65536)",
				"advanced.retainRatio": "Verbatim retain ratio retainRatio (blank = host default 0.16)",
				"advanced.language": "Language of this section",
				"advanced.language.auto": "Follow the DSH language",
				"advanced.language.zh": "简体中文",
				"advanced.language.en": "English",
				"advanced.own": "Who triggers automatic compaction",
				"advanced.own.auto": "Only when the threshold cannot be written to the backend config (default)",
				"advanced.own.always": "Always watch from this plugin too",
				"advanced.own.never": "Leave it to the compaction backend",
				"advanced.save": "Save advanced settings",
				"table.route": "Route / endpoint",
				"table.model": "Model",
				"table.configured": "Effective W",
				"table.reported": "Reported",
				"table.threshold": "Threshold",
				"table.status": "Status",
				"row.host.loopback": "loopback",
				"row.host.private": "LAN",
				"row.host.name-local": "local name",
				"row.host.public": "public",
				"row.host.other": "unknown",
				"row.noBase": "This route has no baseURL",
				"row.noModel": "This route declares no models",
				"state.matched": "in sync",
				"state.pending": "pending",
				"state.applied": "fixed {ago}",
				"state.pinned": "pinned at {value}",
				"state.unprobed": "not probed yet",
				"state.outOfScope": "out of probe scope",
				"state.mismatch": "endpoint serves another model ({echoed})",
				"state.noReport": "no answer ({detail})",
				"state.unreachable": "endpoint unreachable (server off? remaining candidates were skipped)",
				"state.identityUnverified": "fixed {ago} (endpoint did not echo the model)",
				"state.fallback": "current W is the host fallback 262144",
				"ago.seconds": "{n}s ago",
				"ago.minutes": "{n}min ago",
				"ago.hours": "{n}h ago",
				"ago.days": "{n}d ago",
				"audit.title": "Recent writes and probes",
				"audit.capacity": "{provider}/{model} ceiling {before} → {after} (reported {reported}, via {kind})",
				"audit.capacity_failed": "{provider}/{model} write failed: {code}",
				"audit.compaction": "compaction threshold written: ratio {ratio}{extra}",
				"audit.own": "self-triggered compaction: {provider}/{model} pressure {pressure} ≥ threshold {threshold}",
				"audit.cleared": "records cleared",
				"audit.empty": "no records yet",
				"meta.title": "State and files",
				"meta.line": "state: {state}　settings: {settings}　profile config: {patch}",
				"msg.probed": "probed {n} route(s)",
				"msg.applied": "wrote {provider}/{model}: {before} → {after}",
				"msg.appliedAll": "applied {n} change(s)",
				"msg.syncViaPatch": "backend config was written straight into the profile patch (that row is sealed inside an isolated group, out of configEditor's reach)",
				"msg.none": "every local route is already in sync",
				"msg.settingsSaved": "settings saved",
				"msg.reset": "settings restored to patch config / built-in defaults",
				"msg.cleared": "probe and write records cleared",
				"msg.rateLimited": "patch write budget for this hour is used up ({limit}/hour); try again later",
				"msg.tooSoon": "two patch writes too close together; try again shortly",
				"msg.pinned": "this target is pinned in `pins`, the plugin leaves it alone",
				"msg.retainConflict": "the retain setting is not below the threshold ratio, and the host rejects that pair: raise the ratio or clear retain first",
				"msg.noReportToApply": "no probe result for this target yet — press Probe first",
				"msg.writeOff": "\u201cpush the threshold into the compaction backend\u201d is off, so the ratio only counts when this plugin triggers itself",
				"msg.noEditor": "this profile has no configuration writer, so nothing can be persisted to the patch",
				"msg.rowMissing": "the configuration row to edit was not found (llm-pi-ai / compaction-basic is not mounted in this profile)",
				"msg.unknown": "operation failed: {detail}",
				"errors.loading": "loading…",
				"errors.fetch": "state unavailable (the host route may still be starting; it retries on its own)",
			},
		};

		// ---- 文案工具：zh 为 key 权威；带 {占位符} 的由代码填参数 ----
		function formatTemplate(template, params) {
			let text = String(template);
			for (const [key, value] of Object.entries(params || {})) {
				text = text.split(`{${key}}`).join(value === undefined || value === null ? "" : String(value));
			}
			return text;
		}

		function isSimplifiedChinese(tag) {
			const value = String(tag || "").trim().toLowerCase().replace(/_/g, "-");
			if (!value) return false;
			if (/^zh-(tw|hk|mo|cn-hant|hant)/.test(value)) return false;
			return value === "zh" || /^zh-(cn|sg|my|hans)/.test(value) || value.startsWith("zh-hans");
		}

		function detectLanguage(env) {
			for (const tag of env.languages || []) {
				if (isSimplifiedChinese(tag)) return "zh";
			}
			if (isSimplifiedChinese(env.language)) return "zh";
			if (isSimplifiedChinese(env.intlLocale)) return "zh";
			return "en";
		}

		function translate(dictionary, key, params) {
			const template = dictionary[key];
			if (typeof template !== "string") return null;
			return formatTemplate(template, params);
		}

		function localeEnv() {
			const env = { languages: [], language: "", intlLocale: "" };
			try {
				if (typeof navigator !== "undefined") {
					if (Array.isArray(navigator.languages)) env.languages = navigator.languages.slice();
					if (navigator.language) env.language = String(navigator.language);
				}
			} catch { /* 无 navigator：继续往下，最终兜底英文 */ }
			try {
				if (typeof Intl !== "undefined" && typeof Intl.DateTimeFormat === "function") {
					env.intlLocale = String((Intl.DateTimeFormat().resolvedOptions() || {}).locale || "");
				}
			} catch { /* 拿不到 Intl 就只用 navigator */ }
			return env;
		}

		/** 两条路对外同一个 tr()：框架给了 t 就用框架的（跟随 DSH 当前语言），没有就本地词典自己定语言。 */
		function makeLocale(ctxLocale) {
			let lang = detectLanguage(localeEnv());
			let override = "";
			let frameworkT = null;
			if (ctxLocale && typeof ctxLocale.bind === "function") {
				try {
					const bound = ctxLocale.bind(NS);
					if (typeof bound === "function") frameworkT = (key, params) => bound(key, params);
				} catch { /* 框架不接受 bind：退回本地词典，功能不降级 */ }
			}
			const self = {
				get lang() {
					return override || lang;
				},
				/** 宿主下发的语言口径："zh"/"en" 钉死，"auto"/空 = 跟随框架或本地判定。 */
				setOverride(value) {
					const next = String(value || "").trim().toLowerCase();
					override = LANGS.includes(next) ? next : "";
				},
				sync() {
					if (frameworkT) {
						try {
							const probe = frameworkT("lang.code", {});
							const code = String(probe || "").trim().toLowerCase();
							if (LANGS.includes(code)) lang = code;
							return;
						} catch { /* 框架词典没注册成功：退回本地判定 */ }
					}
					lang = detectLanguage(localeEnv());
				},
				tr(key, params) {
					const forced = override;
					if (forced && frameworkT && forced === lang) {
						const viaFramework = frameworkT(key, params);
						if (typeof viaFramework === "string" && viaFramework.length > 0 && viaFramework !== key) return viaFramework;
					}
					const useFramework = frameworkT && (!forced || forced === lang);
					if (useFramework) {
						const viaFramework = frameworkT(key, params);
						if (typeof viaFramework === "string" && viaFramework.length > 0 && viaFramework !== key) return viaFramework;
					}
					const dictionary = dictionaries[forced || lang] || dictionaries.en;
					const own = translate(dictionary, key, params);
					if (typeof own === "string") return own;
					const other = translate(dictionaries.en, key, params);
					return typeof other === "string" ? other : key;
				},
			};
			self.sync();
			return self;
		}

		const CSS = `
.dcg-root{display:grid;gap:14px;max-width:1120px;color:var(--dsw-alias-label-primary,#e6e6e6);font-size:13px;line-height:1.55}
.dcg-hint{margin:0;color:var(--dsw-alias-label-secondary,#9a9a9a);font-size:12.5px;line-height:1.6}
.dcg-card{border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#1c1c1e);padding:12px 14px;display:grid;gap:10px}
.dcg-card h3{margin:0;font-size:13.5px;font-weight:600;color:var(--dsw-alias-label-primary,#e6e6e6)}
.dcg-line{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dcg-label{flex:1;min-width:180px}
.dcg-label b{font-weight:600;display:block}
.dcg-label small{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11.5px;display:block;margin-top:2px}
.dcg-note{margin:0;color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11.5px;overflow-wrap:anywhere}
.dcg-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;overflow-wrap:anywhere}
.dcg-input{width:96px;background:var(--dsw-alias-bg-layer-3,#242426);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px}
.dcg-select{background:var(--dsw-alias-bg-layer-3,#242426);color:var(--dsw-alias-label-primary,#e6e6e6);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);border-radius:6px;padding:5px 7px;font:inherit;font-size:12px;max-width:100%}
.dcg-btn{background:var(--dsw-alias-button-info-fill,#4a8cff);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;padding:6px 11px;cursor:pointer;font:inherit;font-size:12px;white-space:nowrap}
.dcg-btn:disabled{opacity:.5;cursor:default}
.dcg-btn.ghost{background:transparent;border:1px solid var(--dsw-alias-border-l2,#3f3f3f);color:var(--dsw-alias-label-secondary,#a5a5a5)}
.dcg-switch{position:relative;display:inline-flex;flex:none;width:40px;height:22px;cursor:pointer}
.dcg-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}
.dcg-slider{width:100%;height:100%;border-radius:11px;background:var(--dsw-alias-bg-layer-3,#333);border:1px solid var(--dsw-alias-border-l2,#3a3a3a);transition:background .15s ease}
.dcg-slider::after{content:"";position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s ease}
.dcg-switch input:checked + .dcg-slider{background:var(--dsw-alias-state-business-primary,#408cff);border-color:transparent}
.dcg-switch input:checked + .dcg-slider::after{transform:translateX(18px)}
.dcg-switch input:disabled + .dcg-slider{opacity:.5}
.dcg-switch input:focus-visible + .dcg-slider{outline:2px solid var(--dsw-alias-state-business-primary,#408cff);outline-offset:2px}
.dcg-table{display:grid;gap:6px}
.dcg-thead,.dcg-row{display:grid;grid-template-columns:minmax(150px,1.35fr) minmax(120px,1.1fr) 92px minmax(140px,1.3fr) 96px minmax(160px,1.5fr);gap:8px;align-items:start}
.dcg-thead{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-size:11px;text-transform:none}
.dcg-cell{min-width:0;overflow-wrap:anywhere}
.dcg-cell.name b{font-weight:600;display:block}
.dcg-chip{display:inline-block;border-radius:5px;padding:1px 6px;font-size:11px;margin-right:4px;border:1px solid var(--dsw-alias-border-l2,#3a3a3a);color:var(--dsw-alias-label-secondary,#a5a5a5);background:var(--dsw-alias-bg-layer-2,#222)}
.dcg-chip.loopback{color:var(--dsw-alias-state-success-primary,#57b977);border-color:currentColor}
.dcg-chip.private{color:var(--dsw-alias-state-business-primary,#408cff);border-color:currentColor}
.dcg-chip.warn{color:#e8b15a;border-color:currentColor}
.dcg-chip.err{color:var(--dsw-alias-state-error-primary,#e2685f);border-color:currentColor}
.dcg-rowsep{border-top:1px solid var(--dsw-alias-border-l1,#2f2f2f);margin-top:2px}
.dcg-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:4px}
.dcg-msg{margin:0;font-size:12px;min-height:16px;color:var(--dsw-alias-label-secondary,#9a9a9a)}
.dcg-msg.err{color:var(--dsw-alias-state-error-primary,#e2685f)}
.dcg-msg.ok{color:var(--dsw-alias-state-success-primary,#57b977)}
.dcg-audit{display:grid;gap:4px;margin:0;padding:0;list-style:none}
.dcg-audit li{font-size:11.5px;color:var(--dsw-alias-label-secondary,#9a9a9a);overflow-wrap:anywhere}
@media (max-width:900px){.dcg-thead{display:none}.dcg-thead,.dcg-row{grid-template-columns:1fr;gap:2px}.dcg-cell{margin-bottom:6px}}
`;

		function fetchJson(path, init) {
			return fetch(API + path, {
				headers: { "content-type": "application/json" },
				...init,
			}).then((response) => response.json().catch(() => ({ ok: false, code: "bad_response" })));
		}

		function numberOrNull(raw) {
			const text = String(raw ?? "").trim();
			if (!text) return null;
			const value = Number(text);
			return Number.isFinite(value) ? value : Number.NaN;
		}

		function formatTokens(value) {
			if (value === null || value === undefined || !Number.isFinite(value)) return "—";
			return Math.round(value).toLocaleString("en-US");
		}

		function formatAgo(tr, at) {
			const ms = Number(at);
			if (!Number.isFinite(ms) || ms <= 0) return "";
			const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
			if (seconds < 60) return tr("ago.seconds", { n: seconds });
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return tr("ago.minutes", { n: minutes });
			const hours = Math.round(minutes / 60);
			if (hours < 24) return tr("ago.hours", { n: hours });
			return tr("ago.days", { n: Math.round(hours / 24) });
		}

		function statusOf(tr, row) {
			const chips = [];
			const hostKind = row.hostKind || "other";
			chips.push(h("span", { key: "host", className: `dcg-chip ${hostKind === "loopback" ? "loopback" : hostKind === "private" || hostKind === "name-local" ? "private" : ""}` }, tr(`row.host.${hostKind}`)));
			if (row.capacityIsHostFallback) chips.push(h("span", { key: "fallback", className: "dcg-chip warn" }, tr("state.fallback")));
			let detail = null;
			if (row.pinned !== null && row.pinned !== undefined) {
				detail = tr("state.pinned", { value: formatTokens(row.pinned) });
			} else if (!row.inScope) {
				detail = tr("state.outOfScope");
			} else if (!row.model) {
				detail = tr("row.noModel");
			} else if (!row.reportEndpoint && !row.reportAt) {
				detail = tr("state.unprobed");
			} else if (row.probeCode === "identity_mismatch") {
				detail = tr("state.mismatch", { echoed: row.reportEchoed || "?" });
			} else if (row.probeCode === "unreachable") {
				detail = tr("state.unreachable");
			} else if (row.probeCode) {
				const attempt = (row.probeAttempts || [])[0];
				detail = tr("state.noReport", { detail: attempt ? `${attempt.kind}:${attempt.note}` : row.probeCode });
			} else if (row.pendingApply) {
				detail = h("b", null, tr("state.pending"));
			} else if (row.appliedAt) {
				detail = tr(row.reportIdentity === "unverified" ? "state.identityUnverified" : "state.applied", { ago: formatAgo(tr, row.reportAt) });
			} else if (row.configuredCapacity !== null && row.reported === row.configuredCapacity) {
				detail = tr("state.matched");
			} else {
				detail = tr("state.matched");
			}
			return h("div", { className: "dcg-cell" }, chips, h("div", { className: "dcg-note" }, detail));
		}

		/** 审计列表：宿主按时间倒序下发，这里只渲染前 12 条；空列表给一条说明。 */
		function auditItems(tr, audit) {
			const list = Array.isArray(audit) ? audit.slice(0, 12) : [];
			if (list.length === 0) return [h("li", { key: "empty" }, tr("audit.empty"))];
			return list.map((entry, index) => h("li", { key: index }, `${entry && entry.at ? entry.at : ""}　${auditLine(tr, entry)}`));
		}

		function auditLine(tr, entry) {
			if (!entry || typeof entry !== "object") return "";
			if (entry.kind === "capacity_applied") {
				return tr("audit.capacity", {
					provider: entry.provider,
					model: entry.model,
					before: formatTokens(entry.before),
					after: formatTokens(entry.after),
					reported: formatTokens(entry.reported),
					kind: entry.kindLabel || entry.sourceKind || entry.endpoint || "?",
				});
			}
			if (entry.kind === "capacity_write_failed") return tr("audit.capacity_failed", { provider: entry.provider, model: entry.model, code: entry.code || "?" });
			if (entry.kind === "compaction_synced") {
				return tr("audit.compaction", {
					ratio: entry.thresholdRatio,
					extra: entry.headroomTokens === null || entry.headroomTokens === undefined ? "" : `, headroomTokens ${entry.headroomTokens}`,
				});
			}
			if (entry.kind === "own_compaction") {
				return tr("audit.own", { provider: entry.provider, model: entry.model, pressure: formatTokens(entry.pressure), threshold: formatTokens(entry.threshold) });
			}
			if (entry.kind === "cleared") return tr("audit.cleared");
			return `${entry.kind || "?"} ${entry.at || ""}`;
		}

		function messageFor(tr, payload, fallbackKey) {
			if (!payload) return { kind: "err", text: tr(fallbackKey || "msg.unknown", { detail: "" }) };
			if (payload.ok) return { kind: "ok", text: payload.text || "" };
			const code = String(payload.code || "");
			const key = {
				rate_limited: "msg.rateLimited",
				too_soon: "msg.tooSoon",
				pinned: "msg.pinned",
				retain_conflict: "msg.retainConflict",
				no_report_to_apply: "msg.noReportToApply",
				write_off: "msg.writeOff",
				no_config_editor: "msg.noEditor",
				row_missing: "msg.rowMissing",
				no_fields: "msg.unknown",
				bad_json_body: "msg.unknown",
				body_not_object: "msg.unknown",
				unknown_route: "msg.unknown",
				internal_error: "msg.unknown",
			}[code];
			return { kind: "err", text: tr(key || "msg.unknown", { detail: payload.error || code || "", limit: 10 }) };
		}

		function apply(ctx) {
			const ctxLocale = (() => {
				try {
					if (ctx && ctx.locale) return ctx.locale;
					if (ctx && typeof ctx.get === "function") return ctx.get("locale") || null;
				} catch {
					return null;
				}
				return null;
			})();
			if (ctxLocale && typeof ctxLocale.register === "function") {
				try {
					ctx.effect(() => ctxLocale.register(NS, { zh: dictionaries.zh, en: dictionaries.en }), "context-governor: dictionaries");
				} catch { /* 词典没注册成功：tr() 走本地兜底，内部 key 不外泄 */ }
			}
			const locale = makeLocale(ctxLocale);

			function Section() {
				const [data, setData] = React.useState(null);
				const [busy, setBusy] = React.useState(false);
				const [message, setMessage] = React.useState({ kind: "", text: "" });
				const [ratioDraft, setRatioDraft] = React.useState("");
				const [intervalDraft, setIntervalDraft] = React.useState("");
				const [timeoutDraft, setTimeoutDraft] = React.useState("");
				const [safetyDraft, setSafetyDraft] = React.useState("");
				const [headroomDraft, setHeadroomDraft] = React.useState("");
				const [retainDraft, setRetainDraft] = React.useState("");
				const refreshRef = React.useRef(null);
				const draftsSet = React.useRef(false);

				const tr = React.useCallback((key, params) => locale.tr(key, params), [locale]);

				const refresh = React.useCallback(() => {
					fetchJson("/state")
						.then((payload) => {
							if (!payload || payload.ok !== true) {
								setMessage((current) => (current.kind === "err" ? current : { kind: "err", text: tr("errors.fetch") }));
								return;
							}
							setData(payload);
							locale.setOverride(payload.language);
							locale.sync();
							if (!draftsSet.current && payload.settings) {
								draftsSet.current = true;
								setRatioDraft(String(payload.settings.thresholdRatio));
								setIntervalDraft(String(Math.round(payload.settings.probeIntervalMs / 1000)));
								setTimeoutDraft(String(payload.settings.probeTimeoutMs));
								setSafetyDraft(String(payload.settings.contextSafetyRatio));
								setHeadroomDraft(payload.settings.headroomTokens === null ? "" : String(payload.settings.headroomTokens));
								setRetainDraft(payload.settings.retainRatio === null ? "" : String(payload.settings.retainRatio));
							}
						})
						.catch(() => setMessage({ kind: "err", text: tr("errors.fetch") }));
				}, [tr]);

				refreshRef.current = refresh;

				React.useEffect(() => {
					refresh();
					const timer = window.setInterval(() => {
						const run = refreshRef.current;
						if (typeof run === "function") run();
					}, REFRESH_MS);
					let unsubscribe = null;
					if (ctxLocale && typeof ctxLocale.subscribe === "function") {
						try {
							unsubscribe = ctxLocale.subscribe(() => {
								locale.sync();
								const run = refreshRef.current;
								if (typeof run === "function") run();
							});
						} catch { /* 订阅失败：下次刷新时自然换语言 */ }
					}
					return () => {
						window.clearInterval(timer);
						if (typeof unsubscribe === "function") {
							try {
								unsubscribe();
							} catch { /* 解绑失败无所谓 */ }
						}
					};
				}, []);

				const post = React.useCallback((path, body, onOkKey, onOkParams) => {
					setBusy(true);
					setMessage({ kind: "", text: "" });
					return fetchJson(path, { method: "POST", body: JSON.stringify(body || {}) })
						.then((payload) => {
							if (payload && payload.ok) {
								if (payload.state) setData(payload.state);
								const params = { ...onOkParams, n: payload.reports ? payload.reports.length : 1 };
								// 保存成功但阈值没写进压缩后端（冲突 / 没有那条配置行）：把原因一起显示出来
								const syncProblem = payload.sync && payload.sync.ok === false ? messageFor(tr, payload.sync) : null;
								const syncNote = payload.sync && payload.sync.code === "applied_via_patch" ? tr("msg.syncViaPatch") : null;
								const okText = syncNote ? `${tr(onOkKey, params)} · ${syncNote}` : tr(onOkKey, params);
								setMessage(syncProblem ? { kind: "err", text: `${okText} · ${syncProblem.text}` } : { kind: "ok", text: okText });
							} else {
								if (payload && payload.state) setData(payload.state);
								setMessage(messageFor(tr, payload));
							}
							return payload;
						})
						.catch((err) => setMessage(messageFor({ ok: false, code: "internal_error", error: String((err && err.message) || err) })))
						.finally(() => setBusy(false));
				}, [tr]);

				const saveSettings = React.useCallback((patch, okKey, okParams) => {
					return post("/settings", patch, okKey, okParams);
				}, [post]);

				const toggle = (key, value) => saveSettings({ [key]: value }, "msg.settingsSaved");

				const saveRatio = () => {
					const value = numberOrNull(ratioDraft);
					const min = data && data.limits ? data.limits.ratioMin : 0.05;
					const max = data && data.limits ? data.limits.ratioMax : 0.99;
					if (!Number.isFinite(value) || value < min || value > max) {
						setMessage({ kind: "err", text: tr("threshold.invalid", { min, max }) });
						return;
					}
					saveSettings({ thresholdRatio: Math.round(value * 1000) / 1000 }, "threshold.saved", { ratio: value }).then(() => refresh());
				};

				const saveAdvanced = () => {
					const patch = {};
					const interval = numberOrNull(intervalDraft);
					if (Number.isFinite(interval) && interval >= 1) patch.probeIntervalMs = Math.round(interval * 1000);
					const timeout = numberOrNull(timeoutDraft);
					if (Number.isFinite(timeout) && timeout >= 200) patch.probeTimeoutMs = Math.round(timeout);
					const safety = numberOrNull(safetyDraft);
					if (Number.isFinite(safety) && safety >= 0.5 && safety <= 1) patch.contextSafetyRatio = safety;
					const headroom = numberOrNull(headroomDraft);
					if (headroom === null) patch.headroomTokens = null;
					else if (Number.isFinite(headroom) && headroom >= 0) patch.headroomTokens = Math.round(headroom);
					const retain = numberOrNull(retainDraft);
					if (retain === null) patch.retainRatio = null;
					else if (Number.isFinite(retain) && retain > 0 && retain < 1) patch.retainRatio = retain;
					saveSettings(patch, "msg.settingsSaved").then(() => refresh());
				};

				const applyAllPending = () => {
					const rows = ((data && data.rows) || []).filter((row) => row.pendingApply);
					if (rows.length === 0) {
						setMessage({ kind: "ok", text: tr("msg.none") });
						return;
					}
					setBusy(true);
					setMessage({ kind: "", text: "" });
					const run = async () => {
						let done = 0;
						let lastFailure = null;
						for (const row of rows) {
							const payload = await fetchJson("/apply", {
								method: "POST",
								body: JSON.stringify({ provider: row.provider, model: row.model, reported: row.reported, endpoint: row.reportEndpoint, kind: row.reportKind }),
							}).catch(() => ({ ok: false, code: "internal_error" }));
							if (payload && payload.state) setData(payload.state);
							if (payload && payload.ok) done += 1;
							else lastFailure = payload;
						}
						setBusy(false);
						if (lastFailure && done === 0) setMessage(messageFor(tr, lastFailure));
						else if (lastFailure) setMessage({ kind: "err", text: `${tr("msg.appliedAll", { n: done })} · ${messageFor(tr, lastFailure).text}` });
						else setMessage({ kind: "ok", text: tr("msg.appliedAll", { n: done }) });
					};
					void run();
				};

				if (!data) {
					return h(React.Fragment, null, h("style", null, CSS), h("div", { className: "dcg-root" }, h("p", { className: "dcg-hint" }, tr("errors.loading"))));
				}

				const settings = data.settings || {};
				const compaction = data.compaction || {};
				const rows = data.rows || [];
				const yes = (value) => (value ? "✓" : "✗");
				const pendingRows = rows.filter((row) => row.pendingApply);

				return h(
					"div",
					{ className: "dcg-root" },
					h("style", null, CSS),
					h("p", { className: "dcg-hint" }, tr("page.hint")),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("section.summary")),
						h("p", { className: "dcg-note" }, tr("summary.line", {
							ratio: settings.thresholdRatio,
							engine: compaction.engineMounted ? yes(true) : yes(false),
							own: yes(compaction.ownTriggerActive),
							editor: yes(compaction.editable),
						})),
						h("p", { className: "dcg-note" }, tr("summary.formula", {
							ratio: settings.thresholdRatio,
							headroom: settings.headroomTokens === null ? "65536" : settings.headroomTokens,
						})),
						h("p", { className: "dcg-note" }, tr("summary.formulaO")),
						compaction.via === "patch" ? h("p", { className: "dcg-note" }, tr("summary.viaPatch", {
							keys: compaction.writtenKeys && compaction.writtenKeys.length ? compaction.writtenKeys.join(" / ") : "—",
							ago: compaction.lastSyncAt && Number.isFinite(Date.parse(compaction.lastSyncAt)) ? formatAgo(tr, Date.parse(compaction.lastSyncAt)) : "—",
						})) : null,
						compaction.via === "editor" ? h("p", { className: "dcg-note" }, tr("summary.viaEditor", {
							keys: compaction.writtenKeys && compaction.writtenKeys.length ? compaction.writtenKeys.join(" / ") : "—",
							ago: compaction.lastSyncAt && Number.isFinite(Date.parse(compaction.lastSyncAt)) ? formatAgo(tr, Date.parse(compaction.lastSyncAt)) : "—",
						})) : null,
						compaction.editable ? null : h("p", { className: "dcg-note" }, tr("summary.noEditor")),
						compaction.engineMounted ? null : h("p", { className: "dcg-note" }, tr("summary.noEngine")),
						pendingRows.length > 0 ? h("p", { className: "dcg-note" }, h("b", null, tr("summary.pending", { n: pendingRows.length }))) : null,
					),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("card.switch")),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("switch.enabled")), h("small", null, tr("switch.enabled.alias"))),
							h("label", { className: "dcg-switch" },
								h("input", { type: "checkbox", role: "switch", "aria-checked": String(!!settings.enabled), checked: !!settings.enabled, disabled: busy, onChange: (event) => toggle("enabled", event.target.checked) }),
								h("span", { className: "dcg-slider" }),
							),
						),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("switch.autoFix")), h("small", null, tr("switch.autoFix.alias"))),
							h("label", { className: "dcg-switch" },
								h("input", { type: "checkbox", role: "switch", "aria-checked": String(!!settings.autoFixContextWindow), checked: !!settings.autoFixContextWindow, disabled: busy, onChange: (event) => toggle("autoFixContextWindow", event.target.checked) }),
								h("span", { className: "dcg-slider" }),
							),
						),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("switch.writeCompaction")), h("small", null, tr("switch.writeCompaction.alias"))),
							h("label", { className: "dcg-switch" },
								h("input", { type: "checkbox", role: "switch", "aria-checked": String(!!settings.writeCompactionConfig), checked: !!settings.writeCompactionConfig, disabled: busy, onChange: (event) => toggle("writeCompactionConfig", event.target.checked) }),
								h("span", { className: "dcg-slider" }),
							),
						),
					),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("card.threshold")),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("threshold.ratio")), h("small", null, tr("threshold.ratioHint"))),
							h("input", { className: "dcg-input", type: "number", step: "0.01", min: "0.05", max: "0.99", value: ratioDraft, disabled: busy, onChange: (event) => setRatioDraft(event.target.value) }),
							h("button", { className: "dcg-btn", type: "button", disabled: busy, onClick: saveRatio }, busy ? tr("action.saving") : tr("threshold.save")),
						),
					),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("card.probe")),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("probe.scope"))),
							h("select", {
								className: "dcg-select",
								disabled: busy,
								value: settings.probeScope,
								onChange: (event) => saveSettings({ probeScope: event.target.value }, "msg.settingsSaved"),
							},
								...["loopback-private", "loopback", "any"].map((value) => h("option", { key: value, value }, tr(`probe.scope.${value}`))),
							),
						),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("advanced.own"))),
							h("select", {
								className: "dcg-select",
								disabled: busy,
								value: settings.ownPressureTrigger,
								onChange: (event) => saveSettings({ ownPressureTrigger: event.target.value }, "msg.settingsSaved"),
							},
								...["auto", "always", "never"].map((value) => h("option", { key: value, value }, tr(`advanced.own.${value}`))),
							),
						),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("probe.interval"))),
							h("input", { className: "dcg-input", type: "number", min: "1", step: "1", value: intervalDraft, disabled: busy, onChange: (event) => setIntervalDraft(event.target.value) }),
							h("span", { className: "dcg-label" }, h("b", null, tr("probe.timeout"))),
							h("input", { className: "dcg-input", type: "number", min: "200", step: "100", value: timeoutDraft, disabled: busy, onChange: (event) => setTimeoutDraft(event.target.value) }),
						),
						h("div", { className: "dcg-actions" },
							h("button", { className: "dcg-btn", type: "button", disabled: busy, onClick: () => post("/probe", {}, "msg.probed") }, tr("action.probeAll")),
							h("button", { className: "dcg-btn", type: "button", disabled: busy, onClick: applyAllPending }, tr("action.applyPending")),
							h("button", { className: "dcg-btn ghost", type: "button", disabled: busy, onClick: () => post("/reset", {}, "msg.reset") }, tr("action.reset")),
							h("button", { className: "dcg-btn ghost", type: "button", disabled: busy, onClick: () => post("/clear", {}, "msg.cleared") }, tr("action.clear")),
							h("button", { className: "dcg-btn ghost", type: "button", disabled: busy, onClick: () => { draftsSet.current = false; refresh(); } }, tr("action.refresh")),
						),
					),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("card.advanced")),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("probe.safety"))),
							h("input", { className: "dcg-input", type: "number", min: "0.5", max: "1", step: "0.01", value: safetyDraft, disabled: busy, onChange: (event) => setSafetyDraft(event.target.value) }),
							h("span", { className: "dcg-label" }, h("b", null, tr("advanced.headroom"))),
							h("input", { className: "dcg-input", type: "number", min: "0", step: "1024", value: headroomDraft, disabled: busy, onChange: (event) => setHeadroomDraft(event.target.value) }),
						),
						h("p", { className: "dcg-note" }, tr("probe.safetyHint")),
						h("div", { className: "dcg-line" },
							h("span", { className: "dcg-label" }, h("b", null, tr("advanced.retainRatio"))),
							h("input", { className: "dcg-input", type: "number", min: "0.01", max: "0.95", step: "0.01", value: retainDraft, disabled: busy, onChange: (event) => setRetainDraft(event.target.value) }),
							h("span", { className: "dcg-label" }, h("b", null, tr("advanced.language"))),
							h("select", {
								className: "dcg-select",
								disabled: busy,
								value: settings.language,
								onChange: (event) => saveSettings({ language: event.target.value }, "msg.settingsSaved").then(() => {
									locale.setOverride(event.target.value);
									locale.sync();
								}),
							},
								...["auto", "zh", "en"].map((value) => h("option", { key: value, value }, tr(`advanced.language.${value}`))),
							),
						),
						h("div", { className: "dcg-actions" }, h("button", { className: "dcg-btn", type: "button", disabled: busy, onClick: saveAdvanced }, tr("advanced.save"))),
					),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("table.route")),
						h("div", { className: "dcg-table" },
							h("div", { className: "dcg-thead" },
								...[tr("table.route"), tr("table.model"), tr("table.configured"), tr("table.reported"), tr("table.threshold"), tr("table.status")].map((label, index) => h("span", { key: index }, label)),
							),
							rows.length === 0 ? h("p", { className: "dcg-note" }, tr("row.noModel")) : null,
							...rows.map((row, index) => h(
								"div",
								{ key: `${row.provider}|${row.model}|${index}`, className: "dcg-row" },
								h("div", { className: "dcg-cell name" }, h("b", null, row.displayName || row.provider), h("div", { className: "dcg-mono" }, row.baseURL || tr("row.noBase"))),
								h("div", { className: "dcg-cell dcg-mono" }, row.model || "—"),
								h("div", { className: "dcg-cell" }, formatTokens(row.configuredCapacity)),
								h("div", { className: "dcg-cell" }, formatTokens(row.reported), h("div", { className: "dcg-mono" }, row.reportEndpoint ? `${row.reportKind} · ${formatAgo(tr, row.reportAt)}` : "")),
								h("div", { className: "dcg-cell" }, formatTokens(row.thresholdTokens)),
								h("div", { className: "dcg-cell" },
									statusOf(tr, row),
									h("div", { className: "dcg-actions" },
										h("button", {
											className: "dcg-btn ghost",
											type: "button",
											disabled: busy || !row.inScope || !row.model,
											onClick: () => post("/probe", { provider: row.provider, model: row.model }, "msg.probed"),
										}, tr("action.probeOne")),
										h("button", {
											className: "dcg-btn",
											type: "button",
											disabled: busy || !row.pendingApply,
											onClick: () => post("/apply", { provider: row.provider, model: row.model, reported: row.reported, endpoint: row.reportEndpoint, kind: row.reportKind }, "msg.applied", { provider: row.provider, model: row.model, before: formatTokens(row.configuredCapacity), after: formatTokens(row.reported) }),
										}, tr("action.applyOne")),
									),
								),
								index < rows.length - 1 ? h("div", { key: "sep", className: "dcg-rowsep" }) : null,
							)),
						),
					),
					h("div", { className: "dcg-card" },
						h("h3", null, tr("audit.title")),
						h("ul", { className: "dcg-audit" },
							...auditItems(tr, data.audit),
						),
						h("p", { className: "dcg-note" }, tr("meta.line", {
							state: (data.paths || {}).stateFile || "",
							settings: (data.paths || {}).settingsFile || "",
							patch: (data.paths || {}).patchFile || "?",
						})),
					),
					message.text ? h("p", { className: `dcg-msg ${message.kind}`, role: "status" }, message.text) : null,
				);
			}

			ctx.effect(
				() => ctx.slots.inject("settings.section", () => ctx.slots.register(
					{
						name: "settings.section",
						id: "context-governor",
						order: 64,
						...(ctxLocale ? { locale: NS } : {}),
						label: () => locale.tr("nav.title"),
					},
					() => h(Section),
				)),
				"context-governor: settings section",
			);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
