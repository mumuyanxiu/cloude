# Cloude

通过 SSH 连接 Claude Code 的 Windows 桌面工作台，支持图片与文件粘贴、远端图片预览、交互终端、端口转发、断线续跑、项目与历史会话、代码编辑、Git 差异及账户用量。

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

1. 点击“连接设备”，填写主机、SSH 用户和验证方式。
2. 选择私钥文件，或使用密码 / OpenSSH Agent。
3. 设置工作目录（默认 `~/claude-workspace`）与 Claude 命令（默认 `claude`）。
4. 核对并信任首次连接的 SSH 主机密钥。
5. 新建项目，或填写已有项目目录。

远端需要可通过 SSH 登录、可用的 Claude Code；读取历史会话需要 Python 3。账户用量查询支持 Claude Code 2.1.314 及更新版本。

- 聊天：`Ctrl+Enter` 发送；输入 `/` 查看常用命令。
- 文件：支持文件和文件夹上传、文件下载、语法高亮编辑，`Ctrl+S` 保存。
- 历史会话：添加、切换项目或重新连接后，自动将该项目的远端历史列入“最近对话”；点击即可加载内容并继续原会话。刷新按钮可重新同步，加载失败时可重试。
- 新对话：归属于当前选中的项目；切换项目时只显示该项目的对话。
- 终端：支持命令补全、交互输入和停止任务。
- 权限：在输入框旁选择编辑或只读模式，并设置是否允许自主运行命令。

## 1.1.0 新功能

- **图片和文件粘贴**：截图后在聊天输入框按 `Ctrl+V`，或点击“粘贴图片或文件”。可从资源管理器复制文件或文件夹，也可拖入聊天框。附件显示缩略图，可移除；点击发送时上传，支持只发送附件。普通文字粘贴保持原样。
- **图片预览**：聊天中的项目图片和文件列表中的 PNG、JPEG、GIF、WebP 可直接查看，支持原始尺寸、复制图片、保存和本地应用打开。单张预览和剪贴板图片上限为 20 MB。
- **文件引用**：点击搜索图标或输入独立的 `@` 查找项目文件；选中编辑器代码或交互终端内容后，可直接加入聊天。回复中的项目文件链接可点击打开。
- **远端网页**：顶部地球按钮管理 SSH 端口转发；远端 localhost 链接可自动建立转发并在本地浏览器打开。只监听本机回环地址，断开 SSH 时关闭隧道。服务端需要允许 TCP 转发。
- **交互终端与登录**：顶部终端按钮打开 xterm，支持 ANSI、方向键、Tab、窗口尺寸调整，并在同一 shell 中保留 `cd`、`export` 和虚拟环境状态。登录按钮执行远端 `claude auth login`，显示可在本地浏览器打开的认证链接，验证码粘贴回原终端。交互终端在关闭面板或断开连接时结束。
- **断线续跑与恢复**：聊天输入框下方默认开启“断线后继续运行”。任务由远端独立进程运行，客户端断开后可继续；重连自动接回未完成任务，顶部任务按钮可以查看、恢复和停止任务。恢复读取原任务输出，不重新提交提示词。
- **问题和授权卡片**：开启断线续跑后，Claude 的问题和权限请求显示在聊天中，回答后继续。可在权限设置中关闭自主执行并开启“命令需要权限时询问我”；未开启这两项时仍禁止 Bash。授权只应用于当前请求。
- **桌面通知**：应用不在前台时，任务完成、失败或等待回答会发送 Windows 通知，点击返回对应聊天；可关闭“任务通知”。关闭客户端期间不会产生本地通知。
- **批量取回**：文件列表中的文件夹可打包下载为 ZIP，支持空目录。一次最多 10000 项、1 GB；符号链接需单独处理。PDF、常见 Office 文档及媒体文件可下载到应用缓存后用本地应用打开。

断线续跑需要 Linux/macOS、Python 3 及支持 stdio 交互协议的 Claude Code；本版本对官方 CLI **2.1.318** 验证了协议握手。远端重启、系统清理用户进程、认证失效或模型服务错误仍可能中断任务。无需此功能时可关闭该选项，使用原有普通 SSH 任务模式。仅恢复历史对话不会恢复一个已结束的进程。

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
npm start
npm run package
```

后台进程集成测试运行在 Linux：`python3 tests/task-runner-test.py`。Windows 开发机安装 Ubuntu-24.04 WSL 后可运行 `node tests/ssh-features-flow.cjs`，验证隔离的真实 SSH 断线重连、shell 状态和隧道。`python3 tests/protocol-smoke.py /path/to/claude` 只验证真实 CLI 握手，不调用模型。

`npm run dev` 打开浏览器预览。桌面集成测试位于 `tests/*-flow.cjs`、`tests/electron-smoke.cjs` 和 `tests/credentials-crossprocess.cjs`，使用本地测试数据与 SSH/SFTP 服务。

## 公开源码

`npm run verify:privacy` 检查源码中的内网地址、用户目录和常见凭据。可在被 Git 忽略的 `.privacy-patterns.local` 中添加个人设备名或项目名的 JSON 字符串数组，用于本机检查。提交前仍应查看差异，避免把个人数据写进测试或文档。

图标来源见 [assets/SOURCES.md](assets/SOURCES.md)。
