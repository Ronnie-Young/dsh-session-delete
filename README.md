# dsh-session-delete · 会话回收站

[![CI](https://github.com/Ronnie-Young/dsh-session-delete/actions/workflows/ci.yml/badge.svg)](https://github.com/Ronnie-Young/dsh-session-delete/actions/workflows/ci.yml)

**给 DeepSeek Harness 的会话删除加一层后悔药：右键「移到回收站」，保留期内随时恢复，到期或手动删除才永久清除。**

DSH 自带的「归档」只是把会话藏起来，没有真正删除；这个插件补上「删除」，但把它做成回收站：
删掉的会话先进 `$DSH_HOME/session-delete/` 保留一段时间，期间可以从侧栏「回收站」页面恢复，
到期按配置自动永久删除或锁定。

## 特性

- **右键即删**：侧栏会话行右键（或行尾「···」）→「归档」下面多一条「移到回收站」，确认后立刻从侧栏消失；
- **侧栏「回收站」入口**：面板图标区多一个垃圾桶图标（有内容时带数量角标），点开是完整页面：标题、删除时间、剩余天数、「恢复」「永久删除」「清空回收站」；
- **删完能后悔**：移动成功后 toast 里直接给「恢复」按钮；恢复会把会话**放回原工作区、原位置**（原工作区已不存在则落「未分组」）；
- **保留期可配**：默认 14 天（1–365），到期行为二选一——`purge` 自动永久删除 / `lock` 保留但不可恢复；
- **图形化设置**：回收站页面底部就能改保留天数和到期处理，保存后插件自动重启一次立即生效；也可以直接在 `cordis.patch.yml` 里改；
- **不会误删**：只处理 JSONL 后端报出的真实会话目录（根目录、项目目录、根外路径、符号链接一律拒绝）；清单先写、再移文件，崩溃时启动 reconcile 回滚；同源校验只拒绝显式的跨站请求；
- **活会话不落「未分组」**：删除时仍活在内存里的会话保留归档墓碑，隐藏在所有分组视图里，等它真正释放后自动清理。

## 安装

需要先装好 DeepSeek Harness（桌面版或 CLI），DSH `>= 0.2.2-rc.5`、Node `^22.19.0 || >= 24.0.0`。

| 方式 | target | 说明 |
| --- | --- | --- |
| **插件市场**（发现页） | 先在「发现 → 管理索引源」添加 `https://ronnie-young.github.io/dsh-plugins-market/index.json`，再在市场里搜索 `session-delete` | 收录在 [dsh-plugins-market](https://github.com/Ronnie-Young/dsh-plugins-market) |
| **GitHub 源**（免 clone） | `github:Ronnie-Young/dsh-session-delete#v0.0.1` | pnpm 直接拉取 |
| **Release 压缩包** | `https://github.com/Ronnie-Young/dsh-session-delete/releases/download/v0.0.1/dsh-session-delete-0.0.1.tgz` | 从 GitHub Release 直链安装 |
| 本地目录（开发/排错） | `/你的路径/dsh-session-delete` | 先 `git clone` |

> 安装会申请 danger-full-access 权限，按提示批准。
> 浏览器端刷新页面即可；**宿主端（路由、到期清扫、启动 reconcile）的更新需要重启 App 才生效**。

## 用法

1. 在侧栏任意会话行上**右键**（或点行尾「···」），菜单最下面选「移到回收站」；确认框会写明保留天数与到期处理，默认焦点在「取消」；
2. 确认后这个会话立刻离开侧栏（正在运行的工作会先被停掉；删的是当前打开的会话时主视图一并退出），
   侧栏 toast 里提供「恢复」；
3. 点侧栏面板区的**垃圾桶图标**打开回收站：可以逐条「恢复」或「永久删除」，也可以「清空回收站」；
4. 页面底部的**设置**卡片里改保留天数 / 到期处理，保存后插件自动重启一次，新策略立刻生效。

> 为什么回收站不是会话列表里的一个分组：DSH 的 `sidebar.workspaces` 是官方 WorkspaceBrowser 独占的
> 单槽，插件注册进去会整体替换它（搜索、拖拽、归档筛选都会消失）。所以这里做成侧栏面板入口 + 主区页面。

## 配置

页面里的「设置」会通过 Harness 的 config editor 写入插件行配置；也可以在 profile 的
`cordis.patch.yml` 里覆盖（patch 会整体替换 `config`，要保留的键一并写上）：

```yaml
- id: session-delete
  config:
    retentionDays: 14      # 保留天数，默认 14，1–365
    expireAction: purge    # purge = 到期自动永久删除；lock = 保留但不可恢复
    dataDir: ''            # 留空用 $DSH_HOME/session-delete
```

- 若 profile 不支持保存插件配置，设置卡片会说明原因，并提示改 patch 或 Plugins 页；
- 若更高层（例如 bundle patch）已经写死了这些键，保存会被拒绝并如实显示原因。

## 数据文件

```text
$DSH_HOME/session-delete/
  trash.json                    # 回收站清单（版本 1）
  trash/<encoded session id>/   # 被移动的会话日志目录（含所有格式代际）
```

`trash.json` 里每条记录包含会话 id、标题、删除时间、到期时间、原日志路径、原所在工作区与前后位置。
清单**先写、再移文件**；两步之间崩溃时，启动 reconcile 会把「清单里有、文件没搬」的记录回滚，
会话重新可见，不会丢。

## 安全设计

- **路径守卫**：只处理形如 `<root>/--<项目目录>--/<会话目录>/` 的真实目录；根目录、项目目录、
  根外路径、非目录（含符号链接）一律拒绝，拒绝时一个文件都不动；回收站目录名使用 session id 的
  `~XXXX` 转义，不会出现 `../` 穿越。
- **跨文件系统**：`rename` 失败（`EXDEV`）时回退为「复制 + 删除原目录」。
- **路由**：同源校验只拒绝显式跨站证据（`Origin` 主机与请求 `Host` 不一致，或 `Sec-Fetch-Site`
  不是 `same-origin`/`none`）；破坏性操作只接受 JSON POST，读取列表只接受 GET；拒绝信息附带
  `origin/site/host/listener` 便于排查。
- **活会话**：永久删除仍活在内存里的会话时，归档记录保留到它释放（`session/disposed`）再清理，
  期间它不会回到侧栏。

## 失败时会怎样

| 情况 | 结果 |
| --- | --- |
| 停止/归档失败 | 什么都没动，对话框显示原因，可以重试 |
| 日志移不进回收站 | 清单条目回滚、会话挂回原工作区并取消归档，可重试 |
| 清单写不进（磁盘满等） | 同上回滚 |
| 恢复时原目录已被占用 | 拒绝恢复，回收站里仍保留该条目，可手动永久删除 |
| 永久删除时文件删不掉 | 保留该条目并如实报错，可重试 |
| App 版本过旧（宿主端还没加载回收站路由） | 提示「需要重启 App」并自动取消刚才的归档，不删任何文件 |

## 限制

- 只支持出厂自带的 JSONL 会话存储后端；换别的后端时会被拒绝而不是猜路径；
- 只处理这一个会话；它派生出去的 subagent 子会话是独立会话，不会被一起移动；
- 删除通过页面同源的 HTTP 路由执行，没有单独的远端授权层：能打开这个页面的 peer 都能触发。
  本机使用没有问题，开放远端访问前请自行评估；
- Windows 上如果日志仍被别的进程打开，移动会失败并如实报错（会话保持原状）；
- 已删会话的 `session_projcache` 投影缓存文件不会被清理（不在会话日志目录里），但它不参与列表，无害。

## 开发

```sh
npm install          # 安装 @deepseek-ai/schemastery（唯一的运行时依赖）
npm test             # 34 项测试：Host 路由 / 挂回位置 / 到期策略 / 路径守卫 / 客户端菜单与页面
npm pack --dry-run   # 检查发布包内容
```

目录：`index.js`（Host：路由、移动/恢复/删除、到期清扫、启动 reconcile）、`client.js`（浏览器：
菜单贡献、确认框、回收站页面、设置卡片）、`lib/path-guard.js`、`lib/trash-store.js`、`test/`。

## License

MIT © [Ronnie-Young](https://github.com/Ronnie-Young)
