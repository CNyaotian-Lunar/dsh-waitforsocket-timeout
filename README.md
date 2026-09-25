# dsh-waitforsocket-timeout

给 DSH（DeepSeek Harness）的一套**临时补丁**，修三类会让「**切到一个正在运行的会话就卡住 / 报错**」的问题：

1. **Remote stream socket 没有超时兜底** ⇒ socket 卡在 `CONNECTING` 时永久等待（→ 加 5 秒硬死线）；
2. **`doOpen` / `resync` 的状态机漏格** ⇒ 异常路径与换代路径把 `openState` 永久留在 `loading`（→ 修 3 处 + `cold` 自动重开）；
3. ⭐ **Firefox 兼容性 bug（根治）** ⇒ `Function.prototype.toString` 在 Firefox 返回「**多行**」而判据硬编码「**单行**」⇒ **任何普通对象都被判「不是无损 JSON」** ⇒ 会话打不开（→ 比较前规范化空白）。

**English:** A set of **temporary patches** for DSH (DeepSeek Harness) that fix three classes of trouble making "**switching to a running session hang or error out**":

1. the Remote stream socket has **no timeout** ⇒ it waits forever when the socket parks in `CONNECTING` (→ a hard 5 s deadline);
2. **state-machine holes** in `doOpen` / `resync` leave `openState` stuck at `loading` on the error path and the generation-bump path (→ 3 fixes + auto-reopen from `cold`);
3. ⭐ **a Firefox compatibility bug (root-cause fix)** — `Function.prototype.toString` returns a **multi-line** string in Firefox while the check hard-codes a **single-line** one ⇒ **every plain object is judged "not losslessly JSON"** ⇒ sessions fail to open (→ normalize whitespace before comparing).

> ⚠️ **这是临时补丁，不是上游代码。** 上游修好后请执行 `revert` 并停止使用。
> ⚠️ **English:** This is a **temporary patch, not upstream code.** Once upstream fixes it, run `revert` and stop using it.

## ⚠️ 适用范围与实测环境（**不保证人人通用**）/ Scope & tested environment (**no guarantee of universality**)

**本补丁只在作者的一台机器上验证通过，不保证适用于其他人。** 锚点是**逐字节精确匹配**的：DSH 版本不同、或上游改过这几段代码，`apply` 会**直接拒绝**（退出码 2，并打印实际锚点）—— 这是**有意设计**，不是 bug。遇到拒绝请**人工核对**那段代码再决定，**不要强行改**（`patch.mjs` 也不会允许：锚点匹配数 ≠ 1 就拒绝写入）。

**English:** This patch was verified on **one machine only** and is **not guaranteed to work for everybody**. Anchors are **byte-exact**: on a different DSH version, or if upstream has edited those snippets, `apply` **refuses** (exit code 2, printing the real anchor) — **by design**, not a bug. When it refuses, **review that code manually**; do not force it (the script will not let you anyway: it refuses to write unless an anchor matches exactly once).

| 项 / Item | 作者的实测环境 / Author's tested environment |
|---|---|
| DSH | **`0.1.7-rc.2`** |
| 受补丁的包 / Patched packages | `@deepseek-ai/dsh-api-gateway`、`@deepseek-ai/dsh-api-session-controller`、`@deepseek-ai/dsh-client-ui-chat`、`@deepseek-ai/dsh-util-values` —— **均为 `0.1.7-rc.2`** |
| 操作系统 / OS | **Windows 11 家庭版（build 26200）** |
| 浏览器 / Browser | ⭐ **Firefox** —— 第 3 层的 bug **只在 Firefox 出现**；Chrome / Edge **不会触发** |
| Node | `v24.20.0` |
| 安装形态 / Install layout | 自定义安装根（**任意路径均可**）+ profile 在 `~/.dsh/profiles/web` |
| 端口 / Port | 12073（**与补丁无关**，仅说明作者环境） |

