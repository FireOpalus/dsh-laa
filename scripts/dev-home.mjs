#!/usr/bin/env node
/**
 * 隔离测试环境：在工作区里建一个只属于本仓库的 DSH home。
 *
 * 它和 `~/.dsh`（含里面的 `web` profile）完全分开：会话、设置、插件、以及
 * dsh-laa 自己的 `laa/state.json` 都落在 `.dsh-test/` 下，测试本插件不会碰到
 * 你日常在用的那个 profile。
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
import { fileURLToPath } from 'node:url';

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)));
const ENV_DIR = join(REPO, '.dsh-test');
const PROFILE_DIR = join(ENV_DIR, 'profiles', 'web');
const PLUGIN_LINK = join(PROFILE_DIR, 'node_modules', 'dsh-laa');
const REAL_HOME = process.env.REAL_DSH_HOME ?? join(homedir(), '.dsh');
const DEFAULT_PORT = '63990';

const argv = process.argv.slice(2);
const bootIndex = argv.indexOf('--');
const flags = new Set(bootIndex >= 0 ? argv.slice(0, bootIndex) : argv);
const bootArgs = bootIndex >= 0 ? argv.slice(bootIndex + 1) : [];
const shouldBoot = flags.has('--boot');
const refreshCredentials = flags.has('--refresh-credentials');
const skipCredentials = flags.has('--no-credentials');

/** 只在文件缺失时写入；返回是否真的写了。 */
function writeIfMissing(path, content) {
  if (existsSync(path)) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return true;
}

/** 读一个 JSON 文件，读不到就返回 undefined。 */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 建立（或修复）指向插件仓库的目录链接。 */
function linkPlugin() {
  mkdirSync(dirname(PLUGIN_LINK), { recursive: true });
  if (existsSync(PLUGIN_LINK)) {
    let current;
    try {
      current = realpathSync(PLUGIN_LINK);
    } catch {
      current = undefined;
    }
    if (current === realpathSync(REPO)) return 'kept';
    rmSync(PLUGIN_LINK, { recursive: true, force: true });
  }
  symlinkSync(REPO, PLUGIN_LINK, process.platform === 'win32' ? 'junction' : 'dir');
  return 'created';
}

/**
 * 把真实 home 的凭据复制进隔离环境。
 *
 * 隔离环境是另一个 DSH home，因此看不到 `~/.dsh/.credentials.yaml`；没有它这个
 * 环境一次模型请求都发不出去，也就测不了插件的实际行为。这里复制一份（目标是
 * 被 gitignore 的工作区目录），并把真实文件里的内容原样保留——脚本从不读取或
 * 打印密钥值本身。
 * @returns 一行状态描述。
 */
function seedCredentials() {
  const source = join(REAL_HOME, '.credentials.yaml');
  const target = join(ENV_DIR, '.credentials.yaml');
  if (skipCredentials) return '已跳过（--no-credentials）';
  if (!existsSync(source)) return `真实 home 里没有 ${source}；这个环境将无法调用模型`;
  if (existsSync(target) && !refreshCredentials) return '已存在（--refresh-credentials 可重新同步）';
  copyFileSync(source, target);
  return refreshCredentials ? '已重新同步' : '已复制一份（内容不打印）';
}

/** 插件仓库自身的版本，用于状态输出。 */
function pluginVersion() {
  return readJson(join(REPO, 'package.json'))?.version ?? '?';
}

