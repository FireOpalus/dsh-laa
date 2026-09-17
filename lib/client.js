// dsh-laa —— 浏览器端（client bundle）
//
// 一个滑动开关：左边是轨道 + 圆钮，右边是 "LAA" 标签，单击即切换当前会话的
// LAA 模式。开关状态、当前峰谷时段、下一次切换、待恢复的输入条数都来自宿主插件
// 的 HTTP 控制面（/dsh-laa/state、/dsh-laa/mode），因此命令 /laa、开关、状态文件
// 三者永远说同一件事。
//
// 同一个开关注册进两个插槽，于是页面上任何时刻都恰好有一个：
//
// - conversation.session.header.utilities —— 会话页顶栏右侧的常驻位置；
// - conversation.input.left —— 输入框工具行的左侧。DSH 在新会话（还没有第一条
//   消息）时会把整条顶栏藏起来，新对话页因此没有顶栏可挂，这一份就补上那个空档；
//   它只在顶栏确实不显示的时候渲染。
//
// 本文件是打包产物格式的浏览器 bundle：注册到 window.__ModuleLoader__，工厂函数
// 内通过 require() 解析平台种子模块（react 等），与官方 dsh-client-* 包发布的
// client.js 结构一致。它是手写的纯 ESM，没有构建步骤，也没有 JSX——所以统一用
// React.createElement。
window.__ModuleLoader__.load({
	id: "dsh-laa",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/**
		 * 顶栏的显隐规则属于 conversation 包——新会话还没有第一条消息时，它把整条
		 * header 藏起来（ui-conversation 的 `ConversationSessionHeader`）。这里直接
		 * 问它要那个判定函数，而不是在插件里抄一份规则：规则变了开关也不会跑到两处。
		 *
		 * `dsh.client.inject` 已经声明了这个依赖，正常情况下 require 一定拿得到；
		 * 拿不到（组合里没有会话 UI，或将来改了导出）就退回 `session.blank` 这个
		 * 保守判断——最坏也只是在第一轮真正开始前的一瞬间多显示一个开关。
		 */
		const conversationUi = (() => {
			try {
				return require("@deepseek-ai/dsh-client-ui-conversation");
			} catch (error) {
				return undefined;
			}
		})();
		const conversationPhase = conversationUi !== null && typeof conversationUi === "object" && typeof conversationUi.conversationPhase === "function"
			? conversationUi.conversationPhase
			: undefined;

		//#region 文案
		/** 字典命名空间：注册到 ctx.locale 后，插槽会把 t() 作为 prop 交给组件。 */
		const NS = "dsh-laa";
		const zh = {
			aria: "LAA 模式（DeepSeek 峰时停机、谷时续跑）",
			label: "LAA",
			loading: "LAA …",
			on: "LAA 已开启",
			off: "LAA 已关闭",
			peak: "峰时 · 已暂停",
			valley: "谷时 · 运行中",
			clickOn: "单击开启 LAA 模式",
			clickOff: "单击关闭 LAA 模式",
			phase: "当前时段",
			next: "下一次切换",
			windows: "峰时窗口",
			pending: "等待谷时",
			interrupted: "1 个被中断的轮次",
			deferredUnit: " 条暂存输入",
			peakName: "峰时",
			valleyName: "谷时",
			follow: "跟随父会话",
			exempt: "峰时不会阻塞：这个提供方不按峰谷计费",
			flipPeakTitle: "LAA · 进入峰时",
			flipValleyTitle: "LAA · 进入谷时",
			flipPeakBody: "会话已暂停，新的输入会暂存到谷时。",
			flipValleyBody: "会话恢复运行，暂存的输入开始投递。",
			unreachable: "连不上 dsh-laa 控制面",
			failed: "切换失败",
			disabled: "dsh-laa 已被配置禁用（enabled: false）",
		};
		const en = {
			aria: "LAA mode (pauses during DeepSeek peak hours, resumes off-peak)",
			label: "LAA",
			loading: "LAA …",
			on: "LAA is on",
			off: "LAA is off",
			peak: "peak · paused",
			valley: "off-peak · running",
			clickOn: "Click to turn LAA mode on",
			clickOff: "Click to turn LAA mode off",
			phase: "DeepSeek window",
			next: "Next change",
			windows: "Peak windows",
			pending: "Waiting for off-peak",
			interrupted: "1 interrupted turn",
			deferredUnit: " deferred input(s)",
			peakName: "peak",
			valleyName: "off-peak",
			follow: "Follows parent session",
			exempt: "Not held during peak: this provider has no peak pricing",
			flipPeakTitle: "LAA · peak window started",
			flipValleyTitle: "LAA · off-peak window started",
			flipPeakBody: "The session is paused; new input is held until the off-peak window.",
			flipValleyBody: "The session is running again; held input is being delivered.",
			unreachable: "dsh-laa control plane is unreachable",
			failed: "Could not switch LAA mode",
			disabled: "dsh-laa is disabled by its enabled: false config",
		};
		const FALLBACK = zh;
		//#endregion

		//#region 样式
		/** 组件的全部样式。注入为单个 <style>，随插件卸载一起移除。 */
		const STYLE = [
			".laa-toggle{display:inline-flex;align-items:center;gap:7px;padding:2px 4px;border:0;border-radius:999px;background:transparent;color:inherit;font:inherit;line-height:1;cursor:pointer;-webkit-user-select:none;user-select:none}",
			".laa-toggle:disabled{cursor:default;opacity:.55}",
			".laa-toggle:not(:disabled):hover{background:color-mix(in srgb,currentColor 10%,transparent)}",
			".laa-toggle:focus-visible{outline:2px solid color-mix(in srgb,currentColor 45%,transparent);outline-offset:2px}",
			".laa-toggle-track{position:relative;display:block;flex:none;width:36px;height:20px;border-radius:999px;background:color-mix(in srgb,currentColor 28%,transparent);transition:background .18s ease}",
			".laa-toggle-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.35);transition:transform .18s cubic-bezier(.3,.8,.4,1)}",
			".laa-toggle.is-on .laa-toggle-track{background:#2f9e6e}",
			".laa-toggle.is-on .laa-toggle-knob{transform:translateX(16px)}",
			".laa-toggle.is-peak .laa-toggle-track{background:#d08b2c}",
			".laa-toggle-label{font-size:11px;font-weight:600;letter-spacing:.08em;opacity:.72;white-space:nowrap}",
			".laa-toggle.is-on .laa-toggle-label{opacity:1}",
			".laa-toggle.is-busy .laa-toggle-knob{animation:laa-pulse 1s ease-in-out infinite}",
			"@keyframes laa-pulse{50%{opacity:.5}}",
			/* 峰谷切换：先跳三下，同时把轨道颜色（绿 <-> 琥珀）平滑地推过去。 */
			".laa-toggle.is-flipping{animation:laa-hop .42s cubic-bezier(.34,1.56,.64,1) 3}",
			"@keyframes laa-hop{0%,100%{transform:translateY(0)}35%{transform:translateY(-3px)}70%{transform:translateY(0)}}",
			".laa-toggle.is-flipping .laa-toggle-track{box-shadow:0 0 0 3px color-mix(in srgb,currentColor 20%,transparent);transition:background 1.26s ease-in-out,box-shadow 1.26s ease-in-out}",
			"@media (prefers-reduced-motion:reduce){.laa-toggle.is-flipping{animation:none}}",
		].join("");
		//#endregion

		//#region 峰谷切换
		/** 切换动画的时长（毫秒），与 CSS 里 laa-hop 的三跳（3 × .42s）对齐。 */
		const FLIP_WINDOW_MS = 1300;
		/** 边界对齐的余量：宿主在边界之后约 1 秒重新评估，这里再晚一点去问。 */
		const BOUNDARY_MARGIN_MS = 2000;
		/** 边界定时器的上限：再远也先按这个间隔醒一次，不挂一个超长 timeout。 */
		const BOUNDARY_MAX_MS = 1800000;
		/** 兜底轮询间隔：标签页/系统休眠之后靠它把错过的切换追平。 */
		const POLL_MS = 20000;
		//#endregion

		//#region 组件
		/** 一行 "键：值"，只在值存在时渲染。 */
		function line(t, key, value) {
			return value ? t(key) + "：" + value : "";
		}

		/**
		 * 子会话的开关跟随父会话，提示里要说清楚跟的是哪一个。
		 *
		 * 会话名册里查得到显示标题就用「标题（id）」，查不到就退回 id——无论哪条路，
		 * 提示里出现的都是一个对得上的身份。
		 * @param state - 控制面快照；`inheritedFrom` 非空时说明这是子会话。
		 * @param sessions - 会话名册（标准 Hook 给出，可能缺席）。
		 */
		function followLabel(state, sessions) {
			if (state === null || state.inheritedFrom === null || state.inheritedFrom === undefined) return "";
			const id = String(state.inheritedFrom);
			const summary = sessions !== undefined && sessions !== null && sessions.byId !== undefined ? sessions.byId[id] : undefined;
			const title = summary !== undefined && summary !== null && typeof summary.displayTitle === "string" && summary.displayTitle.length > 0 ? summary.displayTitle : "";
			return title === "" || title === id ? id : title + "（" + id + "）";
		}

		/** 浏览器通知 API；缺席（非浏览器环境、被策略禁用）时返回 undefined。 */
		function notificationApi() {
			return typeof Notification === "function" ? Notification : undefined;
		}

		/**
		 * 申请一次通知权限。
		 *
		 * 浏览器普遍要求用户手势，所以只在用户点开关的时候问；已经问过（granted /
		 * denied）就是空操作，失败也静默——通知只是锦上添花，不能影响开关本身。
		 */
		function askNotificationPermission() {
			const api = notificationApi();
			if (api === undefined || api.permission !== "default" || typeof api.requestPermission !== "function") return;
			try {
				const pending = api.requestPermission();
				if (pending !== undefined && pending !== null && typeof pending.catch === "function") pending.catch(() => {});
			} catch (error) {
				/* 浏览器拒绝在没有手势时询问：忽略 */
			}
		}

		/**
		 * 峰谷切换时弹一条浏览器通知。
		 *
		 * 策略来自宿主快照里的 `notify`：`enabled`（默认，只有该会话开着 LAA 时才
		 * 通知）、`always`、`off`。没有 API、没有权限、构造失败都静默跳过。
		 * @param state - 控制面快照。
		 * @param t - 翻译函数。
		 * @returns 创建出来的通知，或什么都没做时的 undefined。
		 */
		function notifyFlip(state, t) {
			const api = notificationApi();
			if (api === undefined || api.permission !== "granted") return undefined;
			const policy = state.notify === undefined || state.notify === null ? "enabled" : String(state.notify);
			if (policy === "off") return undefined;
			if (policy !== "always" && state.enabled !== true) return undefined;
			const peak = state.phase === "peak";
			try {
				return new api(peak ? t("flipPeakTitle") : t("flipValleyTitle"), {
					body: peak ? t("flipPeakBody") : t("flipValleyBody"),
					/* 同一个会话的播报互相顶替，不堆一屏旧通知。 */
					tag: "dsh-laa:" + state.sessionId,
				});
			} catch (error) {
				return undefined;
			}
		}

		/** 把控制面返回的快照拼成悬停提示；信息都来自宿主，前端不做第二套判断。 */
		function renderTitle(state, t, follow) {
			if (state === null) return t("loading");
			const rows = [
				state.enabled ? t("on") : t("off"),
				state.masterEnabled === false ? t("disabled") : "",
				line(t, "follow", follow),
				/* 只有按峰谷计费的提供方才受峰时约束：别的路由要说明白，免得以为插件坏了。 */
				state.peakBilled === false
					? t("exempt") + (state.provider === null || state.provider === undefined || state.provider === "" ? "" : "（" + state.provider + "）")
					: "",
				line(t, "phase", (state.phase === "peak" ? t("peakName") : t("valleyName")) + "（" + state.localNow + "）"),
				line(t, "next", (state.phase === "peak" ? t("valleyName") : t("peakName")) + " " + state.localNextChange),
				line(t, "windows", state.peakWindows + "（" + state.timeZone + "）"),
				state.deferred > 0 || state.suspended
					? t("pending") + "：" + (state.suspended ? t("interrupted") : "") + (state.suspended && state.deferred > 0 ? "、" : "") + (state.deferred > 0 ? state.deferred + t("deferredUnit") : "")
					: "",
				state.masterEnabled === false ? "" : (state.enabled ? t("clickOff") : t("clickOn")),
			];
			return rows.filter((row) => row.length > 0).join("\n");
		}

		/**
		 * LAA 滑动开关（顶栏与新对话页共用同一份实现）。
		 * @param props - 插槽注入：`sessionId`（会话作用域）、`t`（locale 字典），
		 *   以及作用域标准 Hook（`useSessions` 用来把父会话的 id 显示成标题）。
		 */
		function LaaToggle(props) {
			const sessionId = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : "";
			const t = props && typeof props.t === "function" ? props.t : (key) => FALLBACK[key] !== undefined ? FALLBACK[key] : key;
			const sessions = props && typeof props.useSessions === "function" ? props.useSessions((value) => value) : undefined;
			const [state, setState] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");
			/** 正在播放切换动画的相位（null 表示没在播）。 */
			const [flip, setFlip] = react.useState(null);
			/** 上一次看到的相位；null 表示还没见过（第一次不算切换）。 */
			const lastPhase = react.useRef(null);
			const flipTimer = react.useRef(null);

			const apply = react.useCallback((body) => {
				if (!body || !body.ok) {
					setError(body && body.error ? String(body.error) : t("failed"));
					return;
				}
				const value = body.value;
				const previous = lastPhase.current;
				lastPhase.current = value.phase;
				if (previous !== null && previous !== value.phase) {
					/* 峰谷真的翻过去了：跳三下 + 轨道平滑变色，再弹一条浏览器通知。 */
					setFlip(value.phase);
					notifyFlip(value, t);
					if (flipTimer.current !== null) clearTimeout(flipTimer.current);
					flipTimer.current = setTimeout(() => {
						flipTimer.current = null;
						setFlip(null);
					}, FLIP_WINDOW_MS);
				}
				setState(value);
				setError("");
			}, [t]);

			/** 取一次状态；成功时把快照交回去，好让调用方按宿主的边界对表。 */
			const refresh = react.useCallback(() => {
				if (sessionId === "") return Promise.resolve(undefined);
				return fetch("/dsh-laa/state?sessionId=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
					.then((res) => res.json())
					.then((body) => {
						apply(body);
						return body && body.ok ? body.value : undefined;
					})
					.catch(() => {
						setError(t("unreachable"));
						return undefined;
					});
			}, [sessionId, apply, t]);

			react.useEffect(() => {
				let boundary = null;
				let cancelled = false;
				const clearBoundary = () => {
					if (boundary !== null) {
						clearTimeout(boundary);
						boundary = null;
					}
				};
				/*
				 * 峰谷边界由宿主判定（快照里的 nextChangeAt 就是下一个边界），这里不在前端
				 * 自己算第二套时间：拿到快照就按宿主给的边界精确等一次，同时留一个低频
				 * 兜底轮询，把标签页/系统休眠期间错过的切换追平。
				 */
				const pull = () => {
					refresh().then((value) => {
						if (cancelled || value === undefined || value === null) return;
						clearBoundary();
						const wait = Math.max(1000, Math.min(value.nextChangeAt + BOUNDARY_MARGIN_MS - Date.now(), BOUNDARY_MAX_MS));
						boundary = setTimeout(pull, wait);
					});
				};
				pull();
				const timer = setInterval(pull, POLL_MS);
				return () => {
					cancelled = true;
					clearBoundary();
					clearInterval(timer);
				};
			}, [refresh]);

			/* 卸载时别把切换动画的定时器留在身后。 */
			react.useEffect(() => () => {
				if (flipTimer.current !== null) clearTimeout(flipTimer.current);
			}, []);

			const toggle = react.useCallback(() => {
				if (busy || sessionId === "" || state === null || state.masterEnabled === false) return;
				/* 正好是一次用户手势：顺手申请通知权限，好在峰谷切换时提醒。 */
				askNotificationPermission();
				setBusy(true);
				fetch("/dsh-laa/mode", {
					method: "POST",
					headers: { "content-type": "application/json", accept: "application/json" },
					body: JSON.stringify({ sessionId, enabled: !state.enabled }),
				})
					.then((res) => res.json())
					.then(apply)
					.catch(() => setError(t("unreachable")))
					.finally(() => setBusy(false));
			}, [busy, sessionId, state, apply, t]);

			const enabled = state !== null && state.enabled === true;
			const peak = enabled && state.phase === "peak";
			const className = ["laa-toggle", enabled ? "is-on" : "", peak ? "is-peak" : "", busy ? "is-busy" : "", flip !== null ? "is-flipping" : ""].filter((part) => part.length > 0).join(" ");
			const disabled = busy || state === null || sessionId === "" || state.masterEnabled === false;

			return react.createElement("button", {
				type: "button",
				className,
				role: "switch",
				"aria-checked": enabled,
				"aria-label": t("aria"),
				"aria-busy": busy,
				title: error === "" ? renderTitle(state, t, followLabel(state, sessions)) : error,
				disabled,
				onClick: toggle,
				"data-laa-session": sessionId,
				"data-laa-phase": state === null ? "" : state.phase,
				"data-laa-flip": flip === null ? "" : flip,
			}, [
				react.createElement("span", { className: "laa-toggle-track", key: "track" },
					react.createElement("span", { className: "laa-toggle-knob" })),
				react.createElement("span", { className: "laa-toggle-label", key: "label" }, t("label")),
			]);
		}

		/**
		 * 顶栏此刻是否被藏着——也就是「新对话页」。
		 *
		 * 判据与 ui-conversation 渲染顶栏时用的那一条完全相同；能拿到宿主的
		 * `conversationPhase` 时它就是这么算的，拿不到时退回 `session.blank`。
		 * @param session - 会话作用域标准 Hook 给出的会话快照，可能缺席。
		 * @param conversation - 同一份标准 Hook 给出的 conversation 快照，可能缺席。
		 * @returns 顶栏被藏起来、需要在输入框里补一个开关时为 true。
		 */
		function headerHidden(session, conversation) {
			if (session === undefined || session === null || session.blank !== true) return false;
			if (conversationPhase === undefined || conversation === undefined || conversation === null) return true;
			try {
				return conversationPhase(session, conversation) === "blank";
			} catch (error) {
				return true;
			}
		}

		/**
		 * 输入框工具行里的那一份开关：只在顶栏被藏起来（新对话页）时出场。
		 *
		 * `useSession` / `useConversation` 是插槽按 session 作用域发给每个条目的标准
		 * Hook，可用性由插槽决定、渲染期间不会变，所以下面的条件调用不会破坏 Hook
		 * 顺序。宿主没给（理论上不会发生）时按「顶栏在」处理：宁可不显示，也不在
		 * 顶栏已经有一个开关的时候再画第二个。
		 * @param props - 与顶栏开关相同的插槽注入，外加作用域标准 Hook。
		 */
		function LaaComposerToggle(props) {
			const useSession = props !== null && typeof props === "object" && typeof props.useSession === "function" ? props.useSession : undefined;
			const useConversation = props !== null && typeof props === "object" && typeof props.useConversation === "function" ? props.useConversation : undefined;
			const session = useSession === undefined ? undefined : useSession((value) => value);
			const conversation = useConversation === undefined ? undefined : useConversation((value) => value);
			if (!headerHidden(session, conversation)) return null;
			return react.createElement(LaaToggle, props);
		}
		//#endregion

		//#region 插件入口
		/** 所需服务：插槽注册表与多语言字典。 */
		const inject = ["slots", "locale"];

		/**
		 * 浏览器端插件主体：注入样式与字典，并把开关注册进会话顶栏工具区与输入框
		 * 工具行（后者只在新对话页出场，见 {@link LaaComposerToggle}）。
		 * @param ctx - 客户端上下文。
		 */
		function apply(ctx) {
			ctx.effect(() => {
				const style = document.createElement("style");
				style.setAttribute("data-plugin", "dsh-laa");
				style.textContent = STYLE;
				document.head.append(style);
				return () => { style.remove(); };
			}, "dsh-laa: styles");

			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-laa: dictionaries");

			ctx.effect(() => ctx.slots.inject("conversation.session.header.utilities", () => {
				const dispose = ctx.slots.register({
					name: "conversation.session.header.utilities",
					id: "dsh-laa",
					order: 95,
					locale: NS,
					inject: (sessionId) => ({ sessionId }),
				}, LaaToggle);
				return () => { dispose(); };
			}), "dsh-laa: session header toggle");

			/* 新会话（新对话页）没有顶栏，这一份让开关在新对话页也够得着。 */
			ctx.effect(() => ctx.slots.inject("conversation.input.left", () => {
				const dispose = ctx.slots.register({
					name: "conversation.input.left",
					id: "dsh-laa",
					order: 95,
					locale: NS,
					inject: (sessionId) => ({ sessionId }),
				}, LaaComposerToggle);
				return () => { dispose(); };
			}), "dsh-laa: composer toggle");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