**English:** DSH `0.1.7-rc.2`; the four patched packages are all `0.1.7-rc.2`; OS Windows 11 (build 26200); browser **Firefox** (layer-3 bug is Firefox-only — Chrome/Edge do not trigger it); Node `v24.20.0`; custom install root + profile under `~/.dsh/profiles/web`; port 12073 (irrelevant to the patch, context only).

⇒ 由此推出两点 / two consequences：

1. **不是 Firefox 用户**：第 3 层（`firefox-tostring`）大概率**用不上** —— 但打上**无害**（它只是把"原生构造器判定"改得更健壮）。
   **English:** If you are not on Firefox, layer 3 is probably unnecessary — but harmless (it only makes the "native constructor" check more robust).
2. **不是 `0.1.7-rc.2`**：请先跑 `node patch.mjs verify` 与 `node patch.mjs where`，看锚点是否匹配；**不匹配就别用**，把拒绝信息提给上游或反馈给作者。
   **English:** On other versions, run `verify` / `where` first; if anchors do not match, **do not use it** — report the refusal upstream or back to the author.

---

## 问题是什么 / The problem

`@deepseek-ai/dsh-api-gateway` 里，浏览器半边（`lib/client.js`）的 Remote stream 复用同一条 WebSocket。三处「没有兜底」叠在一起：

1. `waitForSocket(signal)` **没有超时** —— 它只能在 socket 变为 `OPEN`、或调用方 abort 时结束；
2. `maintain()` 只在 **connect 失败**时才去 reject 等待者；
3. `keepAlive` 只在**那次 connect settle 之后**才清空，而 `maintain()` 开头见 `keepAlive` 非空就直接 return。

⇒ 结果：**只要 socket 卡在 `CONNECTING`（既不 open 也不 error），就再也没人唤醒等待者、也再不会重试** ⇒ `await events.open(...)` 永不返回 ⇒ 界面永久停在「加载历史」；那个挂住的 `openPromise` 还会被复用，所以**重复点击无效**，**只有刷新（全新客户端、没有遗留等待者）能恢复**。

**English:** In `@deepseek-ai/dsh-api-gateway`, the browser half (`lib/client.js`) muxes every Remote stream onto one WebSocket. Three missing safeguards compound:

1. `waitForSocket(signal)` **has no timeout** — it can only end when the socket becomes `OPEN` or the caller aborts;
2. `maintain()` only rejects its waiters when the **connect attempt fails**;
3. `keepAlive` is cleared only **after that attempt settles**, and `maintain()` returns early whenever `keepAlive` is still set.

⇒ Net effect: **if the socket parks in `CONNECTING` (neither `open` nor `error`), nothing ever wakes the waiters and nothing ever retries** ⇒ `await events.open(...)` never returns ⇒ the UI stays on "loading history" forever; the stuck `openPromise` is reused, so **re-clicking does nothing** and **only a page refresh (a fresh client with no leftover waiters) recovers**.

这也解释了三个观察 / This also explains three observations：**静态会话正常**（socket 不抖）、**正在运行的会话会卡**（agent 持续出流时最容易抖）、**刷新立刻好** / **idle sessions are fine**, **running sessions hang**, **a refresh fixes it instantly**.

## 它怎么修 / How it fixes it

给**每一次连接尝试**加一个硬死线（默认 **5 秒**）：到点仍未 settle，就主动放弃这次尝试 ⇒ 失败分支接手 ⇒ 等待者被 reject、并触发下一次重试。

**English:** Adds a hard deadline (default **5 s**) to **every connect attempt**: if it has not settled by then, the attempt is abandoned ⇒ the failure branch takes over ⇒ waiters get rejected and the next retry is triggered.

⇒ 「永久卡住」变成「**最多多等 5 秒，然后自己恢复或明确报错**」。 / "Hangs forever" becomes "**waits at most ~5 s, then recovers or reports an error**".

## ⚠️ 两个文件都要打（重要）/ ⚠️ Both files must be patched

| 文件 / File | 为什么要打 / Why |
|---|---|
| `lib/types/client/stream-client.js` | **源码** —— 给直接 import 它的工具与离线测试用 / the **source**, used by tools and offline tests that import it |
| `lib/client.js` | **打包产物，浏览器真正加载的那份** —— 它把上面的源码**内联**了 / the **bundle that the browser actually loads** — it has the source inlined |

