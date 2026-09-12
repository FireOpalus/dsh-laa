#!/usr/bin/env node
/**
 * 隔离测试环境：在工作区里建一个只属于本仓库的 DSH home（`.dsh-test/`）。
 *
 * 它和 `~/.dsh`（含里面的 `web` profile）完全分开：会话、设置、插件、以及
 * dsh-laa 自己的 `laa/state.json` 都落在 `.dsh-test/` 下，测试本插件不会碰到
 * 你日常在用的那个 home。
 *
 *   node scripts/dev-home.mjs                    # 创建/修复环境，打印状态
 *   node scripts/dev-home.mjs --boot             # 创建后启动 dsh web（Ctrl+C 退出）
 *   node scripts/dev-home.mjs --boot -- --port 64100 --no-open
 *   node scripts/dev-home.mjs --refresh-credentials
 *   node scripts/dev-home.mjs --no-credentials   # 不带 API key 建环境
 *
 * 幂等：重复运行只会补齐缺失的东西，不会覆盖你已经改过的文件。
 *
 * @module dsh-laa/scripts/dev-home
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const ENV_DIR = join(REPO, '.dsh-test');
export const REAL_HOME = process.env.REAL_DSH_HOME ?? join(homedir(), '.dsh');
export const DEFAULT_PORT = '63990';

/** 插件仓库自身的版本。 */
export function pluginVersion() {
  return readJson(join(REPO, 'package.json'))?.version ?? '?';
}

/** 只在文件缺失时写入；返回是否真的写了。 */
function writeIfMissing(path, content) {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return true;
}

/** 读一个 JSON 文件，读不到就返回 undefined。 */
export function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 建立（或修复）指向插件仓库的目录链接。 */
function linkPlugin(profileDir) {
  const link = join(profileDir, 'node_modules', 'dsh-laa');
  mkdirSync(dirname(link), { recursive: true });
  if (existsSync(link)) {
    let current;
    try {
      current = realpathSync(link);
    } catch {
      current = undefined;
    }
    if (current === realpathSync(REPO)) return { link, state: 'kept' };
    rmSync(link, { recursive: true, force: true });
  }
  symlinkSync(REPO, link, process.platform === 'win32' ? 'junction' : 'dir');
  return { link, state: 'created' };
}

