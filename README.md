# dsh-plugin-session-purge

在 DeepSeek Harness 界面里**彻底删除会话**。会话标题旁有垃圾桶按钮，会话行「...」菜单里新增「彻底删除会话」，两处都会先弹出风险确认弹窗（必须勾选才能确认）。确认后删除会话日志、投影缓存与工作区记账，并提供 `session_purge` 工具让 agent 也能删除会话。

Permanently delete DeepSeek Harness sessions from the UI: a trash button beside the
session title and a "Delete session permanently" row in the session-row "..." menu,
both behind a risk-consent dialog, plus a `session_purge` tool for agents.

---

## 安装 / Install

`plugin_manager` 接受四种安装地址：npm 包名、Git 地址、tarball（本地或 http(s)）、本地绝对路径。

**从 npm**（若已发布）：

```sh
dsh plugin --profile <profile> add dsh-plugin-session-purge
```

**从 GitHub** —— 这条路径依赖目标机器上的 `git`（安装器会先跑 `git ls-remote` 探活，再由 pnpm clone）：

```sh
dsh plugin --profile <profile> add github:WithPigeon/dsh-plugin-session-purge
# 等价写法
dsh plugin --profile <profile> add https://github.com/WithPigeon/dsh-plugin-session-purge
```

**从 Release 附件里的 tarball** —— 走 HTTPS 取包，**目标机器不需要 git**，只认 URL 结尾必须是 `.tgz` / `.tar.gz`：

```sh
dsh plugin --profile <profile> add https://github.com/WithPigeon/dsh-plugin-session-purge/releases/download/v0.1.0/dsh-plugin-session-purge-0.1.0.tgz
```

**从本地目录**（开发时最方便，安装结果是软链接，源目录不能删）：

```sh
dsh plugin --profile <profile> add file:/abs/path/to/dsh-plugin-session-purge
```

以上任一种地址都可以交给 agent，用 `plugin_manager` 工具的 `action: install_bundle` 安装。

安装**新** bundle 可以通过 HMR 直接生效；**替换**已安装包需要重启 profile 才能加载新的 JS 模块。
当前版本**不支持自动更新**：升级要先卸载再装新版。

`PluginManager` accepts four address forms — an npm package name, a Git address, a tarball
(local or over http(s)), or an absolute local path. A **new** bundle can activate through
HMR; **replacing** an installed package needs a profile restart to load a fresh JavaScript
module generation. There is no auto-update yet: uninstall first, then install the new version.

## 功能 / Features

| | |
|---|---|
| 会话标题旁垃圾桶按钮 | `conversation.session.header.actions`，order 30 |
| 会话行「...」菜单项 | `sidebar.workspaces.session.menu.item`，order 500（在 pin/rename/fork/archive 之后） |
| 风险确认弹窗 | `shell.overlay`；显示会话名 + 会话 ID，运行中额外警告，必须勾选才能确认 |
| 中英文文案 | 走 Client `locale` 服务（命名空间 `session-purge`），缺服务时按浏览器语言回退 |
| agent 工具 | `session_purge` |

删除后**不刷新整页**：调用 Client 的 `sessions.refresh()` 原地刷新列表；若删掉的正是当前会话，再交给 `uiWorkspace.openSession()` 切到下一个。

## 删除链路 / What "permanently" means

依次执行，每一步都是为了让上层不会把会话「复活」：

