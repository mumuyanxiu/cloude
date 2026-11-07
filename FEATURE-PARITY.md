# Cloude 2.0 功能验收

验收参考 Claude Code Desktop、Claude Desktop / Cowork 和 Codex Desktop 官方文档，基准日期为 2026-11-07。每项结果应对应实际版本、执行位置和测试记录。

## 交付范围

| 范围 | 2.0 实现来源 | 验收要求 |
| --- | --- | --- |
| Claude Code / Codex | Paseo 原生 provider | CLI 已安装并认证，模型、工具、审批、停止与续聊可用 |
| 项目与主机 | Paseo 客户端与 daemon | 项目路径、历史、任务与权限按主机区分 |
| 并行开发 | Paseo workspace / worktree | 两个隔离任务的文件与分支互不覆盖 |
| 编辑、终端与审阅 | Paseo 桌面客户端 | 编辑保存、终端交互、Git 差异与工作区导航可用 |
| 内嵌浏览器 | Paseo Electron browser host | 浏览器工具启用后可读取和操作工作区页面，宿主关闭时反馈失败 |
| 定时任务 | Paseo daemon scheduler | 创建、暂停、手动运行、运行记录和产物保留可管理 |
| 原有 SSH 与任务 | Cloude 兼容工作台 | 读取原配置，使用 DPAPI 凭据，恢复旧任务及待审批请求 |
| 应用更新 | Cloude GitHub Release | 固定更新源，校验完整安装包，保持原安装身份 |

`npm test` 和 `npm run test:desktop` 验证兼容工作台回归。`npm run test:paseo` 验证实际新入口及捆绑运行时。`npm run verify:release` 核对安装资产、版本、校验和及集成报告。认证账号上的真实模型任务与远端 Linux 主机验收需使用相应执行环境记录结果。

## 2.0 本地验证记录

- 82 项单元回归通过，覆盖真实回环 SSH/SFTP、凭据、权限、上传和模式切换取消。
- Linux 下 13 项后台任务集成和 14 项协议单元验证通过，包含进程实际退出后的测试目录清理。
- 新客户端实际启动、独立 daemon、原生 PTY 执行命令、关闭重启和旧数据保留通过。Electron renderer 的 Node 原生 API 与旧 workspace API 均不可用。
- 编辑器关闭保护的 4 项回归、普通退出及更新协调的 3 项源码回归通过。
- Codex 在隔离只读目录中完成真实模型请求，动态选择默认模型并返回预期结果。本机 Claude CLI 未认证，Claude 真实模型请求留待认证后的环境验收。
- 新旧工作台关闭与切换回归、打包后的真实运行时及 15044 项安装资产 SHA256 核验通过。NSIS 跨版本实际安装升级需在独立用户或虚拟机中验收。

## 持续验收边界

- 会话恢复、会话分支、文件回退和 Git 回退分别测试。Paseo 的 Codex provider 对会话回退和文件回退报告不同能力。
- 新 SSH 入口使用已运行的远端 Paseo daemon。密码认证及旧持久任务通过兼容工作台继续使用。
- 网络断开、桌面退出、daemon 重启和执行机器重启分别测试，记录进程存活、输出重放和待审批恢复情况。
- 定时任务需检查离线漏跑、运行重叠、时区、失败状态与 worktree 清理。
- Claude Skills、Codex Skills、MCP、agent 插件和 Paseo 插件按各自运行位置与协议验收。
- Claude/Codex 官方托管云任务、账号跨端同步、Cowork 办公产物平台、系统电脑操作和官方连接器属于后续独立集成范围。

## 官方基准

- [Claude Code Desktop](https://code.claude.com/docs/en/desktop)
- [Claude Cowork 跨端与执行位置](https://support.claude.com/en/articles/15520349-use-claude-cowork-on-web-desktop-and-mobile)
- [Codex worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)
- [Codex 远端连接](https://learn.chatgpt.com/docs/remote-connections)
- [Codex 定时任务](https://learn.chatgpt.com/docs/automations)
- [Codex app-server](https://learn.chatgpt.com/docs/app-server)
