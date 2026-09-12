/**
 * dsh-laa —— 为每一个会话提供 LAA 模式。
 *
 * LAA 模式开启后，该会话只在 DeepSeek 的谷时（空闲时段）运行：
 *
 * - **峰时**：正在运行的轮次被中止；任何试图进入的步骤在 `agent/pre-step`
 *   瀑布中被拒绝，因此不会产生任何模型请求。被拒绝的输入被原样保存。
 * - **谷时**：被中断的轮次收到一条续跑提示词，被保存的输入按原顺序重放。
 *
 * 峰谷时段取自 DeepSeek 官方定价页：高峰时段为北京时间周一至周五
 * 09:00-12:00 与 14:00-18:00，其余时段（含整个周末）为空闲时段。窗口可通过
 * `peakWindows` 配置，因此官方口径变化时不需要改代码。
 *
 * 本插件不导入任何 `@deepseek-ai/*` 包，只用 Node 内建能力：profile 中的
 * 第三方插件需要自己解析依赖，零运行时依赖让它不与宿主版本耦合。
 *
 * @module dsh-laa
 */

import { registerLaaCommand } from './command.js';
import { createLaaRuntime } from './laa.js';

/** Cordis 插件名，用于加载器诊断与日志。 */
export const name = 'laa';

/** 硬依赖：没有 agent 注册表就没有任何可调度的会话。 */
export const inject = ['agents'];

/**
 * 挂载 LAA，并返回运行时句柄。
 *
 * `apply` 就是它、只是丢弃返回值：Cordis 会把插件函数的返回值当作 effect 解释，
 * 因此加载路径不能把运行时对象交回去。需要句柄的调用方（测试、嵌入方）用本函数。
 *
 * @param ctx - 插件上下文。
 * @param config - patch 行提供的配置（见 README「配置」）。
 * @param deps - 仅用于测试的可替换依赖，原样转交给 {@link createLaaRuntime}。
 * @returns 运行时句柄。
 */
export function mount(ctx, config, deps) {
  const runtime = createLaaRuntime(ctx, config, deps);
  ctx.on('agent/pre-step', (payload, next) => runtime.preStep(payload, next), { prepend: true });
  ctx.on('agent/created', ({ agent }) => runtime.adopt(agent));
  registerLaaCommand(ctx, runtime);
  ctx.effect(() => () => runtime.dispose(), 'dsh-laa: runtime');
  runtime.start();
  ctx.logger.info(`dsh-laa: watching DeepSeek peak windows (timeZone ${runtime.timeZone}, now ${runtime.phaseNow()})`);
  return runtime;
}

/**
 * Cordis 插件入口。
 * @param ctx - 插件上下文。
 * @param config - patch 行提供的配置。
 */
export function apply(ctx, config) {
  mount(ctx, config);
}