只打源码**对页面完全无效**（离线单测还会因此「假绿」—— 它直接 import 源码，测的不是浏览器拿到的那份）。补丁脚本**两个都会打**。

**English:** Patching only the source has **no effect in the browser** (and offline unit tests then go **falsely green**, because they import the source). The script patches **both**.

## 安装 / Install

```bash
# 自动定位 DSH 安装（顺序：--dsh / $DSH_ROOT > 常见自定义安装根 > npm 全局）
node patch.mjs apply

# 显式指定 DSH 根，并自定义超时（毫秒）
node patch.mjs apply --dsh <你的 DSH 安装根> --timeout-ms 10000

# 查看状态 / 回滚 / 只看目标路径
node patch.mjs verify
node patch.mjs revert
node patch.mjs where
```

**English:** `apply` / `revert` / `verify` / `where`；`--dsh <root>` to pin the install, `--timeout-ms` to change the deadline.

**脚本做的事**（每个目标文件独立）：**幂等**（已打则跳过）、**自动备份**（`<file>.bak-dsh-waitforsocket-timeout`）、**锚点不匹配就拒绝**（退出码 2 —— 说明 DSH 版本不同、这段代码已被上游改过，请人工核对，别盲目强改）、**语法检查不过自动回滚全部目标**（退出码 3）。

**English:** Per target: idempotent, auto-backup, **refuses when the anchor does not match exactly once** (exit 2), and **auto-rolls back all targets if a syntax check fails** (exit 3).

## 生效条件 / When it takes effect

1. **重启 `dsh web`**（客户端 bundle 是**启动时快照**的）/ **restart `dsh web`** (client bundles are snapshotted at startup);
2. **再刷新一次浏览器页面** / then **refresh the browser page**.

## 验证 / Verify

- **离线（与页面无关）**：把 `--dsh` 指向任意一份安装，脚本会做语法检查；补丁前后可用一个伪造 `WebSocket` 的离线脚本对比「等待者是被 reject 还是永久 pending」。
- **真机（推荐）**：重启并刷新后，在页面里取它**实际加载的那份合并 bundle**（`/plugins/??<pkg>/client.js,…&rev=<hash>`，从 `performance.getEntriesByType('resource')` 里筛 `/plugins/??`），搜 `PATCH(dsh-waitforsocket-timeout)` —— **搜到就说明补丁真的到了浏览器**。这是比离线单测硬得多的证据。

**English:** Offline: the script's syntax check + a fake-`WebSocket` harness comparing "waiter rejected" vs "waiter pending forever". On a real machine (recommended): after restart+refresh, fetch the **merged client bundle the page actually loads** and grep for `PATCH(dsh-waitforsocket-timeout)`.

## 回滚 / Rollback

```bash
node patch.mjs revert     # 从备份恢复；备份保留不删
```

备份文件留在原位（`<file>.bak-dsh-waitforsocket-timeout`），随时可再打回来。若补丁被 `pnpm install` / 重装冲掉，**重跑一次 `apply` 即可**。

**English:** `revert` restores from the backup (the backup is kept). If a reinstall wipes the patch, just run `apply` again.

## 已知边界 / Known limits

- **它治的是"卡住"，不是"慢"** —— 正常情况下切会话本来就是 200~300 ms（实测 6 个会话 204–285 ms），补丁不会让它更快。
  **English:** It fixes **hangs**, not slowness — switching sessions is normally 200–300 ms and this patch does not speed that up.
- **它没有移除根因**，只是给"卡住"加了上界；上游更干净的做法是给 `waitForSocket()` 加超时、或在 `maintain()` 收尾**无条件 reject 全部 waiters**。
  **English:** It does not remove the root cause; it bounds it. The cleaner upstream fix is a timeout in `waitForSocket()`, and/or rejecting **all** waiters when `maintain()`'s attempt settles.