1. **停止运行中的 agent** — `ctx.agents.get(id)` → `agent.cancel({kind:'user'})` → `await agent.whenIdle()`（15s 上限，卡住也不阻塞删除）。
2. **flush 存活会话** — `ctx.sessions.flush(session)`，把缓冲事件写进日志，避免在 teardown 时才写。
3. **从内存 store 摘除** — 让 dispose 路径没有东西可以重建。
4. **删除磁盘日志目录** — `~/.dsh/sessions/<slug>/<id>/`（含 `session.v4.jsonl.zstd`、`session.lock`、旧的 `session.vN.*`）；两种 id 拼写都清。
5. **删除投影缓存行** — 通过**已打开的 storage domain** `session_projcache` 的 `sessions` 表 `delete(id)`，内存与磁盘一致，后续 flush 不会重新发布。
6. **核对** — 重复清理并核对，直到**连续两次**确认干净（存活会话要求两次，普通会话一次）。
7. **最后**才解除工作区记账 — 该会话的 `sessionIds`、`archivedSessionIds`、`pinnedSessionIds`。放在最后，且只在日志确认删除后才做，避免「半删除」的会话掉进「未分组」。

### 为什么顺序是这样 / Why this order

- **`session/disposed` 的监听器不会被 await**，其中两个**会写盘**：jsonl writer 会 drain 缓冲，投影缓存会做最后一次 checkpoint。所以摘除存活会话之后必须留出静默窗口，并**连续两次**核对，否则可能被之后的写入重建。框架没有「dispose 已完成」的可等待屏障，这是目前能做到的最强保护。
- **不能绕过 domain 直接删 projcache 文件**：`per-record` 布局虽然删文件即刻持久，但 domain 内存里仍有该记录，之后任何 `put` 都会把文件写回来。
- **更不能绕过 domain 改 `workspace.json`**：`single` 布局每次写入都会重写整个文件，背后删除一定会被复活。所以工作区记账一律走 `ctx.workspaceRegistry`。

## 已知限制 / Known limitations

- **`ctx.storageDomain.get(name)`** 被上游标注为 "diagnostic surface"；但这是插件接触一个**已打开**的 domain 的唯一途径（`open()` 会因 `already-open` 抛错，且 owner 服务没有暴露删除方法）。这是一个有意为之、已被记录在案的依赖。
- **摘除存活会话用的是内部 API**（`sessions.detachEntered` / `sessions.store`，代码里已用特性检测包裹并标注 UNSUPPORTED）。没有它删除依然正确，只是少一层防护。
- **附件不删**：`~/.dsh/attachments/` 是内容寻址、跨会话共享的，按会话删除会破坏其它会话的引用。孤儿对象由上游延迟回收。
- **HTTP 路由**：`POST /__session-purge/purge`、`GET /__session-purge/list`。webServer 本身不做鉴权，因此两个 handler 都先用 `connection.requestRejection(req)` 过一遍 Host/Origin 闸 + 浏览器鉴权。
  - ⚠️ 这个服务**必须用 `ctx.get('connection')` 读取，不能用 `ctx.connection`**。Cordis 只在插件把服务写进 `inject` 时才能按属性访问，读一个没声明的服务会**抛异常**；而 webServer 对抛异常的 handler 会回一个**裸 400（无 body、无 Content-Type）**，从客户端完全看不出原因。官方 `dsh-host-open-in-app` 敢写 `Reflect.get(ctx, 'connection')`，是因为它的 `inject` 里列了 `connection`；本插件不能列（它也要在没有 web 面的 profile 里激活），所以走宽容的 `ctx.get()`。
  - 拿不到闸时**失败关闭**：返回 503 并说明原因，而不是无鉴权地把删除接口暴露出去。
  - 每个 handler 还额外套了一层 guard，任何未捕获异常都变成 JSON 500/503，不会再出现无法诊断的裸 400。
- 只处理本机 `~/.dsh` 下的 `sessions/`、`storages/session_projcache/`、`storages/workspace.json`。本安装的 `dsh-session-query-sqlite` 是 `:memory:`，没有额外索引需要清理。

## 验证 / Verification

