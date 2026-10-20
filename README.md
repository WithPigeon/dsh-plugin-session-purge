# dsh-plugin-session-purge

在 DeepSeek Harness 界面里**删除会话**，删除是两段式的：会话标题旁的垃圾桶按钮、会话行「...」菜单里的「移到回收站」，都先把会话移进**左下角的回收站**（默认从会话列表消失）；回收站里能看到删除时间，可以逐个恢复、逐个彻底删除，也可以一键清空。另外提供 `session_purge` 工具，让 agent 直接彻底删除（绕过回收站）。

"Delete" is two steps: moving a session into a recycle bin at the sidebar foot, and
deleting it permanently from inside that bin. The bin keeps each session's title and
deletion time, and supports restore, permanent delete, and empty-all.

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
dsh plugin --profile <profile> add https://github.com/WithPigeon/dsh-plugin-session-purge/releases/download/v0.2.0/dsh-plugin-session-purge-0.2.0.tgz
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
| **左下角回收站入口** | `sidebar.footer.action`，order 10。带数量角标；侧栏收成 56px 轨道（`wide: false`）时只留图标 |
| **回收站面板** | `shell.overlay`，id `session-purge-trash-panel`。标题 + 删除时间，逐行「恢复」「彻底删除」，底部「清空回收站」 |
| 会话标题旁垃圾桶按钮 | `conversation.session.header.actions`，order 30 |
| 会话行「...」菜单项 | `sidebar.workspaces.session.menu.item`，order 500（在 pin/rename/fork/archive 之后） |
| 移到回收站确认 | `shell.overlay`，id `session-purge-dialog`。显示会话名 + 会话 ID，运行中额外警告；因为可逆，不再要求勾选 |
| 中英文文案 | 走 Client `locale` 服务（命名空间 `session-purge`），缺服务时按浏览器语言回退 |
| agent 工具 | `session_purge` —— 彻底删除，**绕过回收站** |

不可逆操作只有两个，都在回收站里，而且都能反悔：「彻底删除」单行需要**点两次** —— 第一次按钮变成「确认彻底删除？」，同时「恢复」原位换成「取消」，Esc 也先撤回确认而不是关面板，5 秒无操作自动撤回；「清空回收站」会先展开一条警示条再确认。

任何一次操作后都**不刷新整页**：调用 Client 的 `sessions.refresh()` 原地刷新列表；若离开列表的正是当前会话，再交给 `uiWorkspace.openSession()` 切到下一个。

## 回收站 / The recycle bin

**「移到回收站」= 归档（archive），不是删除。**

- 归档是 Harness 原生的隐藏机制：侧栏的 `sessionVisible()` 在默认视图里过滤掉 `archivedSessionIds`（`case "default": return !archived.has(session.id)`），只有切到「仅已归档」筛选才看得见。同时 `agent/pre-step` 闸门会拦住对被归档会话的后续唤醒，所以移进回收站的会话不会在后台偷偷继续跑。
- **归档不动工作区记账**，官方契约写得很直白：`unarchiveSession` 之后 *"the accounting slot was never touched, so the session returns to its recorded position"*。所以**恢复完全不需要插件记录位置信息** —— 回收站条目只有 `{ sessionId, title, deletedAt }` 三个字段，恢复就是一次 `unarchiveSession`。
- 回收站索引存在 `~/.dsh/session-purge/trash.json`，用临时文件 + `rename` 原子写入，崩溃不会留下截断的文件。
- `archiveSession(id, { stopActivity: true })` 会先写归档、再请 `workspace/session-stop` 提供者停掉正在跑的工作；归档集合本身就是停活之后那些唤醒要过的闸，所以不存在「停了又被唤醒」的窗口。

### 对账 / Reconciliation

每次读取回收站都会对账，丢弃两类条目：

1. **会话文件已经没了** —— 在别处被彻底删掉了；
2. **已经不在归档集合里** —— 在 Harness 自带的「已归档」视图里被恢复了。

