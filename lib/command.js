/**
 * `/laa` 斜杠命令：每个会话自己的 LAA 模式开关与状态。
 *
 * 命令直接作用于接收它的 agent，不产生任何模型消息（DSH 的 `commands` 约定），
 * 因此开关 LAA 本身永远不会消耗 token。命令挂载是可选的：没有命令适配器的
 * 组合（headless / ACP）只是没有这个入口，LAA 的调度行为不受影响。
 *
 * @module dsh-laa/command
 */

/** `/laa` 的用法提示。 */
const USAGE = '用法：/laa [on|off|status]';

/** 把一条命令执行结果包装为 DSH 的稳定结果联合。 */
function reply(kind, text) {
  return { kind, text };
}

/** 执行一次 `/laa` 调用。 */
function execute(runtime, agent, rawInput) {
  const sessionId = agent?.session?.id;
  if (sessionId === undefined) return reply('error', `dsh-laa: 该命令需要一个会话。${USAGE}`);
  const action = String(rawInput ?? '').trim().toLowerCase();
  switch (action) {
    case '':
    case 'status':
      return reply('success', runtime.describe(sessionId));
    case 'on': {
      runtime.setEnabled(sessionId, true);
      const phase = runtime.phaseNow();
      const suffix = phase === 'peak'
        ? '\n当前是峰时：正在运行的轮次会被停下，新的输入会被暂存到谷时。'
        : '\n当前是谷时：会话立即恢复运行。';
      return reply('success', `LAA 模式已开启。${suffix}\n${runtime.describe(sessionId)}`);
    }
    case 'off': {
      runtime.setEnabled(sessionId, false);
      const entry = runtime.entryOf(sessionId);
      const pending = entry.deferred.length;
      const note = pending > 0 || entry.suspended
        ? `\n注意：仍有 ${entry.suspended ? '1 个被中断的轮次' : ''}${entry.suspended && pending > 0 ? '、' : ''}${pending > 0 ? `${pending} 条暂存输入` : ''} 未投递，关闭后不会再自动恢复。`
        : '';
      return reply('success', `LAA 模式已关闭。${note}`);
    }
    default:
      return reply('error', `dsh-laa: 无法识别的参数 ${JSON.stringify(String(rawInput ?? ''))}。${USAGE}`);
  }
}

/**
 * 注册 `/laa` 命令。挂载点是可选的，缺失时静默跳过。
 * @param ctx - 插件上下文。
 * @param runtime - LAA 运行时。
 */
export function registerLaaCommand(ctx, runtime) {
  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'laa',
      description: 'LAA 模式：DeepSeek 峰时停止运行、谷时继续运行',
      input: { hint: '[on|off|status]' },
      handler: ({ agent, rawInput }) => execute(runtime, agent, rawInput),
    });
  });
}
