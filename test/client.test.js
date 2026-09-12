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

let bundleEntry;

/**
 * 载入 bundle，并针对本次测试调用一次工厂。
 *
 * ESM 的模块体只会求值一次，所以 `window.__ModuleLoader__.load()` 也只会被调用一次；
 * 这正是真实加载器的行为（模块求值一次，工厂按需调用）。每个测试拿到的是同一份
 * bundle 注册记录，但各自一份全新的模块导出与 `document`。
 */
async function loadBundle(react) {
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
  const exports = bundleEntry.factory((name) => {
    assert.equal(name, 'react', 'bundle 只应请求 react');
    return react;
  });
  return { id: bundleEntry.id, exports, document };
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

test('apply() 注入样式与中英字典，并把开关注册进会话顶栏工具区', async () => {
  const { exports, document } = await loadBundle(createReact());
  const client = createClientContext();
  exports.apply(client.ctx);

  assert.equal(document.appended.length, 1, '样式必须被注入一次');
  assert.equal(document.appended[0].tag, 'style');
  assert.equal(document.appended[0].attributes['data-plugin'], 'dsh-laa');
  assert.match(document.appended[0].textContent, /\.laa-toggle\.is-on \.laa-toggle-knob\{transform:translateX\(16px\)\}/);
  assert.match(document.appended[0].textContent, /\.laa-toggle\.is-peak \.laa-toggle-track\{background:#d08b2c\}/);

  assert.deepEqual(client.dictionaries.map((item) => item.namespace), ['dsh-laa']);
  assert.equal(typeof client.dictionaries[0].dict.zh.aria, 'string');
  assert.equal(typeof client.dictionaries[0].dict.en.aria, 'string');

  assert.deepEqual(client.slots.injected, ['conversation.session.header.utilities']);
  assert.equal(client.registrations.length, 1);
  const { options, component } = client.registrations[0];
  assert.equal(options.name, 'conversation.session.header.utilities');
  assert.equal(options.id, 'dsh-laa');
  assert.equal(options.order, 95);
  assert.equal(options.locale, 'dsh-laa');
  assert.deepEqual(options.inject('session-7'), { sessionId: 'session-7' });
  assert.equal(typeof component, 'function');

  // 卸载路径：每个 effect 都得给出一个可调用的清理函数。
  assert.deepEqual(client.effects.map((item) => item.label), [
    'dsh-laa: styles',
    'dsh-laa: dictionaries',
    'dsh-laa: session header toggle',
  ]);
  for (const effect of client.effects) assert.equal(typeof effect.dispose, 'function');
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
