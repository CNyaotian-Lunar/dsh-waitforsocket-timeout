#!/usr/bin/env node
/**
 * dsh-waitforsocket-timeout —— 给 DSH 的 Remote stream socket 加一条「连接超时」兜底。
 *
 * 为什么需要它（上游缺陷）：
 *   `@deepseek-ai/dsh-api-gateway` 里，
 *   · `waitForSocket(signal)` 没有超时 —— 只能在 socket 变 OPEN 或调用方 abort 时结束；
 *   · `maintain()` 只在 connect **失败**时才去 reject 等待者；
 *   · `keepAlive` 只在那次 connect **settle 之后**才清空，而 `maintain()` 开头见 `keepAlive` 非空就直接 return。
 *   三者叠加 ⇒ 一旦 socket 卡在 CONNECTING（既不 open 也不 error），
 *   等待者永久 pending ⇒ `await events.open(...)` 永不返回 ⇒ GUI 永久停在「加载历史」，
 *   且重复点击无效、只有刷新页面能恢复。
 *
 * 这个补丁做的事：给每次连接尝试加一个硬死线（默认 10 秒）。到点仍未 settle，
 * 就主动放弃这次尝试 ⇒ 失败分支接手 ⇒ 等待者被 reject、并且会触发下一次重试。
 *
 * ⚠️ 它必须打在**两个文件上**（2026-09-25 才发现这一点）：
 *   ① `lib/types/client/stream-client.js` —— 源码（给直接 import 它的工具/测试用）；
 *   ② `lib/client.js`                     —— **真正的运行时代码**：它是 `window.__ModuleLoader__.load({factory})`
 *      形式的**打包产物**，把 stream-client 的代码**内联**了；浏览器加载的是它，不是 ①。
 *      只打 ① 对页面完全无效（离线单测会因为直接 import 源码而"假绿"）。
 *
 * ⚠️ 这是**临时补丁**，不是上游代码；上游修好后请 `revert` 并卸载。
 *   补丁可能被 `pnpm install`/重装冲掉 ⇒ 冲掉后重跑一次 `apply` 即可。
 *
 * 用法：
 *   node patch.mjs apply   [--dsh <DSH 根>] [--timeout-ms 10000]
 *   node patch.mjs revert  [--dsh <DSH 根>]
 *   node patch.mjs verify  [--dsh <DSH 根>]
 *   node patch.mjs where                 # 只打印定位到的目标文件
 *
 * 退出码：0 成功 / 1 用法或定位失败 / 2 锚点不匹配（版本可能不同）/ 3 语法自检失败
 *
 * 本工具由 DeepSeek（DSH agent）编写，CNyaotian 维护。MIT。
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync, statSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const PKG_REL = path.join('node_modules', '@deepseek-ai', 'dsh-api-gateway')
const MARK = 'dsh-waitforsocket-timeout'
const BAK_SUFFIX = '.bak-dsh-waitforsocket-timeout'
const DEFAULT_TIMEOUT_MS = 5000

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2)
const action = argv[0]
const flag = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def
}
const TIMEOUT_MS = Number(flag('--timeout-ms', String(DEFAULT_TIMEOUT_MS)))
const EXPLICIT_DSH = flag('--dsh', process.env.DSH_ROOT || '')

if (!['apply', 'revert', 'verify', 'where'].includes(action)) {
  console.error('用法: node patch.mjs <apply|revert|verify|where> [--dsh <DSH 根>] [--timeout-ms 10000]')
  process.exit(1)
}
if (action === 'apply' && (!Number.isFinite(TIMEOUT_MS) || TIMEOUT_MS < 1000 || TIMEOUT_MS > 600000)) {
  console.error('--timeout-ms 需要在 1000 ~ 600000 之间')
  process.exit(1)
}

// ─────────────────────────── 定位 DSH 根 ───────────────────────────
function candidates() {
  const out = []
  if (EXPLICIT_DSH) out.push(EXPLICIT_DSH)
  // ⚠️ 顺序：显式 > 常见自定义安装根 > npm 全局。
  // 本机 npm 全局里留着一份**旧版** dsh（已不作默认入口），排前面会去给没在跑的安装打补丁。
  out.push('D:\\dsh', 'C:\\dsh')
  const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  out.push(path.join(appdata, 'npm', 'node_modules', '@deepseek-ai', 'dsh'))
  out.push(process.cwd())
  return [...new Set(out)]
}
function packageExists(root) {
  return existsSync(path.join(root, PKG_REL, 'package.json'))
}
const rootsTried = candidates()
const rootsHit = rootsTried.filter(packageExists)
if (rootsHit.length === 0) {
  console.error('❌ 没找到 @deepseek-ai/dsh-api-gateway，试过：')
  for (const t of rootsTried) console.error('   ' + path.join(t, PKG_REL))
  console.error('\n请用 `--dsh <DSH 安装根>` 显式指定。')
  process.exit(1)
}
const DSH_ROOT = rootsHit[0]
if (rootsHit.length > 1) {
  console.log('⚠️ 发现 ' + rootsHit.length + ' 个 DSH 安装，本次使用**第一个**：' + DSH_ROOT)
  for (const r of rootsHit) console.log('   ' + r)
  console.log('   若目标不对，请用 `--dsh <DSH 安装根>` 指定。\n')
}

// ─────────────────────────── 两个目标 ───────────────────────────
// ① 源码：普通 ESM，4 空格缩进、单引号、undefined。
const SRC_BEFORE = `    connect() {
        const socket = new WebSocket(remoteStreamUrl());
        const connecting = new Promise((resolve, reject) => {
            let settled = false;
            const rejectCandidate = (error) => {
                settled = true;
                socket.removeEventListener('open', opened);
                socket.removeEventListener('error', failed);
                socket.removeEventListener('message', received);
                socket.removeEventListener('close', closed);
                this.cancelCandidate = undefined;
                socket.close();
                reject(error);
            };
            const opened = () => {
                settled = true;
                this.cancelCandidate = undefined;
                this.socket = socket;
                for (const waiter of [...this.waiters])
                    waiter.resolve(socket);
                resolve(socket);
            };
            const failed = () => {
                if (!settled) {
                    rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open'));
                    return;
                }
                const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed');
                this.lost(socket, error);
                socket.close();
            };
            const closed = () => {
                if (!settled) {
                    rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket closed before opening'));
                    return;
                }
                this.lost(socket);
            };
            const received = (event) => { this.receive(socket, event.data); };
            this.cancelCandidate = rejectCandidate;
            socket.addEventListener('open', opened, { once: true });
            socket.addEventListener('error', failed, { once: true });
            socket.addEventListener('message', received);
            socket.addEventListener('close', closed, { once: true });
        });
        return connecting;`
const SRC_AFTER = `    connect() {
        const socket = new WebSocket(remoteStreamUrl());
        const connecting = new Promise((resolve, reject) => {
            let settled = false;
            /* PATCH(${MARK}:connect): 连接超时兜底。见本方法末尾的 setTimeout。 */
            let connectTimer;
            const rejectCandidate = (error) => {
                settled = true;
                clearTimeout(connectTimer);
                socket.removeEventListener('open', opened);
                socket.removeEventListener('error', failed);
                socket.removeEventListener('message', received);
                socket.removeEventListener('close', closed);
                this.cancelCandidate = undefined;
                socket.close();
                reject(error);
            };
            const opened = () => {
                settled = true;
                clearTimeout(connectTimer);
                this.cancelCandidate = undefined;
                this.socket = socket;
                for (const waiter of [...this.waiters])
                    waiter.resolve(socket);
                resolve(socket);
            };
            const failed = () => {
                if (!settled) {
                    rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed to open'));
                    return;
                }
                const error = new RemoteStreamCarrierError('api gateway: Remote stream WebSocket failed');
                this.lost(socket, error);
                socket.close();
            };
            const closed = () => {
                if (!settled) {
                    rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket closed before opening'));
                    return;
                }
                this.lost(socket);
            };
            const received = (event) => { this.receive(socket, event.data); };
            this.cancelCandidate = rejectCandidate;
            socket.addEventListener('open', opened, { once: true });
            socket.addEventListener('error', failed, { once: true });
            socket.addEventListener('message', received);
            socket.addEventListener('close', closed, { once: true });
            /* PATCH(${MARK}:connect) —— 本地补丁，非上游代码。
             * 上游缺陷：socket 既不开也不报错时，connect() 的 promise 永不 settle，
             * 于是 maintain() 的失败分支永不执行、keepAlive 永不清空（不再重试），
             * 而 waitForSocket() 又没有超时 ⇒ 等待者永久 pending ⇒ UI 永久「加载中」。
             * 这里给每次连接尝试加一个硬死线：到点仍未 settle 就主动放弃这次尝试，
             * 让失败分支接手（等待者会被 reject、并触发下一次重试）。
             * 对应上游建议：给 waitForSocket() 加超时 / maintain() 收尾无条件 reject 全部 waiters。 */
            connectTimer = setTimeout(() => {
                if (!settled) rejectCandidate(new RemoteStreamCarrierError('api gateway: Remote stream WebSocket connect timed out'));
            }, ${TIMEOUT_MS});
        });
        return connecting;`

// ② 打包产物：window.__ModuleLoader__ 形式，**tab 缩进**、双引号、void 0。
const BUNDLE_BEFORE = `\t\t\tconnect() {
\t\t\t\tconst socket = new WebSocket(remoteStreamUrl());
\t\t\t\treturn new Promise((resolve, reject) => {
\t\t\t\t\tlet settled = false;
\t\t\t\t\tconst rejectCandidate = (error) => {
\t\t\t\t\t\tsettled = true;
\t\t\t\t\t\tsocket.removeEventListener("open", opened);
\t\t\t\t\t\tsocket.removeEventListener("error", failed);
\t\t\t\t\t\tsocket.removeEventListener("message", received);
\t\t\t\t\t\tsocket.removeEventListener("close", closed);
\t\t\t\t\t\tthis.cancelCandidate = void 0;
\t\t\t\t\t\tsocket.close();
\t\t\t\t\t\treject(error);
\t\t\t\t\t};
\t\t\t\t\tconst opened = () => {
\t\t\t\t\t\tsettled = true;
\t\t\t\t\t\tthis.cancelCandidate = void 0;
\t\t\t\t\t\tthis.socket = socket;
\t\t\t\t\t\tfor (const waiter of [...this.waiters]) waiter.resolve(socket);
\t\t\t\t\t\tresolve(socket);
\t\t\t\t\t};
\t\t\t\t\tconst failed = () => {
\t\t\t\t\t\tif (!settled) {
\t\t\t\t\t\t\trejectCandidate(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket failed to open"));
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tconst error = new RemoteStreamCarrierError("api gateway: Remote stream WebSocket failed");
\t\t\t\t\t\tthis.lost(socket, error);
\t\t\t\t\t\tsocket.close();
\t\t\t\t\t};
\t\t\t\t\tconst closed = () => {
\t\t\t\t\t\tif (!settled) {
\t\t\t\t\t\t\trejectCandidate(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket closed before opening"));
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tthis.lost(socket);
\t\t\t\t\t};
\t\t\t\t\tconst received = (event) => {
\t\t\t\t\t\tthis.receive(socket, event.data);
\t\t\t\t\t};
\t\t\t\t\tthis.cancelCandidate = rejectCandidate;
\t\t\t\t\tsocket.addEventListener("open", opened, { once: true });
\t\t\t\t\tsocket.addEventListener("error", failed, { once: true });
\t\t\t\t\tsocket.addEventListener("message", received);
\t\t\t\t\tsocket.addEventListener("close", closed, { once: true });
\t\t\t\t});
\t\t\t}`
const BUNDLE_AFTER = `\t\t\tconnect() {
\t\t\t\tconst socket = new WebSocket(remoteStreamUrl());
\t\t\t\treturn new Promise((resolve, reject) => {
\t\t\t\t\tlet settled = false;
\t\t\t\t\t/* PATCH(${MARK}:connect): 连接超时兜底。见本方法末尾的 setTimeout。 */
\t\t\t\t\tlet connectTimer;
\t\t\t\t\tconst rejectCandidate = (error) => {
\t\t\t\t\t\tsettled = true;
\t\t\t\t\t\tclearTimeout(connectTimer);
\t\t\t\t\t\tsocket.removeEventListener("open", opened);
\t\t\t\t\t\tsocket.removeEventListener("error", failed);
\t\t\t\t\t\tsocket.removeEventListener("message", received);
\t\t\t\t\t\tsocket.removeEventListener("close", closed);
\t\t\t\t\t\tthis.cancelCandidate = void 0;
\t\t\t\t\t\tsocket.close();
\t\t\t\t\t\treject(error);
\t\t\t\t\t};
\t\t\t\t\tconst opened = () => {
\t\t\t\t\t\tsettled = true;
\t\t\t\t\t\tclearTimeout(connectTimer);
\t\t\t\t\t\tthis.cancelCandidate = void 0;
\t\t\t\t\t\tthis.socket = socket;
\t\t\t\t\t\tfor (const waiter of [...this.waiters]) waiter.resolve(socket);
\t\t\t\t\t\tresolve(socket);
\t\t\t\t\t};
\t\t\t\t\tconst failed = () => {
\t\t\t\t\t\tif (!settled) {
\t\t\t\t\t\t\trejectCandidate(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket failed to open"));
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tconst error = new RemoteStreamCarrierError("api gateway: Remote stream WebSocket failed");
\t\t\t\t\t\tthis.lost(socket, error);
\t\t\t\t\t\tsocket.close();
\t\t\t\t\t};
\t\t\t\t\tconst closed = () => {
\t\t\t\t\t\tif (!settled) {
\t\t\t\t\t\t\trejectCandidate(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket closed before opening"));
\t\t\t\t\t\t\treturn;
\t\t\t\t\t\t}
\t\t\t\t\t\tthis.lost(socket);
\t\t\t\t\t};
\t\t\t\t\tconst received = (event) => {
\t\t\t\t\t\tthis.receive(socket, event.data);
\t\t\t\t\t};
\t\t\t\t\tthis.cancelCandidate = rejectCandidate;
\t\t\t\t\tsocket.addEventListener("open", opened, { once: true });
\t\t\t\t\tsocket.addEventListener("error", failed, { once: true });
\t\t\t\t\tsocket.addEventListener("message", received);
\t\t\t\t\tsocket.addEventListener("close", closed, { once: true });
\t\t\t\t\t/* PATCH(${MARK}:connect) —— 本地补丁，非上游代码。见 README“为什么必须打两个文件”。 */
\t\t\t\t\tconnectTimer = setTimeout(() => {
\t\t\t\t\t\tif (!settled) rejectCandidate(new RemoteStreamCarrierError("api gateway: Remote stream WebSocket connect timed out"));
\t\t\t\t\t}, ${TIMEOUT_MS});
\t\t\t\t});
\t\t\t}`

/* ───────── 第二处补丁：open() 的「首帧超时」 ─────────
 * 为什么还要这一处（2026-09-25 静态审出来的真卡点）：
 *   `open()` 里 `await this.waitForSocket(signal)` 之后会 `send({type:'open'})`，然后
 *   `await inbox.next()` 等**第一帧**。而 `StreamInbox.next()` 只能被
 *   「收到帧 / inbox.fail() / 调用方 abort」唤醒，**没有任何定时器**。
 *   ⇒ 如果 socket 已经是 OPEN（连接根本没坏）、只是服务端迟迟不回这个 stream 的首帧，
 *     那 `waitForSocket()` 会**立刻返回**、连接超时那条路根本走不到 ⇒ 调用方**永久挂**。
 *   这正好解释「静态会话正常 / 运行中的会话卡 / 刷新就好 / 连接超时补丁没用」。
 * 做法：发出 open 帧后起一条死线；到点仍没收到任何帧 ⇒ `inbox.fail(...)` ⇒ open() 抛出
 *   ⇒ 上层 openState 进 error ⇒ 用户可重试（而不是永久「加载历史」）。收到首帧即清除。 */
const SRC_OPEN_BEFORE = `    async *open(endpoint, payload, signal, uplink) {
        signal.throwIfAborted();
        const streamId = randomUUID();
        const inbox = new StreamInbox();
        const stream = { inbox, pump: undefined };
        let carrier;
        let opened = false;
        let terminal = false;
        const abort = () => { inbox.fail(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        try {
            const socket = await this.waitForSocket(signal);
            signal.throwIfAborted();
            carrier = socket;
            this.streams.set(streamId, stream);
            this.send(socket, { type: 'open', streamId, endpoint, payload });
            opened = true;
            if (uplink !== undefined)
                stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox);
            while (true) {
                const frame = await inbox.next();
                signal.throwIfAborted();`
const SRC_OPEN_AFTER = `    async *open(endpoint, payload, signal, uplink) {
        signal.throwIfAborted();
        const streamId = randomUUID();
        const inbox = new StreamInbox();
        const stream = { inbox, pump: undefined };
        let carrier;
        let opened = false;
        let terminal = false;
        /* PATCH(${MARK}:open) —— 本地补丁，非上游代码。首帧超时兜底。 */
        let firstFrameTimer;
        let sawFirstFrame = false;
        const abort = () => { inbox.fail(signal.reason); };
        signal.addEventListener('abort', abort, { once: true });
        try {
            const socket = await this.waitForSocket(signal);
            signal.throwIfAborted();
            carrier = socket;
            this.streams.set(streamId, stream);
            this.send(socket, { type: 'open', streamId, endpoint, payload });
            opened = true;
            if (uplink !== undefined)
                stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox);
            firstFrameTimer = setTimeout(() => {
                if (!sawFirstFrame && !terminal)
                    inbox.fail(new RemoteStreamCarrierError('api gateway: Remote stream first frame timed out'));
            }, ${TIMEOUT_MS});
            while (true) {
                const frame = await inbox.next();
                if (!sawFirstFrame) { sawFirstFrame = true; clearTimeout(firstFrameTimer); }
                signal.throwIfAborted();`

const BUNDLE_OPEN_BEFORE = `\t\t\tasync *open(endpoint, payload, signal, uplink) {
\t\t\t\tsignal.throwIfAborted();
\t\t\t\tconst streamId = randomUUID();
\t\t\t\tconst inbox = new StreamInbox();
\t\t\t\tconst stream = {
\t\t\t\t\tinbox,
\t\t\t\t\tpump: void 0
\t\t\t\t};
\t\t\t\tlet carrier;
\t\t\t\tlet opened = false;
\t\t\t\tlet terminal = false;
\t\t\t\tconst abort = () => {
\t\t\t\t\tinbox.fail(signal.reason);
\t\t\t\t};
\t\t\t\tsignal.addEventListener("abort", abort, { once: true });
\t\t\t\ttry {
\t\t\t\t\tconst socket = await this.waitForSocket(signal);
\t\t\t\t\tsignal.throwIfAborted();
\t\t\t\t\tcarrier = socket;
\t\t\t\t\tthis.streams.set(streamId, stream);
\t\t\t\t\tthis.send(socket, {
\t\t\t\t\t\ttype: "open",
\t\t\t\t\t\tstreamId,
\t\t\t\t\t\tendpoint,
\t\t\t\t\t\tpayload
\t\t\t\t\t});
\t\t\t\t\topened = true;
\t\t\t\t\tif (uplink !== void 0) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox);
\t\t\t\t\twhile (true) {
\t\t\t\t\t\tconst frame = await inbox.next();
\t\t\t\t\t\tsignal.throwIfAborted();`
const BUNDLE_OPEN_AFTER = `\t\t\tasync *open(endpoint, payload, signal, uplink) {
\t\t\t\tsignal.throwIfAborted();
\t\t\t\tconst streamId = randomUUID();
\t\t\t\tconst inbox = new StreamInbox();
\t\t\t\tconst stream = {
\t\t\t\t\tinbox,
\t\t\t\t\tpump: void 0
\t\t\t\t};
\t\t\t\tlet carrier;
\t\t\t\tlet opened = false;
\t\t\t\tlet terminal = false;
\t\t\t\t/* PATCH(${MARK}:open) —— 本地补丁，非上游代码。首帧超时兜底。 */
\t\t\t\tlet firstFrameTimer;
\t\t\t\tlet sawFirstFrame = false;
\t\t\t\tconst abort = () => {
\t\t\t\t\tinbox.fail(signal.reason);
\t\t\t\t};
\t\t\t\tsignal.addEventListener("abort", abort, { once: true });
\t\t\t\ttry {
\t\t\t\t\tconst socket = await this.waitForSocket(signal);
\t\t\t\t\tsignal.throwIfAborted();
\t\t\t\t\tcarrier = socket;
\t\t\t\t\tthis.streams.set(streamId, stream);
\t\t\t\t\tthis.send(socket, {
\t\t\t\t\t\ttype: "open",
\t\t\t\t\t\tstreamId,
\t\t\t\t\t\tendpoint,
\t\t\t\t\t\tpayload
\t\t\t\t\t});
\t\t\t\t\topened = true;
\t\t\t\t\tif (uplink !== void 0) stream.pump = this.pumpUplink(socket, streamId, uplink, signal, inbox);
\t\t\t\t\tfirstFrameTimer = setTimeout(() => {
\t\t\t\t\t\tif (!sawFirstFrame && !terminal) inbox.fail(new RemoteStreamCarrierError("api gateway: Remote stream first frame timed out"));
\t\t\t\t\t}, ${TIMEOUT_MS});
\t\t\t\t\twhile (true) {
\t\t\t\t\t\tconst frame = await inbox.next();
\t\t\t\t\t\tif (!sawFirstFrame) {
\t\t\t\t\t\t\tsawFirstFrame = true;
\t\t\t\t\t\t\tclearTimeout(firstFrameTimer);
\t\t\t\t\t\t}
\t\t\t\t\t\tsignal.throwIfAborted();`

/* ───────── 第三/第四处：两处 open() 的 finally 里清掉定时器（防泄漏） ───────── */
const SRC_FIN_BEFORE = `        finally {
            signal.removeEventListener('abort', abort);`
const SRC_FIN_AFTER = `        finally { /* PATCH(${MARK}:open-finally) */
            clearTimeout(firstFrameTimer);
            signal.removeEventListener('abort', abort);`
const BUNDLE_FIN_BEFORE = `\t\t\t\t} finally {
\t\t\t\t\tsignal.removeEventListener("abort", abort);`
const BUNDLE_FIN_AFTER = `\t\t\t\t} finally { /* PATCH(${MARK}:open-finally) */
\t\t\t\t\tclearTimeout(firstFrameTimer);
\t\t\t\t\tsignal.removeEventListener("abort", abort);`

/* ───────── 第五/第六处（2026-09-25 13:5x 新增）：session-controller 的 doOpen catch 收尾 ─────────
 * 病灶（A / C / D 三路独立确认）：
 *   `doOpen` 的 catch 里 `if (!isRemoteFailure(error)) throw error;` **排在两条状态写入之前**
 *   ⇒ **非 RemoteFailure 异常会绕过 `openState = 'error'`**；而外层 `open()` 的 `.finally()`
 *   只清 `openPromise`、**不碰 `openState`** ⇒ 状态**永久停在 `loading`**（且 `openError = null`）。
 *   而 UI 的「载入历史」正是**严格按 `openState === 'loading'`** 渲染的 ⇒ **永远转圈**。
 *   ⚠️ 这也解释了为什么"给 gateway 加连接/首帧死线"**治不了它**：那条 path 抛的是
 *   RemoteStreamCarrierError（会被归一化成 RemoteError ⇒ 写成可见的 error），而现场是 openError=null。
 * 修法：**先把状态推进到终结态，再把编程错误抛出去**（两全：既不再卡死，也不吞掉真 bug）。 */
const SC_SRC_BEFORE = `        catch (error) {
            if (generation !== this.openGeneration || this.events !== events)
                return;
            if (!isRemoteFailure(error))
                throw error;
            this.events = undefined;
            this.openState = 'error';
            this.openError = error;
        }`
const SC_SRC_AFTER = `        catch (error) {
            if (generation !== this.openGeneration || this.events !== events) {
                /* PATCH(${MARK}:stale-settle) —— 失败路径的 stale 守卫：这次 attempt 已被取代，
                 * 且没有任何事件流在跑 ⇒ 不会有接管者，必须自己收尾，否则状态永远停在 loading。 */
                if (this.events === undefined && this.openState === 'loading') {
                    this.openState = 'cold';
                    /* PATCH(${MARK}:cold-reopen) —— 收尾成 cold 后主动重开一次；微任务延后 + 只在自己仍是 cold 时重开。 */
                    queueMicrotask(() => {
                        if (this.openState === 'cold')
                            void this.open().catch(() => { });
                    });
                }
                return;
            }
            /* PATCH(${MARK}:open-error-state) —— 先把状态推进到终结态，再（必要时）抛出编程错误。
             * 原实现把 throw 排在状态写入之前 ⇒ 非 RemoteFailure 异常会绕过 openState='error'，
             * 状态永久停在 loading，UI 于是永远显示「载入历史」。 */
            const remote = isRemoteFailure(error);
            if (remote)
                this.events = undefined;
            this.openState = 'error';
            this.openError = error;
            if (!remote)
                throw error;
        }`
const SC_BUN_BEFORE = `\t\t\t\t} catch (error) {
\t\t\t\t\tif (generation !== this.openGeneration || this.events !== events) return;
\t\t\t\t\tif (!(0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error)) throw error;
\t\t\t\t\tthis.events = void 0;
\t\t\t\t\tthis.openState = "error";
\t\t\t\t\tthis.openError = error;
\t\t\t\t}`
const SC_BUN_AFTER = `\t\t\t\t} catch (error) {
\t\t\t\t\tif (generation !== this.openGeneration || this.events !== events) {
\t\t\t\t\t\t/* PATCH(${MARK}:stale-settle) —— 失败路径的 stale 守卫：已被取代且没人接管 ⇒ 自己收尾。 */
\t\t\t\t\t\tif (this.events === void 0 && this.openState === "loading") {
\t\t\t\t\t\t\tthis.openState = "cold";
\t\t\t\t\t\t\t/* PATCH(${MARK}:cold-reopen) —— 收尾成 cold 后主动重开一次；微任务延后 + 只在自己仍是 cold 时重开。 */
\t\t\t\t\t\t\tqueueMicrotask(() => {
\t\t\t\t\t\t\t\tif (this.openState === "cold") void this.open().catch(() => { });
\t\t\t\t\t\t\t});
\t\t\t\t\t\t}
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\t/* PATCH(${MARK}:open-error-state) —— 先把状态推进到终结态，再（必要时）抛出编程错误。 */
\t\t\t\t\tconst remote = (0, _deepseek_ai_dsh_api_gateway_client.isRemoteFailure)(error);
\t\t\t\t\tif (remote) this.events = void 0;
\t\t\t\t\tthis.openState = "error";
\t\t\t\t\tthis.openError = error;
\t\t\t\t\tif (!remote) throw error;
\t\t\t\t}`

/* ───────── 第七/第八处（2026-09-25 14:0x 新增）：doOpen 的 stale 早退收尾 ─────────
 * 为什么要它（B 路离线复现 + 指出）：
 *   `dispose()` 会 `openGeneration++` 并 `this.events = void 0`，**却完全不碰 openState/openPromise**。
 *   于是"在 open 飞行中 dispose"时，`doOpen` 醒来会命中下面两处 stale 守卫**静默 return**，
 *   而外层 `open()` 的 `.finally()` 只清 `openPromise` ⇒ **状态永久停在 loading**（case A，与探针三元组逐字一致）。
 * 修法：stale 早退时，**若此刻没有任何事件流在跑（this.events === undefined）⇒ 说明不会有接管者**，
 *   必须自己收尾（置 `cold`），否则 UI 永远显示「载入历史」。
 *   ⚠️ 安全性：`resync()` 虽也置 `events = void 0`，但它随后会 `await open()` 重开（新 attempt 会重新设 `events` 并设回 `loading`），
 *   所以"设 cold"不会踩掉新 attempt；而 `failEventStream()` 自己会写 `error`，那时 `openState` 不是 `loading`，条件不成立。 */
const SC_STALE_SRC_A_BEFORE = `            if (generation !== this.openGeneration || this.events !== events)
                return;
            this.openState = 'open';`
const SC_STALE_SRC_A_AFTER = `            if (generation !== this.openGeneration || this.events !== events) {
                /* PATCH(${MARK}:stale-settle) —— 这次 attempt 已被取代（dispose / 换代）。
                 * 若没有任何事件流在跑，说明不会有接管者 ⇒ 必须自己收尾，
                 * 否则状态会永远停在 loading，UI 永远显示「载入历史」。 */
                if (this.events === undefined && this.openState === 'loading') {
                    this.openState = 'cold';
                    /* PATCH(${MARK}:cold-reopen) —— 收尾成 cold 后主动重开一次，免得停在"空窗"要人手动触发。
                     * 用微任务延后，避开 resync() 的同步路径；若期间已有人接管（state 不再是 cold）则放弃。 */
                    queueMicrotask(() => {
                        if (this.openState === 'cold')
                            void this.open().catch(() => { });
                    });
                }
                return;
            }
            this.openState = 'open';`
const SC_STALE_BUN_A_BEFORE = `\t\t\t\t\tif (generation !== this.openGeneration || this.events !== events) return;
\t\t\t\t\tthis.openState = "open";`
const SC_STALE_BUN_A_AFTER = `\t\t\t\t\tif (generation !== this.openGeneration || this.events !== events) {
\t\t\t\t\t\t/* PATCH(${MARK}:stale-settle) —— 已被取代且无人接管 ⇒ 自己收尾，避免永久 loading。 */
\t\t\t\t\t\tif (this.events === void 0 && this.openState === "loading") {
\t\t\t\t\t\t\tthis.openState = "cold";
\t\t\t\t\t\t\t/* PATCH(${MARK}:cold-reopen) —— 收尾成 cold 后主动重开一次；微任务延后 + 只在自己仍是 cold 时重开。 */
\t\t\t\t\t\t\tqueueMicrotask(() => {
\t\t\t\t\t\t\t\tif (this.openState === "cold") void this.open().catch(() => { });
\t\t\t\t\t\t\t});
\t\t\t\t\t\t}
\t\t\t\t\t\treturn;
\t\t\t\t\t}
\t\t\t\t\tthis.openState = "open";`

/* ───────── 第九/第十处（2026-09-25 14:0x 新增）：resync() 的状态重置进 finally ─────────
 * 病灶（A 路的 H3）：`resync()` 先 `openGeneration++` 并清 `events`，随后
 *   `await events?.dispose();`  ← **没有 try/finally**
 * 之后才做状态重置（`openPromise = null; openState = 'cold'; ...`）并 `await this.open()`。
 * ⇒ 一旦 `dispose()` 抛异常或永久挂起，**后面全部不执行** ⇒ `openState` 停在 `loading`（UI 永久「载入历史」）。
 * 修法：把"状态重置"放进 `finally`（保证一定执行），`await this.open()` 留在 finally 之后。
 * 这样 dispose 正常 ⇒ 重置 + 重开；dispose 抛 ⇒ 重置（**不卡**）+ 异常照常向上传播。 */
const SC_RESYNC_SRC_BEFORE = `        this.openGeneration++;
        const events = this.events;
        this.events = undefined;
        await events?.dispose();
        this.openPromise = null;
        this.openState = 'cold';
        this.openError = null;
        this.baseSeq = SessionLogOffset(0);
        this.notifier.markDirty();
        await this.open();`
const SC_RESYNC_SRC_AFTER = `        this.openGeneration++;
        const events = this.events;
        this.events = undefined;
        try {
            await events?.dispose();
        }
        finally {
            /* PATCH(${MARK}:resync-finally) —— 无论 dispose 抛还是挂，状态重置都必须执行，
             * 否则 openState 会永久停在 loading（UI 永远显示「载入历史」）。 */
            this.openPromise = null;
            this.openState = 'cold';
            this.openError = null;
            this.baseSeq = SessionLogOffset(0);
            this.notifier.markDirty();
        }
        await this.open();`
const SC_RESYNC_BUN_BEFORE = `\t\t\t\tthis.openGeneration++;
\t\t\t\tconst events = this.events;
\t\t\t\tthis.events = void 0;
\t\t\t\tawait events?.dispose();
\t\t\t\tthis.openPromise = null;
\t\t\t\tthis.openState = "cold";
\t\t\t\tthis.openError = null;
\t\t\t\tthis.baseSeq = SessionLogOffset(0);
\t\t\t\tthis.notifier.markDirty();
\t\t\t\tawait this.open();`
const SC_RESYNC_BUN_AFTER = `\t\t\t\tthis.openGeneration++;
\t\t\t\tconst events = this.events;
\t\t\t\tthis.events = void 0;
\t\t\t\ttry {
\t\t\t\t\tawait events?.dispose();
\t\t\t\t}
\t\t\t\tfinally {
\t\t\t\t\t/* PATCH(${MARK}:resync-finally) —— 无论 dispose 抛还是挂，状态重置都必须执行。 */
\t\t\t\t\tthis.openPromise = null;
\t\t\t\t\tthis.openState = "cold";
\t\t\t\t\tthis.openError = null;
\t\t\t\t\tthis.baseSeq = SessionLogOffset(0);
\t\t\t\t\tthis.notifier.markDirty();
\t\t\t\t}
\t\t\t\tawait this.open();`

/* ───────── 第十一/第十二处（2026-09-25 15:0x 新增）：坏 chunk 降级，不静默失败 ─────────
 * 病灶：`ClientAssistantStream.replace()` 里 `expandAssistantStream(opening.stream)` **一抛整条就失败**
 *   ⇒ UI 只显示「历史加载失败：Assistant stream raw chunk must be a lossless JSON object（undefined）」，
 *   而真正的病因（cause / stack / 坏记录原文）**全被丢掉** ⇒ 用户与开发者都无法自诊断。
 * 修法：**逐条降级** —— 保留能用的 chunk、跳过坏的，并把完整病因 `console.error` 出来（**不静默失败**）。 */
const SC_DEGRADE_SRC_BEFORE = `        if (opening !== undefined) {
            for (const [index, member] of expandAssistantStream(opening.stream).entries()) {
                this.transientInGap += 1;
                visible.push({
                    type: 'transient',
                    event: {
                        type: 'assistant/live-chunk',
                        seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
                        time: member.time,
                        data: {
                            attemptId: opening.attemptId,
                            turn: opening.turn,
                            step: opening.step,
                            chunk: member.chunk,
                        },
                    },
                });
                if (index + 1 >= opening.nextIndex)
                    break;
            }
        }`
const SC_DEGRADE_SRC_AFTER = `        if (opening !== undefined) {
            /* PATCH(${MARK}:replace-degrade) —— 坏记录不该让整条历史打不开：逐条降级 + 暴露病因。 */
            let members;
            try {
                members = expandAssistantStream(opening.stream);
            }
            catch (error) {
                /* ★ 详细判据：照 walkJsonValue 的规则走一遍，指出"哪一格不合规"（打成人话，免得要点开对象）。 */
                const describeBadChunk = (v, path, depth, ancestors) => {
                    path = path || 'chunk';
                    depth = depth || 0;
                    ancestors = ancestors || new Set();
                    if (depth > 40) return path + ' 嵌套过深（>40 层）— 疑似循环引用';
                    if (v === null) return null;
                    const t = typeof v;
                    if (t === 'boolean' || t === 'string') return null;
                    if (t === 'number') {
                        if (Number.isNaN(v)) return path + ' = NaN';
                        if (!Number.isFinite(v)) return path + ' = ' + String(v);
                        if (Object.is(v, -0)) return path + ' = -0';
                        return null;
                    }
                    if (t !== 'object') return path + ' 的类型是 ' + t + '（JSON 无法表示）';
                    /* ★ 真身判据（walkJsonValue:110）：指回祖先 ⇒ 循环引用 ⇒ 不合规 */
                    if (ancestors.has(v)) return path + ' 是【循环引用】（指回了祖先对象）⇒ JSON 无法序列化 ⇒ 判不合规';
                    if (Array.isArray(v)) {
                        if (Reflect.ownKeys(v).length !== v.length + 1) return path + ' 是稀疏数组 / 带多余键';
                        ancestors.add(v);
                        for (let i = 0; i < v.length; i++) { const r = describeBadChunk(v[i], path + '[' + i + ']', depth + 1, ancestors); if (r) { ancestors.delete(v); return r; } }
                        ancestors.delete(v);
                        return null;
                    }
                    const proto = Object.getPrototypeOf(v);
                    if (proto !== Object.prototype && proto !== null) return path + ' 的原型不是 plain 对象（实际: ' + String((proto && proto.constructor && proto.constructor.name) || '?') + '）';
                    ancestors.add(v);
                    for (const k of Reflect.ownKeys(v)) {
                        /* ★ 真身判据（dsh-util-values:enumerableStringKeys）：symbol 键 或 不可枚举键 ⇒ JSON 会丢 ⇒ 不合规 */
                        if (typeof k === 'symbol') { ancestors.delete(v); return path + ' 含 symbol 键（' + String(k.toString()) + '）'; }
                        const d = Object.getOwnPropertyDescriptor(v, k);
                        if (d && d.enumerable === false) { ancestors.delete(v); return path + ' 上有【不可枚举】的 own 属性 "' + String(k) + '"（' + (d.get || d.set ? '访问器' : '数据属性') + (d.value === undefined ? '，值=undefined' : '，值=' + String(d.value).slice(0, 60)) + '）⇒ JSON 会丢弃它 ⇒ 判不合规'; }
                        if (d && (d.get || d.set)) { ancestors.delete(v); return path + '.' + String(k) + ' 是 getter/setter'; }
                        const r = describeBadChunk(v[k], path + '.' + String(k), depth + 1, ancestors);
                        if (r) { ancestors.delete(v); return r; }
                    }
                    ancestors.delete(v);
                    return null;
                };
                console.error('[assistant-stream] 活动 attempt 含不合规记录，已降级为逐条展开（坏记录跳过）', error, opening.stream);
                members = [];
                for (const record of opening.stream) {
                    try {
                        for (const member of expandAssistantStream([record]))
                            members.push(member);
                    }
                    catch (inner) {
                        /* ★ v3：手抄判据漏格 ⇒ 优先用**运行时同一份 snapshotChunk**做逐键排除（纯校验：undefined = 不合规）。
                         *   源码文件里没有 snapshotChunk（只有 bundle 有），所以用 typeof 探测、没有就退回手抄判据。
                         *   ⚠️ 别用 expandAssistantStream 判"是否合规" —— "不抛" ≠ "合规"（删掉 type 后记录会被忽略）。 */
                        const canProbe = typeof snapshotChunk === 'function';
                        const probeBad = canProbe ? (c) => { try { return snapshotChunk(c) === undefined; } catch (_e) { return true; } } : null;
                        let why = describeBadChunk(record && record.chunk);
                        const src = record && record.chunk;
                        if (!why && probeBad && src && typeof src === 'object' && !Array.isArray(src)) {
                            const ownKeys = Reflect.ownKeys(src);
                            /* ① 单键独立试：哪个键单独就判不合规 ⇒ 它就是元凶（对普通坏值最准） */
                            for (const k of ownKeys) {
                                if (probeBad({ [k]: src[k] })) { why = '键 "' + String(k) + '" 单独就判不合规（值类型=' + typeof src[k] + '，enumerable=' + String(Object.prototype.propertyIsEnumerable.call(src, k)) + '）'; break; }
                            }
                            /* ② 删除试：删掉哪个键后整条变合规 ⇒ 元凶（循环引用只有这招能测出） */
                            if (!why) for (const k of ownKeys) {
                                const copy = {};
                                for (const k2 of ownKeys) if (k2 !== k) copy[k2] = src[k2];
                                if (!probeBad(copy)) { why = '去掉键 "' + String(k) + '" 后整条变合规 ⇒ 元凶是这个键（值类型=' + typeof src[k] + '，enumerable=' + String(Object.prototype.propertyIsEnumerable.call(src, k)) + '，ownKeys=[' + ownKeys.map(String).join(',') + ']）'; break; }
                            }
                            if (!why) why = '逐键排除都没命中 ⇒ 问题在 chunk 对象自身（原型 / own 描述符），ownKeys=[' + ownKeys.map(String).join(',') + ']';
                        }
                        if (!why && !canProbe && src && typeof src === 'object' && !Array.isArray(src))
                            why = '（此份无 snapshotChunk，仅手抄判据）ownKeys=[' + Reflect.ownKeys(src).map(String).join(',') + ']';
                        /* ★ v4：定位不到时把"对象形状"整个 dump 出来（键 + 描述符标志 + 原型 + 原生构造器串）。 */
                        const shapeOf = (o) => {
                            try {
                                const keys = Reflect.ownKeys(o).map((k) => {
                                    const d = Object.getOwnPropertyDescriptor(o, k);
                                    const flags = d ? (d.get || d.set ? 'acc' : 'data') + (d.enumerable ? '' : ',!enum') + (d.writable === false ? ',!w' : '') + (d.configurable === false ? ',!cfg' : '') : '?';
                                    return String(k) + '[' + flags + ']=' + (d && d.value === undefined ? 'undefined' : typeof (d && d.value));
                                });
                                const proto = Object.getPrototypeOf(o);
                                let native = 'none';
                                try { native = proto && proto.constructor ? String(Function.prototype.toString.call(proto.constructor)).slice(0, 46) : 'none'; } catch (_e2) { native = 'toString-err'; }
                                return 'keys={' + keys.join(' ') + '} proto=' + (proto === null ? 'null' : String((proto && proto.constructor && proto.constructor.name) || '?')) + ' nativeCtor=' + native;
                            } catch (_e3) { return 'shape-dump-fail:' + String((_e3 && _e3.message) || _e3); }
                        };
                        console.error('[assistant-stream] 跳过不合规记录 ★ 原因: ' + String(why || '未能定位（见附带的 record）'), inner, record);
                        console.error('[assistant-stream] 形状 dump（chunk）: ' + shapeOf(src), '\\n形状 dump（chunk.block）: ' + (src && src.block && typeof src.block === 'object' ? shapeOf(src.block) : 'n/a'));
                    }
                }
            }
            for (const [index, member] of members.entries()) {
                this.transientInGap += 1;
                visible.push({
                    type: 'transient',
                    event: {
                        type: 'assistant/live-chunk',
                        seq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
                        time: member.time,
                        data: {
                            attemptId: opening.attemptId,
                            turn: opening.turn,
                            step: opening.step,
                            chunk: member.chunk,
                        },
                    },
                });
                if (index + 1 >= opening.nextIndex)
                    break;
            }
        }`
const SC_DEGRADE_BUN_BEFORE = `\t\t\t\tif (opening !== void 0) for (const [index, member] of expandAssistantStream(opening.stream).entries()) {
\t\t\t\t\tthis.transientInGap += 1;
\t\t\t\t\tvisible.push({
\t\t\t\t\t\ttype: "transient",
\t\t\t\t\t\tevent: {
\t\t\t\t\t\t\ttype: "assistant/live-chunk",
\t\t\t\t\t\t\tseq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
\t\t\t\t\t\t\ttime: member.time,
\t\t\t\t\t\t\tdata: {
\t\t\t\t\t\t\t\tattemptId: opening.attemptId,
\t\t\t\t\t\t\t\tturn: opening.turn,
\t\t\t\t\t\t\t\tstep: opening.step,
\t\t\t\t\t\t\t\tchunk: member.chunk
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t});
\t\t\t\t\tif (index + 1 >= opening.nextIndex) break;
\t\t\t\t}`
const SC_DEGRADE_BUN_AFTER = `\t\t\t\tif (opening !== void 0) {
\t\t\t\t\t/* PATCH(${MARK}:replace-degrade) —— 坏记录不该让整条历史打不开：逐条降级 + 暴露病因。 */
\t\t\t\t\tlet members;
\t\t\t\t\ttry {
\t\t\t\t\t\tmembers = expandAssistantStream(opening.stream);
\t\t\t\t\t} catch (error) {
\t\t\t\t\t\t/* ★ 详细判据：照 walkJsonValue 的规则走一遍，指出"哪一格不合规"。 */
\t\t\t\t\t\tconst describeBadChunk = (v, path, depth, ancestors) => {
\t\t\t\t\t\t\tpath = path || "chunk";
\t\t\t\t\t\t\tdepth = depth || 0;
\t\t\t\t\t\t\tancestors = ancestors || new Set();
\t\t\t\t\t\t\tif (depth > 40) return path + " 嵌套过深（>40 层）— 疑似循环引用";
\t\t\t\t\t\t\tif (v === null) return null;
\t\t\t\t\t\t\tconst t = typeof v;
\t\t\t\t\t\t\tif (t === "boolean" || t === "string") return null;
\t\t\t\t\t\t\tif (t === "number") {
\t\t\t\t\t\t\t\tif (Number.isNaN(v)) return path + " = NaN";
\t\t\t\t\t\t\t\tif (!Number.isFinite(v)) return path + " = " + String(v);
\t\t\t\t\t\t\t\tif (Object.is(v, -0)) return path + " = -0";
\t\t\t\t\t\t\t\treturn null;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\tif (t !== "object") return path + " 的类型是 " + t + "（JSON 无法表示）";
\t\t\t\t\t\t\t/* ★ 真身判据（walkJsonValue:110）：指回祖先 ⇒ 循环引用 ⇒ 不合规 */
\t\t\t\t\t\t\tif (ancestors.has(v)) return path + " 是【循环引用】（指回了祖先对象）⇒ JSON 无法序列化 ⇒ 判不合规";
\t\t\t\t\t\t\tif (Array.isArray(v)) {
\t\t\t\t\t\t\t\tif (Reflect.ownKeys(v).length !== v.length + 1) return path + " 是稀疏数组 / 带多余键";
\t\t\t\t\t\t\t\tancestors.add(v);
\t\t\t\t\t\t\t\tfor (let i = 0; i < v.length; i++) { const r = describeBadChunk(v[i], path + "[" + i + "]", depth + 1, ancestors); if (r) { ancestors.delete(v); return r; } }
\t\t\t\t\t\t\t\tancestors.delete(v);
\t\t\t\t\t\t\t\treturn null;
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\tconst proto = Object.getPrototypeOf(v);
\t\t\t\t\t\t\tif (proto !== Object.prototype && proto !== null) return path + " 的原型不是 plain 对象（实际: " + String((proto && proto.constructor && proto.constructor.name) || "?") + "）";
\t\t\t\t\t\t\tancestors.add(v);
\t\t\t\t\t\t\tfor (const k of Reflect.ownKeys(v)) {
\t\t\t\t\t\t\t\t/* ★ 真身判据（dsh-util-values:enumerableStringKeys）：symbol 键 或 不可枚举键 ⇒ JSON 会丢 ⇒ 不合规 */
\t\t\t\t\t\t\t\tif (typeof k === "symbol") { ancestors.delete(v); return path + " 含 symbol 键（" + String(k.toString()) + "）"; }
\t\t\t\t\t\t\t\tconst d = Object.getOwnPropertyDescriptor(v, k);
\t\t\t\t\t\t\t\tif (d && d.enumerable === false) { ancestors.delete(v); return path + " 上有【不可枚举】的 own 属性 \\"" + String(k) + "\\"（" + (d.get || d.set ? "访问器" : "数据属性") + (d.value === undefined ? "，值=undefined" : "，值=" + String(d.value).slice(0, 60)) + "）⇒ JSON 会丢弃它 ⇒ 判不合规"; }
\t\t\t\t\t\t\t\tif (d && (d.get || d.set)) { ancestors.delete(v); return path + "." + String(k) + " 是 getter/setter"; }
\t\t\t\t\t\t\t\tconst r = describeBadChunk(v[k], path + "." + String(k), depth + 1, ancestors);
\t\t\t\t\t\t\t\tif (r) { ancestors.delete(v); return r; }
\t\t\t\t\t\t\t}
\t\t\t\t\t\t\tancestors.delete(v);
\t\t\t\t\t\t\treturn null;
\t\t\t\t\t\t};
\t\t\t\t\t\tconsole.error("[assistant-stream] 活动 attempt 含不合规记录，已降级为逐条展开（坏记录跳过）", error, opening.stream);
\t\t\t\t\t\tmembers = [];
\t\t\t\t\t\tfor (const record of opening.stream) {
\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\tfor (const member of expandAssistantStream([record])) members.push(member);
\t\t\t\t\t\t\t} catch (inner) {
\t\t\t\t\t\t\t\t/* ★ v3：手抄判据漏格 ⇒ 改用**运行时同一份 snapshotChunk**做逐键排除（纯校验：undefined = 不合规）。
\t\t\t\t\t\t\t\t *   顺序讲究：**先"单键独立试"**（最精确），**再"删除试"**（循环引用只有这招能测出）。
\t\t\t\t\t\t\t\t *   ⚠️ 别用 expandAssistantStream 判"是否合规" —— "不抛" ≠ "合规"（删掉 type 后记录会被忽略）。 */
\t\t\t\t\t\t\t\tconst probeWhy = (c) => { try { return snapshotChunk(c) === void 0 ? "不合规" : null; } catch (_e) { return "不合规(抛:" + String((_e && _e.message) || _e).slice(0, 60) + ")"; } };
\t\t\t\t\t\t\t\tlet why = describeBadChunk(record && record.chunk);
\t\t\t\t\t\t\t\tconst src = record && record.chunk;
\t\t\t\t\t\t\t\tif (!why && src && typeof src === "object" && !Array.isArray(src)) {
\t\t\t\t\t\t\t\t\tconst ownKeys = Reflect.ownKeys(src);
\t\t\t\t\t\t\t\t\t/* ① 单键独立试：哪个键单独就判不合规 ⇒ 它就是元凶（对普通坏值最准） */
\t\t\t\t\t\t\t\t\tfor (const k of ownKeys) {
\t\t\t\t\t\t\t\t\t\tif (probeWhy({ [k]: src[k] })) { why = "键 \\"" + String(k) + "\\" 单独就判不合规（值类型=" + typeof src[k] + "，值=" + String(src[k]).slice(0, 50) + "，enumerable=" + String(Object.prototype.propertyIsEnumerable.call(src, k)) + "）"; break; }
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t\t/* ② 删除试：删掉哪个键后整条变合规 ⇒ 元凶（循环引用只能这样测出） */
\t\t\t\t\t\t\t\t\tif (!why) for (const k of ownKeys) {
\t\t\t\t\t\t\t\t\t\tconst copy = {};
\t\t\t\t\t\t\t\t\t\tfor (const k2 of ownKeys) if (k2 !== k) copy[k2] = src[k2];
\t\t\t\t\t\t\t\t\t\tif (!probeWhy(copy)) { why = "去掉键 \\"" + String(k) + "\\" 后整条变合规 ⇒ 元凶是这个键（值类型=" + typeof src[k] + "，enumerable=" + String(Object.prototype.propertyIsEnumerable.call(src, k)) + "，ownKeys=[" + ownKeys.map(String).join(",") + "]）"; break; }
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t\tif (!why) why = "逐键排除都没命中 ⇒ 问题在 chunk 对象自身（原型 / own 描述符），ownKeys=[" + ownKeys.map(String).join(",") + "]";
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t/* ★ v4：以上都定位不到时，直接把"对象形状"整个 dump 出来
\t\t\t\t\t\t\t\t *   （每个键 + 描述符标志 + 原型 + 原生构造器串）—— "哪一格不一样"一眼可见，不用再猜。 */
\t\t\t\t\t\t\t\tconst shapeOf = (o) => {
\t\t\t\t\t\t\t\t\ttry {
\t\t\t\t\t\t\t\t\t\tconst keys = Reflect.ownKeys(o).map((k) => {
\t\t\t\t\t\t\t\t\t\t\tconst d = Object.getOwnPropertyDescriptor(o, k);
\t\t\t\t\t\t\t\t\t\t\tconst flags = d ? (d.get || d.set ? "acc" : "data") + (d.enumerable ? "" : ",!enum") + (d.writable === false ? ",!w" : "") + (d.configurable === false ? ",!cfg" : "") : "?";
\t\t\t\t\t\t\t\t\t\t\treturn String(k) + "[" + flags + "]=" + (d && d.value === void 0 ? "undefined" : typeof (d && d.value));
\t\t\t\t\t\t\t\t\t\t});
\t\t\t\t\t\t\t\t\t\tconst proto = Object.getPrototypeOf(o);
\t\t\t\t\t\t\t\t\t\tlet native = "none";
\t\t\t\t\t\t\t\t\t\ttry { native = proto && proto.constructor ? String(Function.prototype.toString.call(proto.constructor)).slice(0, 46) : "none"; } catch (_e2) { native = "toString-err"; }
\t\t\t\t\t\t\t\t\t\treturn "keys={" + keys.join(" ") + "} proto=" + (proto === null ? "null" : String((proto && proto.constructor && proto.constructor.name) || "?")) + " nativeCtor=" + native;
\t\t\t\t\t\t\t\t\t} catch (_e3) { return "shape-dump-fail:" + String((_e3 && _e3.message) || _e3); }
\t\t\t\t\t\t\t\t};
\t\t\t\t\t\t\t\tconsole.error("[assistant-stream] 跳过不合规记录 ★ 原因: " + String(why || "未能定位（见附带的 record）"), inner, record);
\t\t\t\t\t\t\t\tconsole.error("[assistant-stream] 形状 dump（chunk）: " + shapeOf(src), "\\n形状 dump（chunk.block）: " + (src && src.block && typeof src.block === "object" ? shapeOf(src.block) : "n/a"));
\t\t\t\t\t\t\t}
\t\t\t\t\t\t}
\t\t\t\t\t}
\t\t\t\t\tfor (const [index, member] of members.entries()) {
\t\t\t\t\t\tthis.transientInGap += 1;
\t\t\t\t\t\tvisible.push({
\t\t\t\t\t\t\ttype: "transient",
\t\t\t\t\t\t\tevent: {
\t\t\t\t\t\t\t\ttype: "assistant/live-chunk",
\t\t\t\t\t\t\t\tseq: this.durableCursor + 1 - 1 / (this.transientInGap + 1),
\t\t\t\t\t\t\t\ttime: member.time,
\t\t\t\t\t\t\t\tdata: {
\t\t\t\t\t\t\t\t\tattemptId: opening.attemptId,
\t\t\t\t\t\t\t\t\tturn: opening.turn,
\t\t\t\t\t\t\t\t\tstep: opening.step,
\t\t\t\t\t\t\t\t\tchunk: member.chunk
\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t}
\t\t\t\t\t\t});
\t\t\t\t\t\tif (index + 1 >= opening.nextIndex) break;
\t\t\t\t\t}
\t\t\t\t}`

/* ───────── 第十三处（2026-09-25 15:0x 新增）：UI 别再只显示 (undefined) ─────────
 * 病灶：`chat.loadError` 文案是 `历史加载失败：{message}（{code}）`，实参 `openError.code`。
 *   而现场抛的是**普通 TypeError（没有 `code` 属性）** ⇒ 界面显示 `（undefined）`，用户完全无法自诊断。
 * 修法：**不动 i18n 模板**（中英都不用改），只把传入的 `code` 兜底成有意义的值：
 *   有 `code` 用它；否则用 `cause.message` 摘要；再否则 `client`。 */
const UI_CHAT_BEFORE = `\t\t\t\t\t\t\t\t\t\tchildren: t("chat.loadError", {
\t\t\t\t\t\t\t\t\t\t\tmessage: openError.message,
\t\t\t\t\t\t\t\t\t\t\tcode: openError.code
\t\t\t\t\t\t\t\t\t\t})`
const UI_CHAT_AFTER = `\t\t\t\t\t\t\t\t\t\tchildren: t("chat.loadError", {
\t\t\t\t\t\t\t\t\t\t\tmessage: openError.message,
\t\t\t\t\t\t\t\t\t\t\tcode: openError.code ?? (openError.cause && openError.cause.message ? String(openError.cause.message).slice(0, 60) : "client") /* PATCH(${MARK}:ui-error-code) */
\t\t\t\t\t\t\t\t\t\t})`

/** UI chat 包的相对路径（第三个受补丁的包）。 */
const UI_CHAT_PKG_REL = path.join('node_modules', '@deepseek-ai', 'dsh-client-ui-chat')

/** session-controller 的包相对路径（第二个受补丁的包）。 */
const SC_PKG_REL = path.join('node_modules', '@deepseek-ai', 'dsh-api-session-controller')

/** dsh-util-values 的包相对路径（本体，Node 侧）。 */
const UTV_PKG_REL = path.join('node_modules', '@deepseek-ai', 'dsh-util-values')

/* ───────── 第十四处（2026-09-25 15:3x 新增，2026-09-27 扩口径）：★ 根治 Gecko / WebKit 兼容性 bug ─────────
 * 病灶：`hasIntrinsicConstructor` 用**硬编码单行字符串**比对 `Function.prototype.toString`：
 *     Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`
 *   · **V8（Chrome / Edge / Node）与 Hermes** 返回 `function Object() { [native code] }`（**单行**）⇒ 相等 ⇒ 正常；
 *   · ⚠️ **Gecko（Firefox 系）与 WebKit（Safari / iOS 全家）** 返回「**多行 + 缩进**」：
 *     `function Object() {\n    [native code]\n}` ⇒ **恒不相等**！
 *     （源码证据：Gecko `js/src/vm/JSFunction.cpp:969`、`:1005` 追加 `"() {\n    [native code]\n}"`；
 *      WebKit `Source/JavaScriptCore/runtime/FunctionPrototype.cpp` 的 `functionProtoFuncToString` 同样写死多行；
 *      Hermes `lib/VM/JSLib/Function.cpp:140/:170` 是单行。ECMA-262 此处 implementation-defined，故逐引擎看。）
 * ⇒ 后果链（已用真代码逐环复现）：
 *     hasIntrinsicConstructor(Object.prototype, "Object")  ⇒ false
 *     isIntrinsicObjectPrototype(Object.prototype)         ⇒ false
 *     hasPlainObjectPrototype(任何普通对象)                 ⇒ false
 *     walkJsonValue / snapshotJsonValue                    ⇒ 一律返回 undefined
 *     snapshotChunk                                        ⇒ 抛 "must be losslessly JSON-serializable"
 *     expandAssistantStream                                ⇒ 抛
 *     ClientAssistantStream.replace                        ⇒ 抛 ⇒ 会话打不开
 *   ⇒ 这一条解释了全部现象：只在 Gecko / WebKit 里出现、磁盘（Node 侧校验，V8）永远干净、
 *     对象"形状完全正常"、只有 live attempt 那条路才走这个校验。
 *   ⚠️ 验证方式：在 Node 里覆盖 `Function.prototype.toString` 让原生构造器返回多行 ⇒
 *     普通对象**立刻**被判不合规；还原后恢复正常（`logs\firefox-tostring-repro.txt`）。
 * 修法：比较前把连续空白规范化为单个空格（一行内联，不引入新变量、避免命名冲突）。
 * 影响面：**只放宽"原生构造器判定"** —— 只会把"被误判为不合规"改回合规，**不会把非法值判成合法**。 */
const FIREFOX_TS_BEFORE = 'return constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;'
const FIREFOX_TS_MARK = `/* PATCH(${MARK}:firefox-tostring) —— Gecko（Firefox 系）与 WebKit（Safari / iOS 全家）的 Function.prototype.toString 对内置函数返回「多行 + 缩进」，原判据硬编码单行 ⇒ 恒不相等 ⇒ 一切普通对象被判「不是无损 JSON」。修法：比较前规范化空白（只放宽，不会把非法判成合法）。 */`
const FIREFOX_TS_AFTER_BUN = FIREFOX_TS_MARK + '\n\t\t\treturn constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor).replace(/\\s+/g, " ").trim() === `function ${name}() { [native code] }`;'
const FIREFOX_TS_AFTER_SRC = FIREFOX_TS_MARK + '\n\t\treturn constructor.name === name && constructor.prototype === prototype && Function.prototype.toString.call(constructor).replace(/\\s+/g, " ").trim() === `function ${name}() { [native code] }`;'

const TARGETS = [
  {
    label: 'api-gateway · 源码 (stream-client.js)',
    file: path.join(DSH_ROOT, PKG_REL, 'lib', 'types', 'client', 'stream-client.js'),
    edits: [
      { tag: 'connect', before: SRC_BEFORE, after: SRC_AFTER },
      { tag: 'open', before: SRC_OPEN_BEFORE, after: SRC_OPEN_AFTER },
      { tag: 'open-finally', before: SRC_FIN_BEFORE, after: SRC_FIN_AFTER },
    ],
  },
  {
    label: 'api-gateway · 打包产物 (bundle) —— 浏览器真正加载的那份',
    file: path.join(DSH_ROOT, PKG_REL, 'lib', 'client.js'),
    edits: [
      { tag: 'connect', before: BUNDLE_BEFORE, after: BUNDLE_AFTER },
      { tag: 'open', before: BUNDLE_OPEN_BEFORE, after: BUNDLE_OPEN_AFTER },
      { tag: 'open-finally', before: BUNDLE_FIN_BEFORE, after: BUNDLE_FIN_AFTER },
    ],
  },
  {
    label: 'session-controller · assistant-stream 源码 (assistant-stream.js)',
    file: path.join(DSH_ROOT, SC_PKG_REL, 'lib', 'types', 'client', 'sessions', 'assistant-stream.js'),
    edits: [{ tag: 'replace-degrade', before: SC_DEGRADE_SRC_BEFORE, after: SC_DEGRADE_SRC_AFTER }],
  },
  {
    label: 'session-controller · 源码 (session.js)',
    file: path.join(DSH_ROOT, SC_PKG_REL, 'lib', 'types', 'client', 'sessions', 'session.js'),
    edits: [
      { tag: 'stale-settle', before: SC_STALE_SRC_A_BEFORE, after: SC_STALE_SRC_A_AFTER },
      { tag: 'open-error-state', before: SC_SRC_BEFORE, after: SC_SRC_AFTER },
      { tag: 'resync-finally', before: SC_RESYNC_SRC_BEFORE, after: SC_RESYNC_SRC_AFTER },
    ],
  },
  {
    label: 'session-controller · 打包产物 (bundle)',
    file: path.join(DSH_ROOT, SC_PKG_REL, 'lib', 'client.js'),
    edits: [
      { tag: 'stale-settle', before: SC_STALE_BUN_A_BEFORE, after: SC_STALE_BUN_A_AFTER },
      { tag: 'open-error-state', before: SC_BUN_BEFORE, after: SC_BUN_AFTER },
      { tag: 'resync-finally', before: SC_RESYNC_BUN_BEFORE, after: SC_RESYNC_BUN_AFTER },
      { tag: 'replace-degrade', before: SC_DEGRADE_BUN_BEFORE, after: SC_DEGRADE_BUN_AFTER },
    ],
  },
  {
    label: 'ui-chat · 打包产物 (bundle) —— 错误码兜底（不再显示 undefined）',
    file: path.join(DSH_ROOT, UI_CHAT_PKG_REL, 'lib', 'client.js'),
    edits: [{ tag: 'ui-error-code', before: UI_CHAT_BEFORE, after: UI_CHAT_AFTER }],
  },
  {
    label: 'session-controller · bundle —— ★ Gecko / WebKit 兼容性根治（Function.prototype.toString 多行）',
    file: path.join(DSH_ROOT, SC_PKG_REL, 'lib', 'client.js'),
    edits: [{ tag: 'firefox-tostring', before: FIREFOX_TS_BEFORE, after: FIREFOX_TS_AFTER_BUN }],
  },
  {
    label: 'dsh-util-values · 本体 —— ★ Gecko / WebKit 兼容性根治（同上，保持一致）',
    file: path.join(DSH_ROOT, UTV_PKG_REL, 'lib', 'index.js'),
    edits: [{ tag: 'firefox-tostring', before: FIREFOX_TS_BEFORE, after: FIREFOX_TS_AFTER_SRC }],
  },
]

/** 某个补丁点是否已打（按 tag 精确匹配，避免与旧版无 tag 的标记混淆）。 */
const markOf = (tag) => `PATCH(${MARK}:${tag})`
const hasMark = (text, tag) => text.includes(markOf(tag)) || text.includes('PATCH(${MARK}:' + tag + ')')

console.log('DSH 根: ' + DSH_ROOT + (EXPLICIT_DSH ? '（来自 --dsh / $DSH_ROOT）' : '（**自动定位**）'))
for (const t of TARGETS) console.log('  · ' + t.label + '\n      ' + t.file)
if (rootsHit.length > 1 && !EXPLICIT_DSH) {
  console.log('⚠️ 本机有 ' + rootsHit.length + ' 个 DSH 安装，本次是**自动定位** ⇒ 用的是上面那个。')
  console.log('   要确保打对（别打到没在跑的那份），请显式加 `--dsh <DSH 安装根>`。')
}
if (action === 'where') process.exit(0)

// ─────────────────────────── 工具 ───────────────────────────
/**
 * 语法检查。⚠️ 必须区分两种情况：
 *   - 子进程真的跑了、返回非 0 ⇒ 语法错（kind: 'syntax'）；
 *   - 根本起不了子进程（EPERM / 平台限制等）⇒ **不能**当成语法错，否则会触发无谓回滚（kind: 'spawn'）。
 */
function syntaxCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
    return { ok: true }
  } catch (e) {
    const err = e && typeof e === 'object' ? e : {}
    if (typeof err.status === 'number') {
      return { ok: false, kind: 'syntax', out: String(err.stderr || err.stdout || err.message) }
    }
    return { ok: false, kind: 'spawn', out: String(err.message || err) }
  }
}

// ─────────────────────────── verify ───────────────────────────
if (action === 'verify') {
  let bad = 0
  for (const t of TARGETS) {
    if (!existsSync(t.file)) { console.log('❌ 缺文件: ' + t.file); bad++; continue }
    const src = readFileSync(t.file, 'utf8')
    const bak = t.file + BAK_SUFFIX
    const syn = syntaxCheck(t.file)
    console.log(`\n[${t.label}]`)
    console.log('  备份存在   : ' + (existsSync(bak) ? '是' : '否'))
    console.log('  语法检查   : ' + (syn.ok ? 'OK' : syn.kind === 'syntax' ? '失败' : '无法执行 node --check（' + syn.out + '）'))
    for (const e of t.edits) {
      const has = hasMark(src, e.tag)
      console.log(`  · ${e.tag.padEnd(14)} 已打补丁: ${has ? '是' : '否'}`)
      if (!has) bad++
    }
    if (!syn.ok && syn.kind === 'syntax') { console.error(syn.out); bad++ }
  }
  process.exit(bad === 0 ? 0 : 1)
}

// ─────────────────────────── apply ───────────────────────────
if (action === 'apply') {
  // ① 预检：**写入之前**把全部目标、全部补丁点检查完
  //    每个补丁点：已打（有 mark）就跳过；没打的，锚点必须**恰好 1 处**
  const todo = [] // [{ file, label, pending: [edit...] }]
  for (const t of TARGETS) {
    if (!existsSync(t.file)) { console.error('❌ 缺文件: ' + t.file); process.exit(1) }
    const src = readFileSync(t.file, 'utf8')
    const pending = []
    for (const e of t.edits) {
      if (hasMark(src, e.tag)) continue
      const n = src.split(e.before).length - 1
      if (n !== 1) {
        console.error(`\n❌ [${t.label} / ${e.tag}] 锚点不匹配：找到 ${n} 处（期望 1 处）。`)
        console.error('   通常意味着 DSH 版本不同、这段代码已被上游改动 —— 请对照 README 手工核对，别盲目强改。')
        console.error('   文件: ' + t.file)
        process.exit(2)
      }
      pending.push(e)
    }
    if (pending.length > 0) todo.push({ file: t.file, label: t.label, pending })
  }
  if (todo.length === 0) { console.log('\n✅ 所有补丁点都已是补丁状态，无需改动。'); process.exit(0) }

  // ② 写入：任何异常都回滚**全部已改目标**（M1）
  const done = [] // 已改过的 { file }
  const rollbackAll = (why) => {
    for (const d of done) {
      try { copyFileSync(d.file + BAK_SUFFIX, d.file); console.error('   已回滚: ' + d.file) }
      catch (e) { console.error('   ⚠️ 回滚失败: ' + d.file + ' —— ' + String((e && e.message) || e)) }
    }
    console.error('   （原因：' + why + '）')
  }
  try {
    for (const t of todo) {
      const bak = t.file + BAK_SUFFIX
      if (!existsSync(bak)) { copyFileSync(t.file, bak); console.log(`\n[${t.label}] 已备份 → ${path.basename(bak)}`) }
      else console.log(`\n[${t.label}] 备份已存在（保留最早的，不覆盖）`)
      let src = readFileSync(t.file, 'utf8')
      for (const e of t.pending) {
        // ⚠️ 用函数式替换：避免替换串里的 `$&` / `$1` 之类被当成特殊模式
        src = src.replace(e.before, () => e.after)
      }
      writeFileSync(t.file, src, 'utf8')
      const syn = syntaxCheck(t.file)
      if (!syn.ok) {
        if (syn.kind === 'syntax') {
          console.error(`❌ [${t.label}] 打补丁后语法检查失败，自动回滚…`)
          console.error(syn.out)
          copyFileSync(bak, t.file)
          rollbackAll('语法检查失败')
          console.error('   已回滚全部目标。')
          process.exit(3)
        }
        console.error(`⚠️ [${t.label}] 无法运行 \`node --check\`（${syn.out}）—— 跳过语法校验，**请自行复核该文件**。`)
      }
      done.push({ file: t.file })
      console.log('   ✅ 已应用：' + t.pending.map((e) => e.tag).join(' + '))
    }
  } catch (e) {
    console.error('\n❌ 打补丁过程中抛错：' + String((e && e.stack) || e))
    rollbackAll('抛出异常')
    process.exit(1)
  }
  console.log(`\n✅ 补丁已应用（死线 ${TIMEOUT_MS} ms），共 ${done.length} 个文件；目标 DSH 根 = ${DSH_ROOT}`)
  console.log('   覆盖两处：连接超时 connect + 首帧超时 open')
  console.log('   ⚠️ 需要**重启 `dsh web`** 才生效（客户端 bundle 是启动时快照的），重启后**再刷新一次页面**（Ctrl+F5）。')
  console.log('   ⚠️ 多安装机器请再确认一句：上面那个根就是**正在跑的那份**。')
  console.log('   回滚：node patch.mjs revert')
  process.exit(0)
}

// ─────────────────────────── revert ───────────────────────────
if (action === 'revert') {
  // ① 预检（M3 原子性 + M4 陈旧备份）：全部就位才动手；当前文件必须**至少有一个补丁标记**，否则拒绝
  const doable = []
  for (const t of TARGETS) {
    const bak = t.file + BAK_SUFFIX
    const cur = existsSync(t.file) ? readFileSync(t.file, 'utf8') : ''
    const anyMark = t.edits.some((e) => hasMark(cur, e.tag))
    if (!existsSync(bak)) {
      if (anyMark) {
        console.error(`❌ [${t.label}] 已打补丁但没有备份，无法安全回滚（不做反向替换以免二次破坏）：`)
        console.error('   ' + bak)
        process.exit(1)
      }
      console.log(`[${t.label}] 无备份且未打补丁 —— 跳过`)
      continue
    }
    if (!anyMark) {
      console.error(`❌ [${t.label}] 备份存在，但当前文件**不是补丁态**（很可能已被 DSH 升级/重装覆盖）。`)
      console.error('   用旧备份覆盖会把**较新的**文件换成旧版 ⇒ 拒绝执行。')
      console.error('   备份：' + bak)
      console.error('   确实要回滚，请先人工比对两个文件，再手动恢复。')
      process.exit(1)
    }
    doable.push(t)
  }

  // ② 全部检查通过后才真正落地
  let restored = 0
  for (const t of doable) {
    copyFileSync(t.file + BAK_SUFFIX, t.file)
    const syn = syntaxCheck(t.file)
    if (!syn.ok && syn.kind === 'syntax') {
      console.error(`❌ [${t.label}] 回滚后语法检查失败：`)
      console.error(syn.out)
      process.exit(3)
    }
    console.log(`[${t.label}] ✅ 已回滚到备份版本（备份仍保留）`)
    restored++
  }
  console.log(`\n✅ 已回滚 ${restored} 个文件。⚠️ 需要重启 \`dsh web\` 才生效。`)
  process.exit(0)
}