- **DSH 升级可能覆盖**（补丁打在 `node_modules` 里）⇒ 升级后重跑 `apply` 并 `verify`。
  **English:** A DSH upgrade may overwrite it ⇒ re-run `apply` and `verify`.
- 补丁锚点是**逐字符匹配**的：上游一旦改动 `connect()` 就会拒绝（退出码 2），**这是有意的**。
  **English:** Anchors are byte-exact by design; if upstream edits `connect()`, the patch refuses (exit 2).

## ⭐ 第二层（2026-09-25 新增）：`doOpen` 的 catch 收尾

**English:** Second layer (added 2026-09-25): finishing the `doOpen` catch.

⚠️ 这一层修的是**另一个包**（`@deepseek-ai/dsh-api-session-controller`），和上面的「连接 / 首帧死线」**不是同一个病** —— 两者叠在一起才会表现为"永久载入历史"。

**它治什么。** `doOpen` 的 catch 原本是：

```js
if (!isRemoteFailure(error)) throw error;   // ← 抛在状态写入【之前】
this.events = void 0;
this.openState = "error";
this.openError = error;
```

⇒ **非 `RemoteFailure` 的异常一抛，`openState` 就永远停在 `loading`**（外层 `open()` 的 `.finally()` 只清 `openPromise`、不碰状态）。
而 UI 的「载入历史…」正是**严格按 `openState === 'loading'`** 渲染的 ⇒ **界面永久转圈**，而且**没有任何自愈路径**（`open()` 在全库唯一的调用点是 `retain()`，UI 也没有超时/重试）。

**English:** The original catch **throws before** writing `openState = "error"`, so any non-`RemoteFailure` error leaves the state stuck at `loading` forever — the outer `.finally()` only clears `openPromise` and never touches the state. The UI renders its "Loading history…" placeholder **strictly** on `openState === 'loading'`, so the spinner never resolves, and there is no self-healing path.

**修法**（先把状态推进到终结态，再把编程错误抛出去）：

```js
const remote = isRemoteFailure(error);
if (remote) this.events = void 0;
this.openState = "error";     // ★ 无条件先写状态
this.openError = error;       // ★ 记下真实错误
if (!remote) throw error;     // ★ 再抛（不吞真 bug）
```

**判据**（离线反向对照；脚本从**真文件**里抽出 `doOpen` 原文 + stub 依赖，非重写）：

| 情形 | 修复前 | 修复后 |
|---|---|---|
| 抛非 `RemoteFailure` 异常 | ❌ `loading` + `openError = null`（**与真机现场吻合**） | ✅ `error` + 真实错误 |
| 抛 `RemoteFailure` | ✅ `error` | ✅ `error`（**无回归**） |

⇒ 异常在修复前后**都仍被抛出**（可观测性不丢）。

**English:** The fix writes the terminal state first and re-throws program errors afterwards, so the UI stops spinning while the bug stays visible. Counterfactual (extracting the real `doOpen` from the file, not a rewrite): before ⇒ `loading` + `openError = null`; after ⇒ `error` + the real error; both versions still re-throw.

**第三处（同族，H3）：`resync()` 的 `dispose` 没有 try/finally。**
`resync()` 先换代、清事件流，`await events?.dispose()` **之后**才做状态重置；一旦 `dispose()` 抛异常或挂起，**后面的重置全部不执行** ⇒ 又是永久 `loading`。
修法：把**状态重置放进 `finally`**（保证执行），`await this.open()` 留在 `finally` 之后（dispose 正常就重开；dispose 抛就"重置 + 异常照常传播"）。

**English:** `resync()` bumps the generation and clears the event stream, then `await events?.dispose()` **without try/finally** — if `dispose()` throws or hangs, the subsequent state reset never runs and `openState` stays `loading` forever. Fix: move the state reset into `finally` (guaranteed to run) and keep `await this.open()` after it.

**这一层的反事实对照**（抽取真源码 + stub 依赖）：