- `npm test`（即 `node verify-session-purge.mjs`）在仓库旁边的临时 `DSH_HOME` 上用桩服务跑真实 `apply()` 与真实工具，**25/25 通过**，覆盖：完整删除、归档/置顶集合清理、未知 id 404、非法 id 400、裸 uuid ↔ `session-` 前缀两种拼写、**存活会话 dispose 回写竞态后仍然删净**，以及路由族的四种闸门行为（闸拒绝→401、闸通过→业务 404、闸不可用→503 失败关闭、闸自身抛错→503 可诊断而非裸 400）。
- 线上确认：三个 slot 占用者均已注册且 `active`（菜单项 order 500、头部按钮 order 30、弹窗 `session-purge-dialog`）；`session_purge` 工具已注册。
- **未验证**：没有对任何真实会话执行过删除（不会在未获许可的情况下删你的数据）；浏览器内的视觉效果未逐帧核对。

### 一次值得记录的误判（已在 v0.1.0 修复）

首版鉴权闸写成了 `Reflect.get(ctx, 'connection')`，而 `inject` 只声明了 `['tools']` —— 属性访问未声明的 Cordis 服务会抛异常，于是**每个请求都变成 webServer 那个裸 400**，界面上显示「删除失败: HTTP 400」。

排查时我一度把「裸 400、无 body、无 Content-Type」当成了**闸门拒绝**的证据（未注册的 `/__foo` 返回 404/405 也「印证」了路由已挂载）。真正的判据是**浏览器里点按钮同样 400** —— 闸门绝不会拒绝一个已鉴权的同源页面请求。翻 `dsh-host-webserver` 源码才看到那个 400 出自 `handle(...).catch(...)`：**handler 抛异常**的统一兜底。

教训：裸 400 在 DSH 里是「路由 handler 崩了」，不是「被拒绝了」——后者是 401/403 且通常带说明文字。

## 目录 / Layout

```
src/index.js              Host 半：删除链路 + HTTP 路由 + session_purge 工具（不 import 任何 @deepseek-ai 包）
src/client.js             Client 半：bundle factory，注册三个 slot 占用者
locale/{zh,en}.json       插件卡片显示名与描述
cordis.patch.yml          bundle patch
verify-session-purge.mjs  Host 半的自包含验证脚本（只跑桩数据，不碰真实 ~/.dsh）
package.json              包清单 + dsh.bundle / dsh.client 元数据
LICENSE                   MIT
```

`npm test` 会在仓库旁建一个临时 `DSH_HOME`，跑完可以随手删掉。
`files` 字段只包含 `src/`、`locale/`、`cordis.patch.yml`、`README.md`，所以发布出去的 tarball 里没有验证脚本（`LICENSE` 由 npm 自动附带）。

Host 半故意**不 import 任何 `@deepseek-ai/*`**：profile 的 `node_modules/@deepseek-ai/*` 可能是与运行版本不同的旧副本，全部改成经 `ctx.get()` / `ctx.<service>` 取得，逐个特性检测，缺服务时降级而不是崩掉。

Client 半**不 import `dsh-client-ui-primitives`**：按官方 `practices.md`，自绘 `role="menuitem"` 按钮与弹窗，只用 `--dsw-alias-*` 主题 token，因此不会随 Client 包版本变动而失效。

## 参考 / Credits

功能与删除面参考了 [`lsz-asd/dsh-plugin-session-delete`](https://github.com/lsz-asd/dsh-plugin-session-delete)（MIT）。
本插件是独立实现，并针对 DSH 0.2.0-rc.2 做了以下改动：

- 用**真正的 slot** `sidebar.workspaces.session.menu.item` + `shell.overlay` 注入，而不是参考实现里的 DOM 注入 / MutationObserver；
- 走 `workspaceRegistry` 的 `detachSession` / `unarchiveSession` / `unpinSession`，并额外清理 `pinnedSessionIds`（参考实现没有）；
- 增加 HTTP 鉴权闸、dispose 竞态的双次核对、以及未知 id 404 / 非法 id 400 的准确语义；
- Host 半不 import `@deepseek-ai/dsh-tools`，避免解析到 profile 中的旧副本。

## License

MIT
