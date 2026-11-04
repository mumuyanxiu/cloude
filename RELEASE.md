# Windows 发布流程

Cloude 品牌更名版本为 **1.0.2**，应用更新源由 `package.json` 的 `build.publish` 指定。

## 本地构建

```powershell
npm ci
npm run verify:privacy
npm test
npm run package
```

产物位于 `release/<版本>/`，包含 `Cloude-Setup-<版本>.exe`、对应的 `.blockmap`、`latest.yml` 和 `SHA256SUMS.txt`。应用使用 electron-updater 读取 `latest.yml`，按元数据校验 SHA512，并使用块映射进行差分下载。差分不可用时下载完整安装包。PowerShell 脚本使用 SHA256 清单校验完整安装包。

安装包采用 NSIS 当前用户安装，允许选择目录。Cloude 1.0.2 沿用原有 `appId` 和安装记录，升级时沿用安装目录和既有配置目录 `%APPDATA%/Cloud Claude/`。用户数据不在安装目录，卸载也保留用户数据。当前打包配置未接入代码签名证书。

## GitHub Actions

1. 确认 `package.json` 和 `package-lock.json` 的版本一致。当前更名版本使用 `1.0.2`，后续发布递增版本号。
2. 完成源码审查和隐私检查，提交更改。
3. 推送同版本标签，例如 `v1.0.2`。
4. `Windows release` 工作流运行单元测试、桌面集成测试及打包验证。
5. 工作流先创建草稿并上传全部产物，成功后发布稳定 Release。

手动运行工作流只生成 Actions 附件，不发布 Release。发布只使用工作流内置 `GITHUB_TOKEN`，不在仓库保存访问令牌。

`latest.yml` 与对应安装包和 `.blockmap` 必须同时发布，避免更新元数据指向未上传的文件。不要覆盖已经发布版本的二进制；修复时增加版本号。安装版首次发布成功后，在线更新才有可下载的目标版本。

## 升级验收

在独立 Windows 用户或虚拟机中安装版本 A，保存一份测试连接与会话；发布更高版本 B 后，在 A 中检查、下载并重启安装，确认版本、安装目录、快捷方式与会话均正确。还需验证网络失败后重试、已有任务或未保存文件阻止安装，以及下载损坏时拒绝安装。

本地自动化覆盖更新状态、错误重试、安装前任务检查、UI 交互。跨两个真实 GitHub Release 的安装升级需在发布环境验收。
