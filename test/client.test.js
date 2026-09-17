import assert from 'node:assert/strict';
import { test } from 'node:test';

/**
 * 浏览器 bundle 的契约测试。
 *
 * `lib/client.js` 在模块顶层就会调用 `window.__ModuleLoader__.load()`，所以这里先
 * 装好假的 window / document / fetch，再用动态 import 加载它——于是可以在 Node 里
 * 真实验证 bundle 格式、工厂函数、插槽注册与开关的请求载荷，不需要浏览器。
 */

/** 假的 `document`，只为记录样式注入。 */
function createDocument() {
  const appended = [];
  return {
    appended,
    head: { append: (node) => appended.push(node) },
    createElement: (tag) => ({
      tag,
      attributes: {},
      textContent: '',
      setAttribute(name, value) { this.attributes[name] = value; },
      remove() { this.removed = true; },
    }),
  };
}

/**
 * 假的 React。
 * @param preset - 依次交给 `useState` 的值；不足时回落到组件自己声明的初值。
 */
function createReact(preset = []) {
  let cursor = 0;
  return {
    useState: (initial) => {
      const index = cursor++;
      const value = index < preset.length ? preset[index] : (typeof initial === 'function' ? initial() : initial);
      return [value, () => {}];
    },
    useEffect: () => {},
    useCallback: (fn) => fn,
    useRef: (value) => ({ current: value }),
    useMemo: (fn) => fn(),
    createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  };
}

/**
 * 有状态的假 React：够把同一个函数组件渲染多次（useState / useRef / useEffect /
 * useCallback）。真 React 的调度不在测试范围内，这里只保证两件事：`setState` 之后
 * 重新渲染，以及 effect 由测试显式 `runEffects()` 驱动——于是轮询、边界定时器、
 * 切换动画的收尾都可控，不会自己跑起来。
 * @returns 假的 react 模块与 `mount` / `runEffects` 两个驱动器。
 */
function createStatefulReact() {
  const slots = [];
  const effects = new Map();
  let cursor = 0;
  let queued = [];
  let renderInstance = null;
  let latest = null;

  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next) => {
        slots[index] = typeof next === 'function' ? next(slots[index]) : next;
        latest = renderInstance(false);
      }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useCallback(fn) {
      cursor += 1;
      return fn;
    },
    useEffect(fn, deps) {
      queued.push({ index: cursor++, fn, deps });
    },
    useMemo(fn) {
      cursor += 1;
      return fn();
    },
    createElement: (type, props, children) => ({ type, props: props ?? {}, children }),
  };

  /** 跑这一轮排队的 effect；依赖没变的不重跑，重跑前先执行上一次的清理。 */
  function runEffects() {
    const pending = queued;
    queued = [];
    for (const effect of pending) {
      const previous = effects.get(effect.index);
      const same = previous !== undefined
        && Array.isArray(effect.deps)
        && Array.isArray(previous.deps)
        && effect.deps.length === previous.deps.length
        && effect.deps.every((value, index) => Object.is(value, previous.deps[index]));
      if (same) continue;
      if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup();
      const cleanup = effect.fn();
      effects.set(effect.index, { deps: effect.deps, cleanup: typeof cleanup === 'function' ? cleanup : undefined });
    }
  }

  return {
    react,
    /** 挂载一个全新的组件实例（清空插槽），返回元素；effect 交给 runEffects()。 */
    mount(Component, props) {
      slots.length = 0;
      effects.clear();
      renderInstance = (withEffects) => {
        cursor = 0;
        queued = [];
        const element = Component(props);
        if (withEffects) runEffects();
        return element;
      };
      latest = renderInstance(false);
      return latest;
    },
    /** 显式跑 effect（例如组件挂载后的那一轮拉取）。 */
    runEffects,
    /**
     * 卸载：执行所有 effect 的清理函数。
     *
     * 必须调用——轮询间隔与边界定时器都挂在 effect 的清理上，不卸载的话测试进程
     * 会被一个最长 30 分钟的真实定时器拖住。
     */
    unmount() {
      for (const effect of effects.values()) {
        if (typeof effect.cleanup === 'function') effect.cleanup();
      }
      effects.clear();
      slots.length = 0;
    },
    /** 最近一次渲染出来的元素。 */
    get element() {
      return latest;
    },
  };
}

