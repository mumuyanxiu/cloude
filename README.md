# Cloude

通过 SSH 连接 Claude Code 的 Windows 桌面工作台，支持项目与历史会话、流式聊天、代码编辑、Git 差异、终端、文件上传下载及账户用量。

## 安装与更新

推荐在 [Releases](https://github.com/mumuyanxiu/cloude/releases/latest) 下载 `Cloude-Setup-<版本>.exe`。安装程序支持选择目录，默认按当前用户安装。后续升级沿用原安装目录和桌面快捷方式。

安装版启动后检查更新；在左侧“应用更新”中下载新版本，下载完成后点击“重启并安装”，后台安装后自动重新打开应用。有未保存文件、运行任务或文件操作时，完成处理后再安装。网络中断可重试，下载校验通过后才能安装。

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
- 历史会话：在项目中点击“读取历史对话”，查看并继续原有会话。
- 终端：支持命令补全、交互输入和停止任务。
- 权限：在输入框旁选择编辑或只读模式，并设置是否允许自主运行命令。

## 数据位置

Cloude 的应用数据沿用既有配置目录 `%APPDATA%/Cloud Claude/`，开发版位于项目下 `.runtime/`。连接配置与会话保存在 `workspace.json`，主机指纹保存在 `known-hosts.json`，登录凭据使用当前 Windows 用户的 DPAPI 加密保存在 `credentials.json`。用户数据、密钥和测试输出均不纳入源码和安装包。

## 开发与验证

使用 Node.js 24：

```powershell
npm ci
npm run verify:privacy
npm test
npm run test:desktop
npm run build
npm start
npm run package
```

`npm run dev` 打开浏览器预览。桌面集成测试位于 `tests/*-flow.cjs`、`tests/electron-smoke.cjs` 和 `tests/credentials-crossprocess.cjs`，使用本地测试数据与 SSH/SFTP 服务。

## 公开源码

`npm run verify:privacy` 检查源码中的内网地址、用户目录和常见凭据。可在被 Git 忽略的 `.privacy-patterns.local` 中添加个人设备名或项目名的 JSON 字符串数组，用于本机检查。提交前仍应查看差异，避免把个人数据写进测试或文档。

图标来源见 [assets/SOURCES.md](assets/SOURCES.md)。
