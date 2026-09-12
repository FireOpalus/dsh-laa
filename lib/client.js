// dsh-laa —— 浏览器端（client bundle）
//
// 会话页顶栏工具区（conversation.session.header.utilities 插槽）里的一个滑动开关：
// 左边是轨道 + 圆钮，右边是 "LAA" 标签，单击即切换当前会话的 LAA 模式。
// 开关状态、当前峰谷时段、下一次切换、待恢复的输入条数都来自宿主插件的
// HTTP 控制面（/dsh-laa/state、/dsh-laa/mode），因此命令 /laa、开关、状态文件
// 三者永远说同一件事。
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
		].join("");
		//#endregion

		//#region 组件
		/** 一行 "键：值"，只在值存在时渲染。 */
		function line(t, key, value) {
			return value ? t(key) + "：" + value : "";
		}

		/** 把控制面返回的快照拼成悬停提示；信息都来自宿主，前端不做第二套判断。 */
		function renderTitle(state, t) {
			if (state === null) return t("loading");
			const rows = [
				state.enabled ? t("on") : t("off"),
				state.masterEnabled === false ? t("disabled") : "",
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
		 * 会话页顶栏的 LAA 滑动开关。
		 * @param props - 插槽注入：`sessionId`（会话作用域）与 `t`（locale 字典）。
		 */
		function LaaToggle(props) {
			const sessionId = props && props.sessionId !== undefined && props.sessionId !== null ? String(props.sessionId) : "";
			const t = props && typeof props.t === "function" ? props.t : (key) => FALLBACK[key] !== undefined ? FALLBACK[key] : key;
			const [state, setState] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const [error, setError] = react.useState("");

			const apply = react.useCallback((body) => {
				if (body && body.ok) {
					setState(body.value);
					setError("");
				} else {
					setError(body && body.error ? String(body.error) : t("failed"));
				}
			}, [t]);

			const refresh = react.useCallback(() => {
				if (sessionId === "") return;
				fetch("/dsh-laa/state?sessionId=" + encodeURIComponent(sessionId), { headers: { accept: "application/json" } })
					.then((res) => res.json())
					.then(apply)
					.catch(() => setError(t("unreachable")));
			}, [sessionId, apply, t]);

			react.useEffect(() => {
				refresh();
				/* 峰谷边界由宿主判定，这里只做低频率的对齐刷新，避免前端自己算出第二套时间。 */
				const timer = setInterval(refresh, 20000);
				return () => clearInterval(timer);
			}, [refresh]);

			const toggle = react.useCallback(() => {
				if (busy || sessionId === "" || state === null || state.masterEnabled === false) return;
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
			const className = ["laa-toggle", enabled ? "is-on" : "", peak ? "is-peak" : "", busy ? "is-busy" : ""].filter((part) => part.length > 0).join(" ");
			const disabled = busy || state === null || sessionId === "" || state.masterEnabled === false;

			return react.createElement("button", {
				type: "button",
				className,
				role: "switch",
				"aria-checked": enabled,
				"aria-label": t("aria"),
				"aria-busy": busy,
				title: error === "" ? renderTitle(state, t) : error,
				disabled,
				onClick: toggle,
				"data-laa-session": sessionId,
				"data-laa-phase": state === null ? "" : state.phase,
			}, [
				react.createElement("span", { className: "laa-toggle-track", key: "track" },
					react.createElement("span", { className: "laa-toggle-knob" })),
				react.createElement("span", { className: "laa-toggle-label", key: "label" }, t("label")),
			]);
		}
		//#endregion

		//#region 插件入口
		/** 所需服务：插槽注册表与多语言字典。 */
		const inject = ["slots", "locale"];

		/**
		 * 浏览器端插件主体：注入样式与字典，并把开关注册进会话顶栏工具区。
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
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