/** 建一个带了 dsh-laa bundle 的 profile。 */
export function provisionProfile(name, { bundles, patchReload, patch }) {
  const profileDir = join(ENV_DIR, 'profiles', name);
  mkdirSync(profileDir, { recursive: true });

  // 与 dsh-app-boot 的同名模板一致，只是多了一个 dsh-laa bundle。
  const manifestPath = join(profileDir, 'package.json');
  const manifest = readJson(manifestPath) ?? {
    name: `dsh-profile-${name}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patchReload } },
  };
  manifest.name ??= `dsh-profile-${name}`;
  manifest.private = true;
  manifest.dependencies = { ...manifest.dependencies, 'dsh-laa': 'link:../../..' };
  manifest.dsh ??= { profile: { bundles: [], patchReload } };
  manifest.dsh.profile.bundles ??= [];
  manifest.dsh.profile.patchReload = patchReload;
  for (const bundle of bundles) {
    if (!manifest.dsh.profile.bundles.includes(bundle)) manifest.dsh.profile.bundles.push(bundle);
  }
  // dsh-laa 必须排在最后：bundle 的 patch 层按顺序叠加。
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((entry) => entry !== 'dsh-laa');
  manifest.dsh.profile.bundles.push('dsh-laa');
  const next = `${JSON.stringify(manifest, undefined, 2)}\n`;
  const previous = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  writeFileSync(manifestPath, next, 'utf8');

  const wroteProfileRoot = writeIfMissing(join(profileDir, 'cordis.yml'), `# dsh profile root —— 空入口列表，树由各 bundle 的 patch 层叠加而成。
# 只属于 .dsh-test 这个隔离环境；改配置请改 cordis.patch.yml。
[]
`);
  const wrotePatch = writeIfMissing(join(profileDir, 'cordis.patch.yml'), patch);
  const wrotePnpm = writeIfMissing(join(profileDir, 'pnpm-workspace.yaml'), `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`);
  const { link, state } = linkPlugin(profileDir);

  return { name, profileDir, link, linkState: state, manifestChanged: previous !== next, wrote: [wroteProfileRoot && 'cordis.yml', wrotePatch && 'cordis.patch.yml', wrotePnpm && 'pnpm-workspace.yaml'].filter(Boolean) };
}

/** 交互式 web 环境的 patch 层模板。 */
const WEB_PATCH = `# 本文件只是 .dsh-test 隔离环境的用户 patch 层，不会影响 ~/.dsh/profiles/web。
#
# 覆盖 dsh-laa 时请写【完整】config：patch 是整体替换而不是逐字段合并。
# 下面两段默认注释掉——不启用时走 dsh-laa 自带的官方峰时口径
# （北京时间周一至周五 09:00-12:00、14:00-18:00，其余为谷时）。
#
# 想立刻看到「峰时停机」：把窗口设成整天。保存即可，profile 是 patchReload: live，
# 加载器会重新应用插件、运行时立刻按新窗口评估相位。
# - id: laa
#   config:
#     enabled: true
#     defaultMode: true
#     timeZone: 'Asia/Shanghai'
#     peakWindows:
#       - days: [mon, tue, wed, thu, fri, sat, sun]
#         start: '00:00'
#         end: '23:59'
#
# 想接着看到「谷时续跑」：把上面那行的 end 改成 '00:01'（每天只有头一分钟是峰时）。
# - id: laa
#   config:
#     enabled: true
#     defaultMode: true
#     timeZone: 'Asia/Shanghai'
#     peakWindows:
#       - days: [mon, tue, wed, thu, fri, sat, sun]
#         start: '00:00'
#         end: '00:01'
[]
`;

/**
 * headless 环境的 patch 层：峰时窗口设成整天。
 *
 * 这样任何步骤都会被拒绝，模型请求根本发不出去——但真实的 agent loop、会话、
 * 插件运行时全都被走到，于是 `npm run e2e` 能零成本地验证「峰时确实停住了」。
 */
const HEADLESS_PATCH = `# .dsh-test 的 headless profile：只用来自动化验证，不用于日常会话。
# 窗口设成整天 → 任何步骤都会被拒绝，因此不会有任何模型请求发出。
- id: laa
  config:
    enabled: true
    defaultMode: true
    timeZone: 'Asia/Shanghai'
    peakWindows:
      - days: [mon, tue, wed, thu, fri, sat, sun]
        start: '00:00'
        end: '23:59'
    tickMs: 30000
`;

/**
 * 把真实 home 的凭据复制进隔离环境。
 *
 * 隔离环境是另一个 DSH home，因此看不到 `~/.dsh/.credentials.yaml`；没有它这个
 * 环境一次模型请求都发不出去，也就测不了插件的实际行为。这里复制一份（目标是
 * 被 gitignore 的工作区目录）——脚本从不读取或打印密钥值本身。
 * @returns 一行状态描述。
 */
export function seedCredentials({ refresh = false, skip = false } = {}) {
  const source = join(REAL_HOME, '.credentials.yaml');
  const target = join(ENV_DIR, '.credentials.yaml');
  if (skip) return '已跳过（--no-credentials）';
  if (!existsSync(source)) return `真实 home 里没有 ${source}；这个环境将无法调用模型`;
  if (existsSync(target) && !refresh) return '已存在（--refresh-credentials 可重新同步）';
  copyFileSync(source, target);
  return refresh ? '已重新同步' : '已复制一份（内容不打印）';
}

/** 建立整个隔离 home：web 与 headless 两个 profile。 */
export function provision() {
  mkdirSync(ENV_DIR, { recursive: true });
  return {
    web: provisionProfile('web', {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
      patchReload: 'live',
      patch: WEB_PATCH,
    }),
    headless: provisionProfile('headless', {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
      patchReload: 'startup',
      patch: HEADLESS_PATCH,
    }),
  };
}

/** 按 Windows 命令行的引号规则转义一个参数。 */
function quoteArgument(value) {
  if (value === '') return '""';
  if (!/[\s"^&|<>()]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/**
 * 在隔离环境里跑一条 dsh 命令。
 *
 * `stdio: 'inherit'` 是有意的：它在受限沙箱下也能工作，并且把子进程的输出原样
 * 交给调用方；需要判定结果时读退出码与 `.dsh-test/laa/state.json`，而不是抓 stdout。
 * @param args - 启动器参数。
 * @param options - `env` 覆盖与 `profile` 名（仅用于日志）。
 * @returns 子进程的 `exit` 事件 Promise。
 */
export function runDsh(args, options = {}) {
  const bin = process.env.DSH_BIN ?? 'dsh';
  const spawnOptions = { env: { ...process.env, DSH_HOME: ENV_DIR, ...options.env }, stdio: 'inherit' };
  /*
   * Windows 上 `dsh` 是 `dsh.cmd`，Node 只肯经 shell 执行它；把整条命令拼成一个
   * 字符串交给 shell（而不是 shell + args 数组）可以避免 Node 的 DEP0190 警告。
   */
  const child = process.platform === 'win32'
    ? spawn([bin, ...args].map(quoteArgument).join(' '), { ...spawnOptions, shell: true })
    : spawn(bin, args, spawnOptions);
  return new Promise((settle, fail) => {
    child.on('exit', (code) => settle(code ?? 0));
    child.on('error', fail);
  });
}

/** 启动隔离环境里的 dsh web；调用方给过的 flag 不会被默认值覆盖。 */
function boot(extra) {
  const args = ['--profile', 'web', ...extra];
  if (!extra.includes('--port')) args.push('--port', DEFAULT_PORT);
  if (!extra.includes('--no-open')) args.push('--no-open');
  console.log(`\n启动：${process.env.DSH_BIN ?? 'dsh'} ${args.join(' ')}`);
  console.log(`DSH_HOME=${ENV_DIR}\n`);
  runDsh(args).then((code) => process.exit(code), (error) => {
    console.error(`dsh-laa: 无法启动 dsh：${error.message}`);
    console.error('用 DSH_BIN=<dsh 可执行文件路径> 指定，或把 dsh 放进 PATH。');
    process.exit(1);
  });
}

/** CLI 入口。 */
function main() {
  const argv = process.argv.slice(2);
  const bootIndex = argv.indexOf('--');
  const flags = new Set(bootIndex >= 0 ? argv.slice(0, bootIndex) : argv);
  const bootArgs = bootIndex >= 0 ? argv.slice(bootIndex + 1) : [];

  const status = provision();
  const credentials = seedCredentials({ refresh: flags.has('--refresh-credentials'), skip: flags.has('--no-credentials') });

  console.log('dsh-laa 隔离测试环境');
  console.log(`  仓库          ${REPO}（dsh-laa ${pluginVersion()}）`);
  console.log(`  DSH_HOME      ${ENV_DIR}`);
  for (const profile of [status.web, status.headless]) {
    console.log(`  ${profile.name.padEnd(13)} ${profile.profileDir}`);
    console.log(`  插件链接      ${profile.link} -> ${REPO}（${profile.linkState}）`);
  }
  console.log(`  与真实 home  ${REAL_HOME} 相互独立：会话、设置、插件与 laa/state.json 都在上面这个 DSH_HOME 下`);
  console.log(`  凭据          ${credentials}`);
  for (const profile of [status.web, status.headless]) {
    if (profile.wrote.length > 0) console.log(`  新写入        ${profile.name}: ${profile.wrote.join('、')}`);
    if (profile.manifestChanged) console.log(`  已更新        ${profile.name}: profile package.json 的 bundle 列表`);
  }
  console.log('\n启动：node scripts/dev-home.mjs --boot');
  console.log('零成本端到端验证：npm run e2e');

  if (flags.has('--boot')) boot(bootArgs);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main();