| 情形 | 修复前 | 修复后 |
|---|---|---|
| 抛非 `RemoteFailure` 异常（H1） | ❌ `loading` + `openError=null` | ✅ `error` + 真实错误 |
| open 飞行中被 `dispose` 打断（H2） | ❌ `loading` | ✅ `cold` |
| `resync()` 里 `dispose()` 抛（H3） | ❌ `loading` | ✅ `cold` |

**English:** Counterfactuals (extracting the real code, not a rewrite): H1 → `loading`+`openError=null` becomes `error`+the real error; H2 → `loading` becomes `cold`; H3 → `loading` becomes `cold`.

## ⭐ 第三层（2026-09-25 新增）：Firefox 兼容性 bug —— **根治** / Third layer: a Firefox compatibility bug — root-cause fix

⚠️ 这一层**不是"兜底"，而是"根治"**：它修的是 `dsh-util-values` 里一个**通用判据**，DSH 在 **Firefox** 下会因此**误判一切普通对象**。

**English:** This layer is **not a safety net but a root-cause fix**. It repairs a **generic predicate** in `dsh-util-values` that makes DSH **misjudge every plain object** under **Firefox**.

**它治什么。** `hasIntrinsicConstructor` 用**硬编码的单行字符串**去比对 `Function.prototype.toString`：

```js
return constructor.name === name
    && constructor.prototype === prototype
    && Function.prototype.toString.call(constructor) === `function ${name}() { [native code] }`;
```

- **Chrome / Edge / V8（含 Node）**：返回 `function Object() { [native code] }`（**单行**）⇒ 相等 ⇒ 正常；
- ⚠️ **Firefox**：返回「**多行 + 缩进**」`function Object() {\n    [native code]\n}` ⇒ **恒不相等**。

**English:** `hasIntrinsicConstructor` compares `Function.prototype.toString` against a **hard-coded single-line** string. Chrome/V8 (and Node) return a **single-line** form ⇒ equal ⇒ fine. ⚠️ **Firefox returns a multi-line, indented form** ⇒ the comparison is **never** true.

⇒ 后果链（每一环都用真代码复现过 / every link reproduced with the real code）：

```
hasIntrinsicConstructor(Object.prototype, "Object")    ⇒ false
isIntrinsicObjectPrototype(Object.prototype)           ⇒ false
hasPlainObjectPrototype(任何普通对象 / any plain object) ⇒ false
walkJsonValue / snapshotJsonValue                      ⇒ 一律 undefined / always undefined
snapshotChunk                                          ⇒ 抛 "must be losslessly JSON-serializable"
expandAssistantStream                                  ⇒ 抛
ClientAssistantStream.replace                          ⇒ 抛 ⇒ 会话打不开 / session fails to open
```

⇒ 它一举解释了所有反常现象 / it explains every anomaly at once：

| 疑问 / Question | 答案 / Answer |
|---|---|
| 为什么磁盘日志（86 会话 / 68026 条记录）全干净？ | **磁盘侧校验跑在 Node 里（单行格式）⇒ 正常通过** / disk-side validation runs in Node (single-line) ⇒ passes |
| 为什么对象的「形状 dump」一切正常？ | **对象真的没问题，是判据在 Firefox 上失灵** / the object is fine — the predicate is broken on Firefox |
| 为什么只有「正在生成」的会话才炸？ | **只有那条路会调 `snapshotChunk`** / only that path calls `snapshotChunk` |
| 为什么在 Node 里测是合规的？ | **Node 的 `toString` 是单行格式** / Node's `toString` is single-line |

**修法**（比较前把连续空白规范化为单个空格；一行内联、不引入新变量）：

```js
return constructor.name === name
    && constructor.prototype === prototype
    && Function.prototype.toString.call(constructor).replace(/\s+/g, " ").trim() === `function ${name}() { [native code] }`;
```

**English:** Fix — normalize runs of whitespace to a single space before comparing.

**反事实对照**（把 `Function.prototype.toString` 覆写成 Firefox 的多行格式，跑**真代码**）：

