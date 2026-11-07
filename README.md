# Cloude

Cloude 2.0 使用 Paseo 的完整 Electron 客户端和 daemon，提供 Claude Code / Codex、多项目与多主机、隔离 worktree、编辑器、终端、差异审阅、内嵌浏览器及定时任务。

默认打开新工作台。Windows 按 Alt 显示菜单，从 Cloude 菜单切换到“SSH 兼容工作台”，继续使用原有连接、加密凭据、历史和远端持久任务，并可选择默认启动的工作台。

## 2.0 工作台

- 本机工作使用随安装包提供的独立 daemon。Claude Code、Codex 等 agent CLI 需要在执行任务的机器上安装并认证。
- 远端 Paseo 主机需要先安装并启动兼容 daemon，再从 Settings → Add host → Remote SSH 添加。此入口通过系统 OpenSSH 使用密钥或 Agent，沿用 SSH config。
- 需要密码登录、原有 SFTP 操作或恢复 `~/.cloude-tasks/` 任务时，从应用菜单进入兼容 SSH 工作台。新 daemon 和旧任务运行器分别管理各自创建的任务。
- 新工作台支持 worktree 隔离、多个 agent、分屏、文件编辑、终端和浏览器。浏览器自动化需要在主机设置中启用，并保持桌面浏览器宿主在线。
- 定时任务运行在 daemon 所在机器。该机器和 daemon 需要在线。创建任务时检查运行目录、权限、时区及结果保留设置。
- 新工作台状态存于原应用数据根目录的 `paseo/` 中。原有 `workspace.json`、`credentials.json`、`known-hosts.json` 继续由兼容工作台读取。

2.0 的功能对照与验收边界见 [FEATURE-PARITY.md](FEATURE-PARITY.md)。官方产品的云任务、账号同步、办公产物平台和系统级电脑操作需要各自的服务或工具集成。

## 安装与更新