第 2 条只在**归档集合确实读得到**时才生效。读不到时状态是 `unknown` 而不是 `false`：否则一个暂时不可用的 surface 会把整个回收站静默清空。

代价是：**通过本插件移进回收站的会话，在 Harness 自带的「仅已归档」筛选里也看得到。** 这是共用同一套隐藏机制的必然结果，也是刻意的取舍 —— 宁可与原生归档重合，也不自己搬动会话文件去伪造一个「消失」。


## 彻底删除链路 / What "permanently" means

只有从回收站点「彻底删除」或「清空回收站」，以及 agent 调用 `session_purge` 时，才会走这条链路。依次执行，每一步都是为了让上层不会把会话「复活」：

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
- **HTTP 路由**：`GET|POST /__session-purge/trash`、`POST /__session-purge/restore`、`POST /__session-purge/empty`、`POST /__session-purge/purge`、`GET /__session-purge/list`。webServer 本身不做鉴权，因此**每个** handler 都先用 `connection.requestRejection(req)` 过一遍 Host/Origin 闸 + 浏览器鉴权。
  - ⚠️ 这个服务**必须用 `ctx.get('connection')` 读取，不能用 `ctx.connection`**。Cordis 只在插件把服务写进 `inject` 时才能按属性访问，读一个没声明的服务会**抛异常**；而 webServer 对抛异常的 handler 会回一个**裸 400（无 body、无 Content-Type）**，从客户端完全看不出原因。官方 `dsh-host-open-in-app` 敢写 `Reflect.get(ctx, 'connection')`，是因为它的 `inject` 里列了 `connection`；本插件不能列（它也要在没有 web 面的 profile 里激活），所以走宽容的 `ctx.get()`。
  - 拿不到闸时**失败关闭**：返回 503 并说明原因，而不是无鉴权地把删除接口暴露出去。
  - 每个 handler 还额外套了一层 guard，任何未捕获异常都变成 JSON 500/503，不会再出现无法诊断的裸 400。
- 只处理本机 `~/.dsh` 下的 `sessions/`、`storages/session_projcache/`、`storages/workspace.json`。本安装的 `dsh-session-query-sqlite` 是 `:memory:`，没有额外索引需要清理。

## 验证 / Verification

- `npm test` 跑两个自包含脚本，**共 108 项全部通过**，都不碰真实 `~/.dsh`。**Host 半**（`node verify-session-purge.mjs`，53/53）在仓库旁边的临时 `DSH_HOME` 上用桩服务跑真实 `apply()`、真实工具与真实路由：
  - **彻底删除链路**：完整删除、归档/置顶集合清理、未知 id 404、非法 id 400、裸 uuid ↔ `session-` 前缀两种拼写、**存活会话 dispose 回写竞态后仍然删净**；
  - **回收站生命周期**：加档只归档、**磁盘文件一个字节都不少**；列表带标题与可解析的删除日期；恢复后文件仍在且索引清空；只有「彻底删除」才真的删盘；一键清空把两条都清干净；**在 Harness 自带归档视图里恢复后，对账会丢弃那条幽灵条目**；未知/非法 id 与「恢复不存在的条目」各自的拒绝码；
  - 路由族的四种闸门行为（闸拒绝→401、闸通过→业务 404、闸不可用→503 失败关闭、闸自身抛错→503 可诊断而非裸 400）。
- **Client 半**（`node verify-client-half.mjs`，55/55）用 `vm` 按模块加载器的方式执行真实 bundle、跑真实 `apply()`，再用一个**带状态**的极简 React 桩把五个占用者真的渲染出来，逐条断言：五个 slot 的 name/id/order、56px 轨道态与展开态的文案差异、确认对话由头部按钮打开、面板的空状态与逐行渲染、删除日期是人话而不是原始 ISO，以及**两步式「彻底删除」与「清空回收站」都是第一步不发请求、第二步才发**；armed 之后**「取消」能撤回、撤回本身不发请求、撤回后还能重新 armed**。
- **未验证**：没有对任何真实会话执行过删除或归档（不会在未获许可的情况下动你的数据）；浏览器内的视觉效果未逐帧核对 —— 上面覆盖的是结构、文案与交互逻辑，不是像素。