let bundleEntry;

/** 平台模块表里 conversation 包的 id，与 package.json 的 dsh.client.inject 一致。 */
const CONVERSATION_ID = '@deepseek-ai/dsh-client-ui-conversation';

/**
 * 与 ui-conversation 同一条规则的测试替身：宿主用它决定顶栏显不显示
 * （`session.blank && conversationPhase(...) === "blank"` 时整条顶栏被藏起来）。
 */
function conversationPhase(session, conversation) {
  return conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
    ? 'active'
    : session.promptAttempted ? 'engaging' : 'blank';
}

/**
 * 载入 bundle，并针对本次测试调用一次工厂。
 *
 * ESM 的模块体只会求值一次，所以 `window.__ModuleLoader__.load()` 也只会被调用一次；
 * 这正是真实加载器的行为（模块求值一次，工厂按需调用）。每个测试拿到的是同一份
 * bundle 注册记录，但各自一份全新的模块导出与 `document`。
 *
 * @param react - 假的 react 模块。
 * @param options.conversation - 假的 conversation 包；传 `null` 表示组合里没有它
 *   （真实加载器此时会让 require 抛错），用来验证退回路径。
 */
async function loadBundle(react, options = {}) {
  const document = createDocument();
  globalThis.document = document;
  globalThis.fetch = () => Promise.reject(new Error('fetch is not stubbed in this test'));
  if (bundleEntry === undefined) {
    const loads = [];
    globalThis.window = { __ModuleLoader__: { load: (entry) => loads.push(entry) } };
    await import('../lib/client.js');
    assert.equal(loads.length, 1, 'bundle 必须恰好注册一次');
    bundleEntry = loads[0];
  }
  const conversation = Object.hasOwn(options, 'conversation') ? options.conversation : { conversationPhase };
  const modules = new Map([
    ['react', react],
    [CONVERSATION_ID, conversation],
  ]);
  const requested = [];
  const exports = bundleEntry.factory((name) => {
    requested.push(name);
    if (!modules.has(name) || modules.get(name) === null || modules.get(name) === undefined) {
      throw new Error(`client-modules: require("${name}") missed the module table`);
    }
    return modules.get(name);
  });
  return { id: bundleEntry.id, exports, document, requested };
}

/** 一个还没有发过消息的会话（新对话页的那一份快照）。 */
function blankSession(overrides = {}) {
  return {
    sessionId: 's1',
    blank: true,
    running: false,
    promptAttempted: false,
    awaitingFirstTurn: false,
    ...overrides,
  };
}

/** 空 conversation 快照：没有任何活跃 target。 */
const EMPTY_CONVERSATION = { activeTargets: new Set() };

/**
 * 插槽按 session 作用域发给每个条目的那部分 props。
 * @param session - 会话快照。
 * @param conversation - conversation 快照。
 * @param t - 翻译函数，默认回显 key。
 */
function sessionScopeProps(session, conversation = EMPTY_CONVERSATION, t = (key) => key) {
  return {
    sessionId: session.sessionId,
    useSession: (selector) => selector(session),
    useConversation: (selector) => selector(conversation),
    t,
  };
}

/** 按插槽名取回本次注册，避免测试依赖注册顺序。 */
function registrationOf(client, name) {
  const found = client.registrations.find((item) => item.options.name === name);
  assert.ok(found, `必须注册进 ${name}`);
  return found;
}

/** 控制面快照的完整形状；`nextChangeAt` 给足余量，免得边界定时器在测试里乱跑。 */
function controlState(overrides = {}) {
  return {
    sessionId: 's1',
    enabled: true,
    inheritedFrom: null,
    phase: 'valley',
    notify: 'enabled',
    now: 1789389000000,
    nextChangeAt: 1789400000000,
    timeZone: 'Asia/Shanghai',
    localNow: '2026-09-14 22:00（周一）',
    localNextChange: '2026-09-15 09:00（周二）',
    peakWindows: '周一至周五 09:00-12:00',
    masterEnabled: true,
    defaultMode: false,
    deferred: 0,
    suspended: false,
    ...overrides,
  };
}