/** 建立隔离 home 的骨架。 */
function provision() {
  mkdirSync(PROFILE_DIR, { recursive: true });

  // 与 dsh-app-boot 的 web 模板一致，只是多了一个 dsh-laa bundle。
  const manifestPath = join(PROFILE_DIR, 'package.json');
  const manifest = readJson(manifestPath) ?? {
    name: 'dsh-profile-laa-test',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patchReload: 'live' } },
  };
  manifest.name ??= 'dsh-profile-laa-test';
  manifest.private = true;
  manifest.dependencies = { ...manifest.dependencies, 'dsh-laa': 'link:../../..' };
  manifest.dsh ??= { profile: { bundles: [], patchReload: 'live' } };
  manifest.dsh.profile.bundles ??= [];
  manifest.dsh.profile.patchReload = 'live';
  for (const bundle of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    if (!manifest.dsh.profile.bundles.includes(bundle)) manifest.dsh.profile.bundles.push(bundle);
  }
  // dsh-laa 必须排在最后：bundle 的 patch 层按顺序叠加。
  manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== 'dsh-laa');
  manifest.dsh.profile.bundles.push('dsh-laa');
  const manifestBefore = existsSync(manifestPath) ? readFileSync(manifestPath, 'utf8') : '';
  writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8');
  const manifestChanged = manifestBefore !== readFileSync(manifestPath, 'utf8');

  const wroteProfileRoot = writeIfMissing(join(PROFILE_DIR, 'cordis.yml'), `# dsh profile root —— 空入口列表，树由各 bundle 的 patch 层叠加而成。
# 只属于 .dsh-test 这个隔离环境；改配置请改 cordis.patch.yml。
[]
`);

  const wrotePatch = writeIfMissing(join(PROFILE_DIR, 'cordis.patch.yml'), `# 本文件只是 .dsh-test 隔离环境的用户 patch 层，不会影响 ~/.dsh/profiles/web。
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
`);

  const wrotePnpm = writeIfMissing(join(PROFILE_DIR, 'pnpm-workspace.yaml'), `packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
`);

  const link = linkPlugin();
  const credentials = seedCredentials();

  return { manifestChanged, link, credentials, wrote: [wroteProfileRoot && 'cordis.yml', wrotePatch && 'cordis.patch.yml', wrotePnpm && 'pnpm-workspace.yaml'].filter(Boolean) };
}

/** 按 Windows 命令行的引号规则转义一个参数。 */
function quoteArgument(value) {
  if (value === '') return '""';
  if (!/[\s"^&|<>()]/.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
}

/** 启动隔离环境里的 dsh web；调用方给过的 flag 不会被默认值覆盖。 */
function boot(extra) {
  const bin = process.env.DSH_BIN ?? 'dsh';
  const args = ['--profile', 'web', ...extra];
  if (!extra.includes('--port')) args.push('--port', DEFAULT_PORT);
  if (!extra.includes('--no-open')) args.push('--no-open');
  console.log(`\n启动：${bin} ${args.join(' ')}`);
  console.log(`DSH_HOME=${ENV_DIR}\n`);
  const options = { env: { ...process.env, DSH_HOME: ENV_DIR }, stdio: 'inherit' };
  /*
   * Windows 上 `dsh` 是 `dsh.cmd`，Node 只肯经 shell 执行它；把整条命令拼成一个
   * 字符串交给 shell（而不是 shell + args 数组）可以避免 Node 的 DEP0190 警告，
   * 转义也由这里的 quoteArgument 负责。其它平台直接 exec，不经 shell。
   */
  const child = process.platform === 'win32'
    ? spawn([bin, ...args].map(quoteArgument).join(' '), { ...options, shell: true })
    : spawn(bin, args, options);
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (error) => {
    console.error(`dsh-laa: 无法启动 ${bin}：${error.message}`);
    console.error('用 DSH_BIN=<dsh 可执行文件路径> 指定，或把 dsh 放进 PATH。');
    process.exit(1);
  });
}

const status = provision();

console.log(`dsh-laa 隔离测试环境`);
console.log(`  仓库          ${REPO}（dsh-laa ${pluginVersion()}）`);
console.log(`  DSH_HOME      ${ENV_DIR}`);
console.log(`  web profile   ${PROFILE_DIR}`);
console.log(`  插件链接      ${PLUGIN_LINK} -> ${REPO}（${status.link}）`);
console.log(`  与真实 home  ${REAL_HOME} 相互独立：会话、设置、插件与 laa/state.json 都在上面这个 DSH_HOME 下`);
console.log(`  凭据          ${status.credentials}`);
if (status.wrote.length > 0) console.log(`  新写入        ${status.wrote.join('、')}`);
if (status.manifestChanged) console.log('  已更新        profile package.json 的 bundle 列表');
console.log(`\n启动：node scripts/dev-home.mjs --boot`);

if (shouldBoot) boot(bootArgs);