### 一次值得记录的误判（已在 v0.1.0 修复）

首版鉴权闸写成了 `Reflect.get(ctx, 'connection')`，而 `inject` 只声明了 `['tools']` —— 属性访问未声明的 Cordis 服务会抛异常，于是**每个请求都变成 webServer 那个裸 400**，界面上显示「删除失败: HTTP 400」。

排查时我一度把「裸 400、无 body、无 Content-Type」当成了**闸门拒绝**的证据（未注册的 `/__foo` 返回 404/405 也「印证」了路由已挂载）。真正的判据是**浏览器里点按钮同样 400** —— 闸门绝不会拒绝一个已鉴权的同源页面请求。翻 `dsh-host-webserver` 源码才看到那个 400 出自 `handle(...).catch(...)`：**handler 抛异常**的统一兜底。

教训：裸 400 在 DSH 里是「路由 handler 崩了」，不是「被拒绝了」——后者是 401/403 且通常带说明文字。

## 目录 / Layout

```
src/index.js              Host 半：回收站 + 彻底删除链路 + HTTP 路由 + session_purge 工具
                          （不 import 任何 @deepseek-ai 包）
src/client.js             Client 半：bundle factory，注册五个 slot 占用者
                          （三个入口 + 确认对话 + 回收站面板）
locale/{zh,en}.json       插件卡片显示名与描述
cordis.patch.yml          bundle patch
verify-session-purge.mjs  Host 半的自包含验证脚本（只跑桩数据，不碰真实 ~/.dsh）
verify-client-half.mjs    Client 半的自包含验证脚本（真实 bundle + 带状态的 React 桩）
package.json              包清单 + dsh.bundle / dsh.client 元数据
LICENSE                   MIT
```

运行期只写一个文件：`~/.dsh/session-purge/trash.json`（回收站索引）。其余状态都放在 Harness 自己的存储里，通过官方服务读写。

`npm test` 会在仓库旁建一个临时 `DSH_HOME`，跑完可以随手删掉。
`files` 字段只包含 `src/`、`locale/`、`cordis.patch.yml`、`README.md`，所以发布出去的 tarball 里没有验证脚本（`LICENSE` 由 npm 自动附带）。

Host 半故意**不 import 任何 `@deepseek-ai/*`**：profile 的 `node_modules/@deepseek-ai/*` 可能是与运行版本不同的旧副本，全部改成经 `ctx.get()` / `ctx.<service>` 取得，逐个特性检测，缺服务时降级而不是崩掉。

Client 半**不 import `dsh-client-ui-primitives`**：按官方 `practices.md`，自绘 `role="menuitem"` 按钮与弹窗，只用 `--dsw-alias-*` 主题 token，因此不会随 Client 包版本变动而失效。

## 参考 / Credits

功能与删除面参考了 [`lsz-asd/dsh-plugin-session-delete`](https://github.com/lsz-asd/dsh-plugin-session-delete)（MIT）。
本插件是独立实现，并针对 DSH 0.2.0-rc.2 做了以下改动：

- 用**真正的 slot** `sidebar.workspaces.session.menu.item` / `sidebar.footer.action` / `shell.overlay` 注入，而不是参考实现里的 DOM 注入 / MutationObserver；
- 删除改成**两段式回收站**（参考实现是一键彻底删）；
- 走 `workspaceRegistry` 的 `archiveSession` / `unarchiveSession` / `detachSession` / `unpinSession`，并额外清理 `pinnedSessionIds`（参考实现没有）；
- 增加 HTTP 鉴权闸、dispose 竞态的双次核对、以及未知 id 404 / 非法 id 400 / 不可恢复 410 的准确语义；
- Host 半不 import `@deepseek-ai/dsh-tools`，避免解析到 profile 中的旧副本。

## License

MIT
