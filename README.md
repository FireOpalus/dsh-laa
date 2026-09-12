---
description: "面向用户与维护者的会话级 LAA 模式说明：在 DeepSeek 峰时停止运行、谷时继续运行的 /laa 开关、峰谷判定与停机/续跑的确切语义。"
kind: "package-reference"
---

# dsh-laa

`dsh-laa` 给**每一个会话**加一个 LAA 模式。会话打开它之后，就只在 DeepSeek 的
**谷时（空闲时段）** 运行：

- **峰时**：正在跑的轮次被立刻停下；任何想要进入的步骤会被拦下，于是**一个模型请求都不会发出**。被拦下的输入被原样保存。
- **谷时**：被停下的轮次收到一条续跑提示词继续做；峰时被拦下的输入按原顺序重新投递。

峰谷时段取自 DeepSeek 官方定价口径，窗口可配置，官方改口径时不需要改代码。

## 目录

- [安装](#安装)
- [使用](#使用)
- [峰时到底发生什么](#峰时到底发生什么)
- [谷时到底发生什么](#谷时到底发生什么)
- [配置](#配置)
- [边界与已知限制](#边界与已知限制)
- [开发](#开发)

-----

<a id="安装"></a>
## 安装

```sh
# 从 npm
dsh plugin --profile web add dsh-laa

# 或者本地开发中的 checkout（link: 会建软链，改完重启即可生效）
dsh plugin --profile web add link:D:\Project\dsh-laa
```

DSH Desktop 用户直接改 `%USERPROFILE%\.dsh\profiles\web`（macOS / Linux 为
`~/.dsh/profiles/web`）即可：本包自带 `cordis.patch.yml`，作为 profile bundle 加入
`dsh.profile.bundles` 后就会插入 `laa` 加载器行。

装好后**重启** `dsh web` / DSH Desktop，然后任意会话里输入 `/laa`。

<a id="使用"></a>
## 使用

LAA 模式是**每个会话各自**的开关，默认关闭。

| 命令 | 作用 |
|---|---|
| `/laa` | 查看状态：开关、当前是峰时还是谷时、下一次切换、峰时窗口、待恢复的输入数量 |
| `/laa on` | 打开该会话的 LAA 模式 |
| `/laa off` | 关闭；已经暂存的输入不会再自动投递，命令会提醒你 |
| `/laa status` | 等同于 `/laa` |

命令直接从 UI 作用到会话，不产生任何模型消息，因此开关本身不花 token。

典型用法：晚上下班前对一个长任务说「继续做」，然后 `/laa on`——峰时它会自己停住，
谷时（工作日 12:00-14:00、18:00 之后、以及整个周末）它会自己接着做。

<a id="峰时到底发生什么"></a>
## 峰时到底发生什么

峰时开始的那一刻：

1. 所有属于该会话的实时 agent（根会话 agent 及其在进程内的子代理）如果正在跑，
   会被 `cancel(cause, { keepInbox: true })` 中止当前轮次，**已排队但还没开始的输入会被保留**。
2. 之后任何试图进入的步骤都会在 `agent/pre-step` 瀑布里被**拒绝**。拒绝发生在
   模型请求之前，所以峰时不会产生任何 API 调用。
3. 被拒绝步骤的输入不会丢：轮次的**第一个步骤**里携带的、真正的用户/插件输入会被
   原样记进状态文件；轮次中途的步骤只把会话标记为「需要续跑」——工具结果不是用户
   输入，不会被当成用户消息重放。

峰时期间你在 UI 里发消息是安全的：它会等谷时再被投递，而不是被丢掉。

<a id="谷时到底发生什么"></a>
## 谷时到底发生什么

谷时开始的那一刻，每一个还有遗留工作的会话：

1. 如果峰时中断过轮次，先投递一条续跑提示词 `[LAA MODE — OFF-PEAK WINDOW OPENED]`，
   让模型从既有历史、工作区与工具结果继续，而不是从头重来。
2. 然后把峰时暂存的输入**按原顺序**逐条重新投递（保留原本的 message source）。
3. 如果峰时拦下的是 goal round，还会把被拦下时自动暂停的 goal 重新武装，
   让自动续行回到你原本的意图。

只有确实投递成功的部分才会从状态里清掉。会话在谷时到来时如果还没有实时 agent
（没打开过），遗留输入会一直留着，等它下一次变成实时 agent 时立刻交付。

<a id="配置"></a>
## 配置

编辑 profile 的 `cordis.patch.yml`（或直接改本包自带的 `cordis.patch.yml`）：

```yaml
- id: laa            # 注意：patch 是【整体替换】config，不是逐字段合并
  config:
    enabled: true
    timeZone: 'Asia/Shanghai'
    peakWindows:
      - days: [mon, tue, wed, thu, fri]
        start: '09:00'
        end: '12:00'
      - days: [mon, tue, wed, thu, fri]
        start: '14:00'
        end: '18:00'
    defaultMode: false
    cancelRunningOnPeak: true
    resumeOnValley: true
    tickMs: 30000
    maxDeferred: 20
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 插件总开关。`false` 时插件照常加载，但任何会话都不会被停。 |
| `timeZone` | `'Asia/Shanghai'` | 峰时窗口所依据的 IANA 时区（DeepSeek 官方口径为北京时间）。 |
| `peakWindows` | 见上 | 峰时窗口数组，**其余时段一律是谷时**。`days` 接受 `mon`…`sun` 或 `1`（周一）…`7`（周日）；`start`/`end` 为 `HH:MM`；`end <= start` 表示跨零点窗口。 |
| `defaultMode` | `false` | 从未被 `/laa` 切换过的会话是否默认开启。显式关掉过的会话不会被它重新打开。 |
| `cancelRunningOnPeak` | `true` | 峰时开始时是否中止正在跑的轮次。 |
| `resumeOnValley` | `true` | 谷时开始时是否自动续跑。 |
| `tickMs` | `30000` | 相位重新评估的兜底间隔；窗口边界本身总是会被精确唤醒。 |
| `maxDeferred` | `20` | 每个会话最多暂存多少条输入，超出时丢弃最旧的并记一条警告。 |
| `statePath` | `$DSH_HOME/laa/state.json` | 状态文件位置。 |

### 官方峰谷口径

据 [DeepSeek 官方定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) 注 (3)：
空闲时段价格为高峰时段价格的一半，**高峰时段为北京时间周一至周五 09:00-12:00、
14:00-18:00，其余为空闲时段**。折算成 UTC 即周一至周五 01:00-04:00 与 06:00-10:00。

于是：工作日 12:00-14:00、每天 18:00 之后、以及整个周末都是谷时，其中从
**周五 18:00 到周一 09:00 是一段连续 63 小时的谷时**。

窗口写在配置里而不是写死在代码里——DeepSeek 调整过峰谷口径（2025-02-26 的
`16:30-00:30 UTC` 方案已被 2026-08-17 生效的新口径取代），下一次调整只需要改配置。

-----

<a id="边界与已知限制"></a>
## 边界与已知限制

- **只续跑实时会话。** 谷时到来时没有实时 agent 的会话不会被插件唤醒——拉起一个
  冷会话需要 profile 的 agent preset 组合（`ctx.agents.resume({ resumeSessionId, agentOptions, setup })`），
  那是 UI/会话控制器的职责。这类会话的遗留输入会被保留，等它下一次变成实时 agent
  时立刻交付。
- **不杀后台任务。** 峰时停的是 agent 的轮次，不是操作系统进程：`pwsh` 的后台
  job、子进程等会继续在后台跑完（它们无法「暂停后继续」，只能被杀掉重跑）。会话在
  谷时续跑时再收它们的结果。
- **子代理随所属会话一起停。** 进程内子代理继承根会话的模式；已经派发出去的
  外部进程不在管辖范围内。
- **`/laa` 需要命令适配器。** headless / SDK 这类没有命令适配器的组合只是没有这个
  入口，LAA 的调度行为不受影响。
- **峰时会在会话日志里留下空轮次。** 被拒绝的步骤已经开启了 `turn/start`，拒绝后
  以 `turn/end { reason: { kind: 'blocked' } }` 收尾。这是 DSH 既有的语义，不是错误。
- **状态文件是本插件自己的。** DSH 的持久化读取路径会拒绝解释未知的会话事件类型
  （除非事件带 `ignorable` 标记，而这在公开的 `session.append()` 上无法设置），所以
  这里不去污染会话日志，而是把状态放在 `$DSH_HOME/laa/state.json`，写入是原子的
  （临时文件 + rename）且做了防抖。

<a id="开发"></a>
## 开发

本包是**零运行时依赖**的纯 ESM：不 import 任何 `@deepseek-ai/*`，只用 Node 内建能力。
profile 中的第三方插件要自己解析依赖，零依赖让它不与宿主版本耦合，也不需要构建步骤。

```sh
npm test     # 20+ 个单元/集成测试，自带假宿主，不碰真实会话
npm run smoke  # 在真实 Cordis 上验证 inject 门控、瀑布拦截、迟到服务挂载与资源回收
```

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件入口：`name` / `inject` / `apply`（以及返回运行时的 `mount`） |
| `lib/pricing.js` | 峰谷判定与窗口算术的纯函数：`resolvePhase`、`normalizeWindows`、`zonedTimeToEpoch` |
| `lib/laa.js` | 运行时状态机：峰时停机、`agent/pre-step` 拦截、暂存、谷时续跑与重放 |
| `lib/command.js` | `/laa` 斜杠命令 |
| `lib/store.js` | `$DSH_HOME/laa/state.json` 的同步读 / 防抖原子写 |

只用到 DSH 的公开扩展点：`ctx.agents` 注册表、`Agent.cancel/followup/status`、
`agent/pre-step` 瀑布、`agent/created`、`ctx.commands.register` 与 `ctx.goals`（可选）。
`cancel` 用的 cause 是 `{ kind: 'hook', reason: 'dsh-laa: deepseek peak window' }`——
`hook` 是 `AgentCancelCause` 里为插件/钩子预留的成员，日志与 UI 因此能看出是谁停的。