/** 记录构造调用的假 Notification。 */
function createNotification(permission = 'granted') {
  const created = [];
  let requests = 0;
  class FakeNotification {
    static permission = permission;
    static requestPermission() {
      requests += 1;
      FakeNotification.permission = 'granted';
      return Promise.resolve('granted');
    }
    constructor(title, options) {
      created.push({ title, options });
    }
  }
  return { FakeNotification, created, requests: () => requests };
}

/** 让出一次宏任务，把 fetch 链上的微任务跑完。 */
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * 驱动一次「谷时 -> 峰时」的切换：先拉一次旧相位，再拉一次新相位。
 * @param harness - 有状态假 React。
 * @param component - 开关组件。
 * @param props - 组件 props。
 * @param before - 切换前的快照。
 * @param after - 切换后的快照。
 */
async function driveFlip(harness, component, props, before, after) {
  let current = before;
  globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: current }) });
  harness.mount(component, props);
  harness.runEffects();
  await settle();
  current = after;
  harness.runEffects();
  await settle();
}

/**
 * 展开插槽条目的一层：输入框那份开关是一个只会转交（或返回 null）的组件，
 * 真正的按钮在它渲染出来的元素里。
 */
function renderElement(element) {
  return element !== null && typeof element.type === 'function' ? element.type(element.props) : element;
}