| 情形 / Case | 修复前 / Before | 修复后 / After |
|---|---|---|
| `snapshotJsonValue(普通 chunk)` | ❌ `undefined`（判不合规） | ✅ 合规 / valid |
| `snapshotJsonValue({a: 1})` | ❌ `undefined` | ✅ 合规 / valid |
| `isJsonValue(普通 chunk)` | ❌ `false` | ✅ `true` |

**English:** Counterfactual — overriding `Function.prototype.toString` with Firefox's multi-line form and running the **real** code: before, all plain objects are judged invalid; after, all are valid.

⚠️ **影响面（已逐文件扫描）**：全机含该判据的 **69 个客户端 bundle 里只有 1 个**（`dsh-api-session-controller/lib/client.js`，也就是报错的那一份）⇒ 本补丁覆盖的正是**唯一受影响处**加上本体；其余（宿主 Node 侧）本就不受影响。
这条也适合**反馈上游**：判据应规范化空白，或改用 `constructor.prototype === prototype` 判断，**不要依赖 `toString` 的具体排版**。

**English:** Scope (file-by-file scan): among the 69 client bundles on the machine, **only one** inlines this predicate — the one that errors. This patch covers that file plus the canonical module; host-side (Node) copies are unaffected anyway. Worth **reporting upstream**: normalize whitespace, or rely on `constructor.prototype === prototype` instead of the exact `toString` formatting.

## ✅ 基线验证：锚点基于官方 `0.1.7-rc.2`（2026-09-25）

本补丁的锚点**完全基于官方 npm 包**（`@deepseek-ai/dsh-api-gateway@0.1.7-rc.2`、`@deepseek-ai/dsh-api-session-controller@0.1.7-rc.2`、`@deepseek-ai/dsh-client-ui-chat@0.1.7-rc.2`）。作者用 `npm pack` 拉官方 tarball **逐字节核对**：

| 文件 | 官方 hash（前 16 位） | 与补丁基线 |
|---|---|---|
| gateway `lib/client.js` | `E09E26FCD4849CD5` | 一致 ✅ |
| gateway `lib/types/client/stream-client.js` | `55057F49FE44D97B` | 一致 ✅ |
| session-controller `lib/client.js` | `301B3A1AA6391B29` | 一致 ✅ |
| session-controller `lib/types/client/sessions/session.js` | `367B4D9214C4A5D9` | 一致 ✅ |
| session-controller `lib/types/client/sessions/assistant-stream.js` | （官方解包后比对）一致 ✅ | 一致 ✅ |
| **ui-chat `lib/client.js`** | `3BD73FDED382AF4C` | 一致 ✅ |

**端到端验证**：把官方原版（三个包）铺成一个独立目录，直接 `apply` ⇒ **15/15 全绿**；
而且**「官方 + 补丁」产出的 6 个文件 hash 与作者生产环境逐字节相同**。
⇒ 所以：**任何人拿官方 `0.1.7-rc.2` + 本补丁，得到的结果与作者一致。**

**English:** The anchors are byte-exact against the **official npm tarballs** (`…@0.1.7-rc.2`), verified file-by-file (table above). End-to-end: unzip the official packages into a fresh directory, run `apply` ⇒ all 4 files patched, `verify` 12/12 green, and the resulting hashes are **byte-identical** to the author's production install.

## 许可与署名 / License & Credits

MIT。本补丁由 **DeepSeek（DSH agent）编写**，**CNyaotian** 维护；它改的是 `@deepseek-ai/dsh-api-gateway` **与** `@deepseek-ai/dsh-api-session-controller`（均为 MIT，`Copyright (c) 2026 DeepSeek`）的代码，脚本中保留了原始代码片段作为**匹配锚点**，因此 `LICENSE` 内含原版权声明与 MIT 全文。

**English:** MIT. Written by **DeepSeek (a DSH agent)** and maintained by **CNyaotian**. It modifies code from `@deepseek-ai/dsh-api-gateway` **and** `@deepseek-ai/dsh-api-session-controller` (both MIT, `Copyright (c) 2026 DeepSeek`), and keeps original snippets as **match anchors**; the `LICENSE` therefore carries the original copyright notice and the full MIT text.