推荐在 [Releases](https://github.com/mumuyanxiu/cloude/releases/latest) 下载 `Cloude-Setup-<版本>.exe`。安装程序支持选择目录，默认按当前用户安装。后续升级沿用原安装目录和桌面快捷方式。

安装版启动后检查更新；在左侧“应用更新”中下载新版本，下载完成后点击“重启并安装”，后台安装后自动重新打开应用。有未保存文件、普通任务、交互终端或文件操作时，完成处理后再安装。开启断线续跑的独立任务可在客户端重启期间继续。网络中断可重试，下载校验通过后才能安装。

也可运行在线安装 / 更新脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-windows.ps1
# 首次安装可指定目录；升级时不传目录会沿用现有安装位置
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-windows.ps1 -InstallDirectory "D:\Apps\Cloude"
# 仅下载并校验安装包，或使用静默安装
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-windows.ps1 -DownloadOnly
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/update-windows.ps1 -Silent
```

脚本从 GitHub 最新稳定 Release 获取安装包，核对文件大小和 SHA256，再启动安装程序。运行脚本前保存文件并关闭应用。发布说明见 [RELEASE.md](RELEASE.md)。

## 连接与使用

以下操作适用于菜单中的 Cloude SSH 兼容工作台。

1. 点击“连接设备”，填写主机、SSH 用户和验证方式。
2. 选择私钥文件，或使用密码 / OpenSSH Agent。
3. 设置工作目录（默认 `~/claude-workspace`）与 Claude 命令（默认 `claude`）。
4. 核对并信任首次连接的 SSH 主机密钥。
5. 新建项目，或填写已有项目目录。

远端需要可通过 SSH 登录、可用的 Claude Code；读取历史会话需要 Python 3。账户用量查询支持 Claude Code 2.1.314 及更新版本。

- 聊天：`Ctrl+Enter` 发送；输入 `/` 查看常用命令。输出时上翻可保留阅读位置，点击“回到最新”或手动滚到底部后恢复跟随。
- 文件：支持文件和文件夹上传、文件下载、语法高亮编辑，`Ctrl+S` 保存。
- 历史会话：添加、切换项目或重新连接后，自动将该项目的远端历史列入“最近对话”；点击即可加载内容并继续原会话。刷新按钮可重新同步，加载失败时可重试。
- 新对话：归属于当前选中的项目；切换项目时只显示该项目的对话。
- 终端：支持命令补全、交互输入和停止任务。
- 权限：默认“跟随远端”，继承远端 Claude 的默认权限模式及用户、项目、本地权限规则，Bash 与 MCP 使用同一套规则。可显式选择“只读分析”（Claude 计划模式）。旧版自主运行命令开关不再覆盖远端配置。

## 1.1.0 新功能

- **模型与思考强度**：模型菜单从当前远端 Claude Code 的初始化接口读取模型 ID、官方显示名称和支持的思考强度，不内置固定模型名单；远端返回 Fable 或后续新增模型时会自动显示。连接、切换项目后重新读取，也可手动刷新；查询失败会明确提示并保留“跟随远端”和自定义模型入口。列表反映远端 CLI 的版本、提供方和配置，不保证每个条目的账户授权；最终可用性由远端服务决定。选择自动保存，对下一条消息生效，普通会话和断线续跑均支持，任务运行期间锁定。默认不覆盖远端配置；显式强度仅覆盖该任务的环境，发送前检查 CLI 支持情况。读取模型列表只进行初始化握手，不发送用户提示词，并关闭钩子、MCP 和会话持久化。
- **额度时间**：额度重置时间、更新时间和详情统一显示为 UTC+8（北京时间），不随电脑所在时区变化。
- **图片和文件粘贴**：截图后在聊天输入框按 `Ctrl+V`，或点击“粘贴图片或文件”。可从资源管理器复制文件或文件夹，也可拖入聊天框。附件显示缩略图，可移除；点击发送时上传，支持只发送附件。上传完成或失败后清理底部进度；失败时保留附件以便重试。普通文字粘贴保持原样。
- **图片预览**：聊天中的项目图片和文件列表中的 PNG、JPEG、GIF、WebP 可直接查看，支持原始尺寸、复制图片、保存和本地应用打开。单张预览和剪贴板图片上限为 20 MB。
- **文件引用**：点击搜索图标或输入独立的 `@` 查找项目文件；选中编辑器代码或交互终端内容后，可直接加入聊天。回复中的项目文件链接可点击打开。
- **远端网页**：顶部地球按钮管理 SSH 端口转发；远端 localhost 链接可自动建立转发并在本地浏览器打开。只监听本机回环地址，断开 SSH 时关闭隧道。服务端需要允许 TCP 转发。
- **交互终端与登录**：顶部终端按钮打开 xterm，支持 ANSI、方向键、Tab、窗口尺寸调整，并在同一 shell 中保留 `cd`、`export` 和虚拟环境状态。登录按钮执行远端 `claude auth login`，显示可在本地浏览器打开的认证链接，验证码粘贴回原终端。交互终端在关闭面板或断开连接时结束。
- **断线续跑与恢复**：聊天输入框下方默认开启“断线后继续运行”。任务由远端独立进程运行，客户端断开后可继续；重连自动接回未完成任务，顶部任务按钮可以查看、恢复和停止任务。恢复读取原任务输出，不重新提交提示词。
- **连续对话与缓存**：开启断线续跑时，同一会话、同一模型/思考强度/权限模式复用存活的 Claude 进程，保留其已加载的上下文；每条消息仍有独立任务记录。空闲一小时退出，每个项目最多保留四个空闲进程；配置或运行器版本改变、进程退出时使用官方 `--resume` 恢复。空闲期间不发消息保温。模型缓存及有效期由 Claude 服务决定，进程复用不保证每次命中。普通 SSH 模式仍逐条启动 CLI。
- **账户额度口径**：左侧显示官方 `/usage` 返回的账户累计用量，不将 token 或估算金额换算成订阅百分比。一条消息可能触发多轮工具和模型调用，新会话、缓存过期、大量文件读取都会影响消耗。额度查询不提交自然语言模型任务。
- **问题和授权卡片**：开启断线续跑后，Claude 的问题和权限请求显示在聊天中，回答后继续。工具审批支持拒绝、仅允许一次和“本项目始终允许此工具”。长期授权明确覆盖所示工具的所有调用（MCP 只授权该具体工具，不授权整个服务），通过 Claude 原生 `updatedPermissions` 协议保存到 `localSettings`，供当前任务和之后的 Cloude/TUI 会话使用。配置文件位置由远端 CLI 解析，通常是项目的 `.claude/settings.local.json`；可在 TUI 的 `/permissions` 查看和撤销。不会删除现有的禁止或每次询问规则，这些规则仍可能导致拒绝或重复询问。提问和计划模式切换不提供长期授权。审批卡显示远端返回的原因和受阻路径，Read 的原因需结合具体路径与权限规则判断。
- **桌面通知**：应用不在前台时，任务完成、失败或等待回答会发送 Windows 通知，点击返回对应聊天；可关闭“任务通知”。关闭客户端期间不会产生本地通知。
- **批量取回**：文件列表中的文件夹可打包下载为 ZIP，支持空目录。一次最多 10000 项、1 GB；符号链接需单独处理。PDF、常见 Office 文档及媒体文件可下载到应用缓存后用本地应用打开。

断线续跑需要 Linux/macOS、Python 3 及支持 stdio 交互协议的 Claude Code；本版本对官方 CLI **2.1.318** 验证了协议握手。远端重启、系统清理用户进程、认证失效或模型服务错误仍可能中断任务。无需此功能时可关闭该选项，使用原有普通 SSH 任务模式；此模式也继承远端权限，但无法显示审批卡，需要审批的操作可能被拒绝。仅恢复历史对话不会恢复一个已结束的进程。升级前已运行的后台任务使用当时保存的启动参数，新任务才会采用新的权限继承方式。

附件保存在项目的 `.cloude-attachments/` 下，建议将该目录加入项目自己的忽略规则。任务保存在远端 `~/.cloude-tasks/`，每个任务保存独立运行脚本、提示词、状态与最多 32 MB 的输出，不开放监听端口。记录不会自动清除；确认不再需要恢复的任务后，可自行清理对应目录。Claude 单行原始输出支持 64 MB；显示日志省略图片等内容的 base64 副本，不影响 Claude 读取原始内容。单条显示记录超过 16 MB 或日志累计超过 32 MB 时会明确报告失败。

## 数据位置

Cloude 的应用数据沿用既有配置目录 `%APPDATA%/Cloud Claude/`，开发版位于项目下 `.runtime/`。连接配置与会话保存在 `workspace.json`，主机指纹保存在 `known-hosts.json`，登录凭据使用当前 Windows 用户的 DPAPI 加密保存在 `credentials.json`。用户数据、密钥和测试输出均不纳入源码和安装包。

## 开发与验证

使用 Node.js 24：

```powershell
npm ci
npm run verify:privacy
npm test
npm run build
npm run test:desktop
npm run test:paseo
npm start
npm run start:legacy
npm run package
```

后台进程集成测试运行在 Linux：`python3 tests/task-runner-test.py`。Windows 开发机安装 Ubuntu-24.04 WSL 后可运行 `node tests/ssh-features-flow.cjs`，验证隔离的真实 SSH 断线重连、shell 状态和隧道。`python3 tests/protocol-smoke.py /path/to/claude` 只验证真实 CLI 握手，不调用模型。`python tests/permission-protocol-smoke.py /path/to/claude` 使用隔离配置与本机模拟模型服务，验证真实 CLI 的默认模式继承、单次/项目授权、跨会话复用和 deny/ask 优先级，不调用付费模型。

`python3 tests/session-protocol-smoke.py /path/to/claude` 在 Linux/macOS 上用临时 HOME 和回环模拟模型验证真实 CLI：两条消息复用进程、上下文前缀保持一致、无重复发送，且 `/usage` 不触发模型请求。需要支持该命令的近期 CLI，不调用付费模型。

`npm run dev` 打开浏览器预览。桌面集成测试位于 `tests/*-flow.cjs`、`tests/electron-smoke.cjs` 和 `tests/credentials-crossprocess.cjs`，使用本地测试数据与 SSH/SFTP 服务。

`npm run build:paseo` 根据 `paseo-lock.json` 获取固定版本源码、应用 Cloude 桌面适配并构建 `runtime/paseo/`。安装包携带该运行目录，用户启动时直接使用已构建的客户端与 daemon。上游许可证、来源和适配说明见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。

## 公开源码

`npm run verify:privacy` 检查源码中的内网地址、用户目录和常见凭据。可在被 Git 忽略的 `.privacy-patterns.local` 中添加个人设备名或项目名的 JSON 字符串数组，用于本机检查。提交前仍应查看差异，避免把个人数据写进测试或文档。

图标来源见 [assets/SOURCES.md](assets/SOURCES.md)。