/** 假的客户端上下文。 */
function createClientContext() {
  const registrations = [];
  const effects = [];
  const dictionaries = [];
  const slots = {
    injected: [],
    inject(target, callback) {
      this.injected.push(target);
      callback();
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const ctx = {
    slots,
    effect: (callback, label) => {
      const dispose = callback();
      effects.push({ label, dispose });
    },
    locale: {
      register: (namespace, dict) => {
        dictionaries.push({ namespace, dict });
        return () => {};
      },
    },
  };
  return { ctx, registrations, effects, dictionaries, slots };
}

test('bundle 以 __ModuleLoader__ 的约定注册，并导出 apply/inject', async () => {
  const { id, exports } = await loadBundle(createReact());
  assert.equal(id, 'dsh-laa');
  assert.equal(typeof exports.apply, 'function');
  assert.deepEqual(exports.inject, ['slots', 'locale']);
  assert.equal(Object.hasOwn(exports, 'default'), false);
});

test('apply() 注入样式与中英字典，并把开关注册进顶栏工具区与输入框工具行', async () => {
  const { exports, document, requested } = await loadBundle(createReact());
  const client = createClientContext();
  exports.apply(client.ctx);

  assert.deepEqual(requested, ['react', CONVERSATION_ID], 'bundle 只应请求 react 与 conversation 包');

  assert.equal(document.appended.length, 1, '样式必须被注入一次');
  assert.equal(document.appended[0].tag, 'style');
  assert.equal(document.appended[0].attributes['data-plugin'], 'dsh-laa');
  assert.match(document.appended[0].textContent, /\.laa-toggle\.is-on \.laa-toggle-knob\{transform:translateX\(16px\)\}/);
  assert.match(document.appended[0].textContent, /\.laa-toggle\.is-peak \.laa-toggle-track\{background:#d08b2c\}/);

  assert.deepEqual(client.dictionaries.map((item) => item.namespace), ['dsh-laa']);
  assert.equal(typeof client.dictionaries[0].dict.zh.aria, 'string');
  assert.equal(typeof client.dictionaries[0].dict.en.aria, 'string');

  // 顶栏那份是常驻的，输入框那份只在新对话页（顶栏被 DSH 藏起来）时出场。
  assert.deepEqual(client.slots.injected, [
    'conversation.session.header.utilities',
    'conversation.input.left',
  ]);
  assert.equal(client.registrations.length, 2);
  for (const { options, component } of client.registrations) {
    assert.equal(options.id, 'dsh-laa');
    assert.equal(options.order, 95);
    assert.equal(options.locale, 'dsh-laa');
    assert.deepEqual(options.inject('session-7'), { sessionId: 'session-7' });
    assert.equal(typeof component, 'function');
  }
  assert.equal(registrationOf(client, 'conversation.session.header.utilities').component.name, 'LaaToggle');
  assert.equal(registrationOf(client, 'conversation.input.left').component.name, 'LaaComposerToggle');

  // 卸载路径：每个 effect 都得给出一个可调用的清理函数。
  assert.deepEqual(client.effects.map((item) => item.label), [
    'dsh-laa: styles',
    'dsh-laa: dictionaries',
    'dsh-laa: session header toggle',
    'dsh-laa: composer toggle',
  ]);
  for (const effect of client.effects) assert.equal(typeof effect.dispose, 'function');
});

test('新对话页（DSH 把顶栏藏起来）时，开关出现在输入框工具行里', async () => {
  const { exports } = await loadBundle(createReact([null, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const { component } = registrationOf(client, 'conversation.input.left');

  const element = renderElement(component(sessionScopeProps(blankSession({ sessionId: 'fresh' }))));
  assert.equal(element.type, 'button');
  assert.equal(element.props.role, 'switch');
  assert.equal(element.props['data-laa-session'], 'fresh');
  assert.equal(element.props.disabled, true, '还没拿到状态时开关是禁用且关闭的');
});

test('顶栏已经显示开关时，输入框工具行不再画第二个', async () => {
  const { exports } = await loadBundle(createReact());
  const client = createClientContext();
  exports.apply(client.ctx);
  const { component } = registrationOf(client, 'conversation.input.left');

  const cases = [
    ['第一条消息正在提交（engaging）', blankSession({ promptAttempted: true }), EMPTY_CONVERSATION],
    ['会话已经开动（blank 已翻转）', blankSession({ blank: false }), EMPTY_CONVERSATION],
    ['已经有活跃 target', blankSession(), { activeTargets: new Set(['chat']) }],
    ['会话正在跑', blankSession({ running: true }), EMPTY_CONVERSATION],
  ];
  for (const [why, session, conversation] of cases) {
    assert.equal(component(sessionScopeProps(session, conversation)), null, why);
  }
});

test('拿不到 conversation 包时退回 session.blank 判断，开关仍然出现在新对话页', async () => {
  const { exports } = await loadBundle(createReact([null, false, '']), { conversation: null });
  const client = createClientContext();
  exports.apply(client.ctx);
  const { component } = registrationOf(client, 'conversation.input.left');

  assert.equal(renderElement(component(sessionScopeProps(blankSession()))).type, 'button');
  assert.equal(component(sessionScopeProps(blankSession({ blank: false }))), null);
});

test('宿主没给作用域标准 Hook 时不画第二个开关', async () => {
  const { exports } = await loadBundle(createReact());
  const client = createClientContext();
  exports.apply(client.ctx);
  const { component } = registrationOf(client, 'conversation.input.left');

  assert.equal(component({ sessionId: 's1', t: (key) => key }), null);
});

test('未拿到状态时开关是禁用且关闭的（不会闪出一个假的开启态）', async () => {
  const { exports } = await loadBundle(createReact([null, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const element = client.registrations[0].component({ sessionId: 's1', t: (key) => key });

  assert.equal(element.type, 'button');
  assert.equal(element.props.role, 'switch');
  assert.equal(element.props['aria-checked'], false);
  assert.equal(element.props.disabled, true);
  assert.equal(element.props.className, 'laa-toggle');
  assert.equal(element.props['data-laa-session'], 's1');
});

test('开启且处于峰时：开关滑到右侧、轨道变成峰时色，提示里说明正在暂停', async () => {
  const state = {
    sessionId: 's1',
    enabled: true,
    phase: 'peak',
    masterEnabled: true,
    localNow: '2026-09-14 10:00（周一）',
    localNextChange: '2026-09-14 12:00（周一）',
    peakWindows: '周一至周五 09:00-12:00',
    timeZone: 'Asia/Shanghai',
    deferred: 2,
    suspended: false,
  };
  const { exports } = await loadBundle(createReact([state, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  // 用插件自己注册进 locale 的那份中文字典当翻译器，于是断言的就是用户真正看到的文案。
  const zh = client.dictionaries[0].dict.zh;
  const element = client.registrations[0].component({ sessionId: 's1', t: (key) => zh[key] ?? key });

  assert.equal(element.props['aria-checked'], true);
  assert.equal(element.props.disabled, false);
  assert.equal(element.props.className, 'laa-toggle is-on is-peak');
  assert.equal(element.props['data-laa-phase'], 'peak');
  assert.match(element.props.title, /^LAA 已开启$/m);
  assert.match(element.props.title, /当前时段：峰时（2026-09-14 10:00（周一））/);
  assert.match(element.props.title, /下一次切换：谷时 2026-09-14 12:00（周一）/);
  assert.match(element.props.title, /峰时窗口：周一至周五 09:00-12:00（Asia\/Shanghai）/);
  assert.match(element.props.title, /等待谷时：2 条暂存输入/);
  assert.match(element.props.title, /单击关闭 LAA 模式$/);

  const [track, label] = element.children;
  assert.equal(track.props.className, 'laa-toggle-track');
  assert.equal(track.children.props.className, 'laa-toggle-knob');
  assert.equal(label.props.className, 'laa-toggle-label');
  assert.equal(label.children, 'LAA');
});

test('子会话的悬停提示说明它跟随哪个父会话', async () => {
  const state = {
    sessionId: 'child',
    enabled: true,
    inheritedFrom: 'root',
    phase: 'valley',
    masterEnabled: true,
    localNow: '2026-09-14 12:30（周一）',
    localNextChange: '2026-09-14 14:00（周一）',
    peakWindows: '周一至周五 09:00-12:00',
    timeZone: 'Asia/Shanghai',
    deferred: 0,
    suspended: false,
  };
  const { exports } = await loadBundle(createReact([state, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const zh = client.dictionaries[0].dict.zh;
  const t = (key) => zh[key] ?? key;

  // 名册里查得到标题：提示里显示「标题（id）」。
  const roster = { ids: ['root'], byId: { root: { id: 'root', displayTitle: '重构会话' } }, current: 'child' };
  const named = client.registrations[0].component({ sessionId: 'child', t, useSessions: (selector) => selector(roster) });
  assert.match(named.props.title, /跟随父会话：重构会话（root）/);

  // 名册缺席或查不到：退回会话 id，提示里始终是一个对得上的身份。
  // （假 React 的 useState 是「按调用次数发牌」的，所以另开一份 bundle 实例。）
  const fallback = await loadBundle(createReact([state, false, '']));
  const bareClient = createClientContext();
  fallback.exports.apply(bareClient.ctx);
  const bare = bareClient.registrations[0].component({ sessionId: 'child', t });
  assert.match(bare.props.title, /跟随父会话：root/);
  assert.match(bare.props.title, /^LAA 已开启$/m);
});

test('顶层会话的悬停提示里没有「跟随父会话」这一行', async () => {
  const state = {
    sessionId: 'root',
    enabled: true,
    inheritedFrom: null,
    phase: 'valley',
    masterEnabled: true,
    localNow: '2026-09-14 12:30（周一）',
    localNextChange: '2026-09-14 14:00（周一）',
    peakWindows: '周一至周五 09:00-12:00',
    timeZone: 'Asia/Shanghai',
    deferred: 0,
    suspended: false,
  };
  const { exports } = await loadBundle(createReact([state, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const zh = client.dictionaries[0].dict.zh;
  const element = client.registrations[0].component({ sessionId: 'root', t: (key) => zh[key] ?? key });

  assert.doesNotMatch(element.props.title, /跟随父会话/);
  assert.match(element.props.title, /^LAA 已开启$/m);
});

test('峰谷切换：开关跳三下、平滑变色，并弹出浏览器通知', async (t) => {
  /* 轮询用的 setInterval 也交给假时钟，免得测试结束后还挂着一个真实定时器。 */
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { FakeNotification, created } = createNotification('granted');
  globalThis.Notification = FakeNotification;
  try {
    const harness = createStatefulReact();
    const { exports } = await loadBundle(harness.react);
    const client = createClientContext();
    exports.apply(client.ctx);
    const zh = client.dictionaries[0].dict.zh;
    const component = registrationOf(client, 'conversation.session.header.utilities').component;

    let current = controlState({ phase: 'valley' });
    globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: current }) });

    const props = { sessionId: 's1', t: (key) => zh[key] ?? key };
    harness.mount(component, props);
    harness.runEffects();
    await settle();

    assert.equal(harness.element.props['data-laa-phase'], 'valley');
    assert.equal(harness.element.props['data-laa-flip'], '', '第一次看到相位不算切换');
    assert.doesNotMatch(harness.element.props.className, /is-flipping/);
    assert.equal(created.length, 0, '页面刚打开时不打扰');

    /* 相位翻到峰时：跳三下（is-flipping）+ 平滑变色（CSS）+ 一条通知 */
    current = controlState({ phase: 'peak' });
    harness.runEffects();
    await settle();

    assert.match(harness.element.props.className, /is-flipping/, '切换时要播动画');
    assert.equal(harness.element.props['data-laa-flip'], 'peak');
    assert.equal(harness.element.props['data-laa-phase'], 'peak');
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'LAA · 进入峰时');
    assert.match(created[0].options.body, /会话已暂停/);
    assert.equal(created[0].options.tag, 'dsh-laa:s1', '同一会话的通知互相顶替');

    /* 动画窗口过去之后恢复常态 */
    t.mock.timers.tick(1400);
    assert.equal(harness.element.props['data-laa-flip'], '');
    assert.doesNotMatch(harness.element.props.className, /is-flipping/);

    /* 再翻回谷时：第二条通知，第二条动画 */
    current = controlState({ phase: 'valley' });
    harness.runEffects();
    await settle();
    assert.equal(created.length, 2);
    assert.equal(created[1].title, 'LAA · 进入谷时');
    assert.equal(harness.element.props['data-laa-flip'], 'valley');
    harness.unmount();
  } finally {
    delete globalThis.Notification;
  }
});

test('通知策略：默认只播报开着 LAA 的会话，always 也播报关着的，off 不播报', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { FakeNotification, created } = createNotification('granted');
  globalThis.Notification = FakeNotification;
  try {
    const harness = createStatefulReact();
    const { exports } = await loadBundle(harness.react);
    const client = createClientContext();
    exports.apply(client.ctx);
    const component = registrationOf(client, 'conversation.session.header.utilities').component;
    const props = { sessionId: 's1', t: (key) => key };

    await driveFlip(harness, component, props, controlState({ enabled: false }), controlState({ enabled: false, phase: 'peak' }));
    assert.equal(created.length, 0, '默认策略不播报关着 LAA 的会话');
    assert.equal(harness.element.props['data-laa-flip'], 'peak', '但动画照播');

    await driveFlip(harness, component, props, controlState({ enabled: false, notify: 'always' }), controlState({ enabled: false, notify: 'always', phase: 'peak' }));
    assert.equal(created.length, 1);
    assert.equal(created[0].title, 'flipPeakTitle', '用 always 策略时照播');

    await driveFlip(harness, component, props, controlState({ notify: 'off' }), controlState({ notify: 'off', phase: 'peak' }));
    assert.equal(created.length, 1, 'off 策略下不新增通知');
    harness.unmount();
  } finally {
    delete globalThis.Notification;
  }
});

test('没有 Notification API 时切换照常播动画，不抛错', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const harness = createStatefulReact();
  const { exports } = await loadBundle(harness.react);
  const client = createClientContext();
  exports.apply(client.ctx);
  const component = registrationOf(client, 'conversation.session.header.utilities').component;

  await driveFlip(harness, component, { sessionId: 's1', t: (key) => key }, controlState(), controlState({ phase: 'peak' }));
  assert.equal(harness.element.props['data-laa-flip'], 'peak');
  assert.equal(harness.element.props['data-laa-phase'], 'peak');
  harness.unmount();
});

test('点开关时顺手申请一次通知权限（浏览器要求用户手势）', async () => {
  const { FakeNotification, requests } = createNotification('default');
  globalThis.Notification = FakeNotification;
  try {
    const harness = createStatefulReact();
    const { exports } = await loadBundle(harness.react);
    const client = createClientContext();
    exports.apply(client.ctx);
    const component = registrationOf(client, 'conversation.session.header.utilities').component;
    const state = controlState({ enabled: false });
    globalThis.fetch = () => Promise.resolve({ json: () => Promise.resolve({ ok: true, value: state }) });

    harness.mount(component, { sessionId: 's1', t: (key) => key });
    harness.runEffects();
    await settle();
    assert.equal(requests(), 0, '光看页面不打扰用户');

    harness.element.props.onClick();
    await settle();
    assert.equal(requests(), 1, '用户点开关时正好有手势');
    harness.unmount();
  } finally {
    delete globalThis.Notification;
  }
});

test('提供方不按峰谷计费时，悬停提示说明峰时不会阻塞', async () => {
  const state = controlState({ enabled: true, phase: 'peak', peakBilled: false, provider: 'openai' });
  const { exports } = await loadBundle(createReact([state, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const zh = client.dictionaries[0].dict.zh;
  const element = client.registrations[0].component({ sessionId: 's1', t: (key) => zh[key] ?? key });

  assert.match(element.props.title, /峰时不会阻塞：这个提供方不按峰谷计费（openai）/);

  /* 受峰时约束时不出现这一行（另开一份 bundle 实例，假 React 的 useState 按调用次数发牌） */
  const billed = await loadBundle(createReact([controlState({ enabled: true, phase: 'peak', peakBilled: true, provider: 'deepseek-official' }), false, '']));
  const billedClient = createClientContext();
  billed.exports.apply(billedClient.ctx);
  const billedElement = billedClient.registrations[0].component({ sessionId: 's1', t: (key) => zh[key] ?? key });
  assert.doesNotMatch(billedElement.props.title, /峰时不会阻塞/);
});

test('单击开关会把新状态 POST 给控制面', async () => {
  const state = {
    sessionId: 's1',
    enabled: true,
    phase: 'valley',
    masterEnabled: true,
    localNow: '2026-09-14 12:30（周一）',
    localNextChange: '2026-09-14 14:00（周一）',
    peakWindows: '周一至周五 09:00-12:00',
    timeZone: 'Asia/Shanghai',
    deferred: 0,
    suspended: false,
  };
  const { exports } = await loadBundle(createReact([state, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const element = client.registrations[0].component({ sessionId: 's1', t: (key) => key });

  const calls = [];
  globalThis.fetch = (url, options) => {
    calls.push({ url, options });
    return Promise.resolve({ json: () => Promise.resolve({ ok: true, value: { ...state, enabled: false } }) });
  };

  element.props.onClick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/dsh-laa/mode');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: 's1', enabled: false });
});

test('总开关关闭时按钮禁用，并且不会发出写请求', async () => {
  const state = {
    sessionId: 's1',
    enabled: false,
    phase: 'valley',
    masterEnabled: false,
    localNow: '2026-09-14 12:30（周一）',
    localNextChange: '2026-09-14 14:00（周一）',
    peakWindows: '周一至周五 09:00-12:00',
    timeZone: 'Asia/Shanghai',
    deferred: 0,
    suspended: false,
  };
  const { exports } = await loadBundle(createReact([state, false, '']));
  const client = createClientContext();
  exports.apply(client.ctx);
  const zh = client.dictionaries[0].dict.zh;
  const element = client.registrations[0].component({ sessionId: 's1', t: (key) => zh[key] ?? key });

  assert.equal(element.props.disabled, true);
  assert.match(element.props.title, /dsh-laa 已被配置禁用（enabled: false）/);
  assert.doesNotMatch(element.props.title, /单击/);
  const calls = [];
  globalThis.fetch = (url) => { calls.push(url); return Promise.reject(new Error('must not be called')); };
  element.props.onClick();
  assert.deepEqual(calls, []);
});
