# Changelog

本文件记录 `dsh-laa` 的每一个对外版本。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[语义化版本](https://semver.org/lang/zh-CN/)。「内部」一节只影响开发与验证方式，
不改变插件的运行时行为。

## [Unreleased]

## [0.5.0] - 2026-09-15

### 变更

- **关掉 LAA 时，压着的输入当刻发出去**：以前 `/laa off`（或点开关）只是把模式关掉，
  峰时攒下的输入会一直躺在状态文件里等谷时——而模式已经关了，谷时也不会再自动投递。
  现在关闭动作会**立刻**把整棵会话树（父会话 + 所有子会话）压着的工作交给各自的实时
  agent：被中断过的轮次先收到一条续跑提示词，随后是攒下的输入、按原顺序。
  （`lib/laa.js`）
- **续跑提示词分两种**：谷时继续用 `[LAA MODE — OFF-PEAK WINDOW OPENED]`，因为「人把
  LAA 关了」而投递的用新的 `[LAA MODE — TURNED OFF]`——措辞必须对得上，否则模型会
  以为自己正处在谷时窗口里。
- **当时没有实时 agent 的会话不丢输入**：交不出去的留在状态里，等它下一次变成实时会话
  （`agent/created`）时立刻投递；`adopt` 因此不再要求模式开着。
- **`/laa off` 的输出改写**：报告这次发出去几个会话、几条输入，以及还有几个会话在等
  实时 agent（不再说「关闭后不会再自动恢复」）。
- `setEnabled()` 现在返回 `{ entry, released }`，把「关掉时交出去多少」一并交给命令层。

### 内部

- 新增 5 个用例：关闭时当刻投递（含提示词区分）、没有实时 agent 时留待下次运行、
  整棵树一起交（从子会话关也一样）、只影响自己这棵树、控制面 `POST /mode off` 的投递；
  `/laa off` 的既有用例改为断言新的输出。

## [0.4.0] - 2026-09-15

### 新增

- **峰谷切换有动静了**：相位真的翻过去时，开关会**跳三下**；开着 LAA 的时候轨道颜色用
  1.26 秒平滑地在绿 <-> 琥珀之间推过去；并弹一条**浏览器通知**（`LAA · 进入峰时` /
  `LAA · 进入谷时`，带会话标签，同一会话的播报互相顶替）。通知权限在用户点开关时
  申请（浏览器要求用户手势），拒绝授权或浏览器没有该 API 都只是没有通知；
  `prefers-reduced-motion` 下不播动画。（`lib/client.js`）
- **`notify` 配置**：`enabled`（默认，只有开着 LAA 的会话才播报）/ `always` /
  `off`，随快照一起交给前端；只影响通知，切换动画不受影响。
  （`lib/laa.js`、`cordis.patch.yml`）
- **按宿主边界对齐的刷新**：前端不再只靠 20 秒轮询——每次拿到快照就按 `nextChangeAt`
  精确等一次（宿主在边界后约 1 秒重新评估，前端晚 2 秒去问），20 秒轮询退化为兜底，
  用来追平标签页或系统休眠期间错过的切换。（`lib/client.js`）

### 内部

- `test/client.test.js` 新增有状态的假 React（`createStatefulReact`）：`setState` 会
  重渲染，effect 由测试显式驱动，于是轮询、边界定时器与切换动画的收尾都可控；配套的
  `unmount()` 负责跑清理——不卸载的话测试进程会被一个最长 30 分钟的真实定时器拖住。
- 新增 6 个用例：切换时的动画类与通知内容、`notify` 三种策略、没有 Notification API
  时不抛错、点开关时申请权限、`notify` 配置收敛、快照带 `notify`。

## [0.3.1] - 2026-09-14

### 修复

- **升级前就存在的子会话也会跟随父会话**：0.3.0 只在「插件亲眼见过这个子会话」时才
  认得出它的父会话（实时 agent、宿主会话仓库里的实时会话，或见过一次之后落盘的
  `lineage`），于是**升级之前创建、之后一直冷着的子会话**依旧显示它自己那一份开关。
  控制面现在会在第一次收到请求时向宿主的会话清单（`ctx.sessionQuery.listSessions()`，
  就是侧栏用的那一份）补一次谱系，每个进程一次；读失败只是退回原来的判断，不影响控制面。
  （`lib/laa.js`、`lib/web.js`）

### 内部

- `test/runtime.test.js` 的 `withHarness()` 现在同时支持同步与异步测试体（异步时等
  它结束再回收运行时与临时目录）。
- 新增 3 个用例：从会话清单补谱系（补之前只看见自己、补之后跟随父会话、每进程只扫
  一次）、清单读失败后仍可重试、控制面在冷子会话上补谱系后读与写都落在父会话。

## [0.3.0] - 2026-09-14

### 新增

- **子会话跟随父会话的 LAA 模式**：DSH 的 subagent 子会话（header 里带
  `origin: 'subagent'` 与 `parentSession`）不再各存一份开关，而是沿谱系向上取**顶层
  会话（锚点）**的那一个——父会话开着子会话就开着、父会话关掉子会话立刻放行；在子会话
  里点开关（或 `/laa on|off`）改的就是父会话，整棵会话树永远只有一个开关。悬停提示与
  `/laa` 都会写明「跟随父会话」。（`lib/laa.js`、`lib/store.js`、`lib/command.js`、`lib/client.js`）
- **谱系落盘**：`$DSH_HOME/laa/state.json` 新增 `lineage` 字段（子会话 → 父会话），
  事实来自会话 header 的 `parentSession`；读得到实时 agent 或宿主会话仓库里的实时会话
  时自动补齐。于是进程重启、或子会话当前没有实时 agent 时，开关与 `/laa` 依旧显示父
  会话的那一份状态。
- **控制面快照新增 `inheritedFrom`**：非 null 时说明这是子会话，以及它跟随哪个顶层会话。

### 变更

- **子会话的遗留工作记在子会话自己名下**：峰时被拦下的输入与被中断的轮次不再记到父
  会话头上，谷时回到**产生它们的那个会话**的 agent 上继续跑（此前会被投递给父代理，等于
  把子会话的输入送进了错误的会话）。父会话的「等待谷时」计数因此只统计它自己的遗留工作。

### 内部

- `test/harness.js` 支持会话 header（`childHeader()`）：假 agent 现在可以像真实 DSH
  一样带 `origin: 'subagent'` 与 `parentSession`，也可以用 `provide('sessions', …)`
  模拟宿主会话仓库。
- 新增 12 个用例：锚点解析（多级、自指、成环）、显示与拦截一致、子会话里的切换落到
  父会话、遗留工作归属与谷时投递目标、谱系落盘与冷子会话、控制面读写、`/laa` 文案、
  悬停提示的「跟随父会话」行。

## [0.2.1] - 2026-09-14

### 修复

- **新对话页也有 LAA 开关了**：会话还没有第一条消息时，DSH 会把整条会话顶栏藏起来
  （`ConversationSessionHeader` 里的 `hideChrome`），注册在顶栏里的开关因此根本不会
  挂载——新对话页，以及正在打开的会话，都没有可点的开关。同一个开关现在也注册进
  输入框工具行（`conversation.input.left`），并且**只在顶栏确实不显示时**渲染，因此
  页面上任何时刻都恰好有一个开关：可以在发出第一条消息之前就把 LAA 打开。
  （`lib/client.js`）

### 内部

- `test/client.test.js` 新增 4 个用例：新对话页出现在输入框工具行、顶栏可见时不重复
  渲染（engaging / 已开动 / 有活跃 target / 正在跑四种状态）、拿不到 conversation 包时
  退回 `session.blank` 判断、宿主没给作用域标准 Hook 时不画第二个开关。

## [0.2.0] - 2026-09-12

### 新增

- **会话页顶栏的 LAA 滑动开关**：轨道 + `LAA` 标签，单击切换当前会话的模式；悬停显示
  当前峰谷时段、下一次切换、峰时窗口与待恢复的输入条数；开启且正处峰时时轨道变琥珀色，
  一眼看出它正被按住。（`lib/client.js`）
- **浏览器控制面**：挂在 `ctx.webServer` 的 `/dsh-laa` 前缀下——`GET /health`、
  `GET /state?sessionId=<id>`、`POST /mode { sessionId, enabled }`。坏输入返回
  400 / 409 / 404 且**不会先把状态改掉**；没有 `webServer` 的组合只是没有浏览器入口，
  调度行为不受影响。（`lib/web.js`）
- **隔离测试环境**：`node scripts/dev-home.mjs` 在工作区里建一个只属于本仓库的 DSH
  home（`.dsh-test/`，含 `web` 与 `headless` 两个 profile），与 `~/.dsh` 完全分开；
  `--boot` 可直接启动。
- **零成本端到端验证**：`npm run e2e` 在真实的 DSH 与真实 agent loop 上验证
  「峰时确实停住、输入确实保住」，而一个模型请求都不发。

### 变更

- `/laa` 命令、顶栏开关与控制面现在读同一份 `runtime.snapshot()`，前端不再自己拼装
  状态，因此命令、开关与状态文件三者永远一致。

### 内部

- 新增 `test/web.test.js`（控制面处理器，以及真实路由的挂载与前缀转发）与
  `test/client.test.js`（在 Node 里真的执行浏览器 bundle：格式、插槽注册、
  峰时/谷时/禁用三态渲染、单击发出的 POST 载荷）。
- 测试用的假宿主改为按真实 Cordis 的语义做 `inject` 门控：依赖缺失时不回调，
  服务补上后再补跑。
- README 增补「本地隔离测试环境」「怎么测」「浏览器开关与控制面」三节。

## [0.1.0] - 2026-09-12

首个版本。

### 新增

- **会话级 LAA 模式**：打开后该会话只在 DeepSeek 谷时（空闲时段）运行。
  - 峰时：正在跑的轮次立刻停下；任何想要进入的步骤在 `agent/pre-step` 瀑布里被拒绝，
    因此**一个模型请求都不会发出**；被拦下的输入原样保存，不会丢。
  - 谷时：被中断的轮次收到一条续跑提示词继续做；峰时暂存的输入按原顺序重新投递；
    被拦下的 goal round 会把自动暂停的 goal 重新武装。
  - 进程内子代理继承所属会话的模式。
- **`/laa on | off | status` 斜杠命令**：直接作用于会话，不产生模型消息，不花 token。
- **峰谷窗口可配置**：默认取官方口径（北京时间周一至周五 09:00-12:00、14:00-18:00，
  其余为空闲时段），支持星期名/数字两种写法与跨零点窗口；官方调整口径时只改配置，
  不需要改代码。
- **持久状态**：`$DSH_HOME/laa/state.json`（同步读 + 防抖原子写），开关与峰时暂存的
  输入都跨重启存活；冷会话的遗留输入会保留到它下次变成实时会话。
- 零运行时依赖：不 import 任何 `@deepseek-ai/*`，只用 Node 内建能力，无构建步骤。

[Unreleased]: https://github.com/FireOpalus/dsh-laa/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/FireOpalus/dsh-laa/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/FireOpalus/dsh-laa/compare/v0.3.1...v0.4.0
[0.3.1]: https://github.com/FireOpalus/dsh-laa/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/FireOpalus/dsh-laa/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/FireOpalus/dsh-laa/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/FireOpalus/dsh-laa/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FireOpalus/dsh-laa/releases/tag/v0.1.0
