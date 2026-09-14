# 团播联动台软件更新

## 更新链路

正式 Windows 安装版从 GitHub 私有仓库 `JinHe9527/tuanbo-yijianchufa` 的正式 Release 检查更新：

1. 开发电脑完成修复并通过全部校验。
2. 同步修改根目录和 `apps/desktop/package.json` 的版本号。
3. 提交并推送代码，再推送与版本严格一致的标签，例如 `v0.2.2`。
4. GitHub Actions 在 Windows 上执行冻结安装、测试、构建和发布校验。
5. Actions 创建 GitHub Release，并上传 NSIS 安装包、blockmap、`latest.yml` 与 `release-manifest.json`。
6. 测试电脑打开联动台右上角“软件更新”，检查、下载并重启安装。

标签与 `apps/desktop/package.json` 版本不一致时，发布任务会立即失败，不会生成错误版本。

## 测试电脑首次配置

因为仓库是私有仓库，每台测试电脑首次使用更新功能时需要录入一个 GitHub fine-grained personal access token：

- Repository access 只选择 `JinHe9527/tuanbo-yijianchufa`。
- Repository permissions 只授予 `Contents: Read-only`；Metadata 保持 GitHub 默认只读。
- 不授予写入、Actions 管理、仓库管理等权限。

在软件右上角打开“软件更新”，输入 Token 并保存。Token 使用 Electron `safeStorage` 交给 Windows 加密存储，不写入 `.tblink` 工程、仓库、发布清单或运行日志；界面不会回显已保存的 Token。Windows 安全存储不可用时保存失败，不回退到明文。

私有 GitHub Release 更新固定下载并校验完整 NSIS 安装包，不启用差分下载。GitHub 私有资产使用数字 API 地址，`electron-updater 6.8.9` 的通用 blockmap 地址推导无法定位单独上传的 blockmap 资产；显式关闭差分更新可以避免下载永久停在 0%。blockmap 仍随 Release 保留，供产物完整性检查使用。

`0.2.0` 与 `0.2.1` 已包含上述差分下载缺陷，无法通过软件内更新跨过该版本。测试电脑必须手工安装一次 `0.2.2` 或更高版本；从该版本开始才能使用软件内更新。不得移动或覆盖既有标签来隐藏这一事实。

`0.2.5` 及更早的安装器允许在当前用户与所有用户之间选择，管理员会话执行自动更新时可能把安装范围迁移到 `C:\Program Files`。`0.2.6` 起安装器固定为当前用户模式，自动更新显式沿用当前可执行文件目录；普通安装和更新均不得静默改变安装范围或安装位置。

本机已使用正式私有 Release 完成 0.2.5 → 0.2.6 的检查、112,138,872 字节完整下载、退出安装与自动重启；更新后自定义安装目录和 HKCU `/currentuser` 安装范围均保持不变。

`0.2.7` 将软件更新窗口改为 Chromium 原生顶层模态，修复已加载工程节目单时更新窗口下半部分被工作区覆盖的问题。该版本已通过已加载工程的 Electron E2E、实际 Windows 打包产物视觉检查和 GitHub Windows 发布流水线；测试电脑可从 `0.2.6` 的更新中心直接检查并安装。

`0.2.8` 修复 Windows Web MIDI 输入只枚举但未显式打开的问题。进入预检或监听 P1 后，联动台会等待目标输入端口打开成功再订阅 MTC；取消订阅时关闭同一端口。同时修复 PowerShell 进程探测输出中文窗口标题时的编码乱码。该版本已通过 loopMIDI 系统回环、隔离 Electron 联动台运行回环和 [Release Windows #9](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33098554787)；[v0.2.8](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.8) 已发布为 Latest，测试电脑可从 `0.2.7` 的更新中心直接检查并安装。

`0.2.9` 修复集成中心首次进入时“一键识别并连接”读取旧 MIDI 枚举结果、错误清空已保存端口的问题；MIDI 初始化改为并发幂等，P1 直播放模式不再把可选控制输出误报为阻断。预检与演出控制统一按 500ms 有效窗口显示 MTC，未收到持续时间码时不再误报“稳定”或长期显示 `running`。软件更新窗口改为挂载到文档根节点的固定顶层遮罩，解决项目节目单覆盖更新窗口下半部的问题；遮罩覆盖整个视口，窗口保持 520px 最大宽度，并支持关闭按钮、外部点击和 Esc 关闭。[Release Windows #10](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33102009894) 已全步骤成功，[v0.2.9](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.9) 已发布为 Latest。

`0.2.10` 进一步把软件更新窗口收紧为真正的页面模态：窗口打开期间底层工作区不可点击、不可获得键盘焦点，关闭按钮自动聚焦，Esc 关闭后恢复交互。检查和下载更新产生的未知错误在进入界面前会移除当前 GitHub Token；素材缩略图生成失败也不再静默退化为通用占位，而是明确显示失败状态和根因。[Release Windows #11](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33104369530) 已全步骤成功，[v0.2.10](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.10) 已发布。

`0.2.11` 补齐软件更新取消路径：在系统确认框取消退出安装后，更新按钮会恢复可操作。同时加强未保存工程保护、工程和工作区布局恢复错误、MIDI 监听释放、媒体代理失败清理与最小窗口逐页边界检查。[Release Windows #12](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33106205421) 已全步骤成功，[v0.2.11](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.11) 已发布为 Latest。本机安装版回归已完成从本地同版本 0.2.10 构建到正式 0.2.11 的原目录升级、自动重启、最新版复查和零残留卸载。

`0.2.12` 修复工程恢复后演出控制早于桌面集成初始化完成、第一次点击预检可能无响应或误报的问题；演出控制会等待工程协调器和设备状态完成初始化。重复预检会复用相同端口与帧率的 MTC 订阅，不再人为断开正在输入的时间码。软件更新窗口改用 Chromium 原生 `dialog` 顶层模态并显式占满视口，修复特定窗口状态下遮罩只剩顶部一条、弹窗主体被工作区裁掉的问题。[Release Windows #13](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33109764252) 已全步骤成功，[v0.2.12](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.12) 已发布为 Latest。本机已完成 0.2.11 → 正式 0.2.12 的软件内更新与原目录自动重启验收。

`0.2.13` 收紧 P1 MTC 端口与启动链路：只有集成档案中精确配置、唯一且已连接的输入端口才显示就绪；端口断开、重新创建或同一档案改名后不会复用旧订阅。从集成中心顺序启动或在演出控制中人工重启 P1 时，联动台会先轮询等待目标端口出现，再建立 MTC 订阅，避免 P1 启动较慢时提前失败。“从头重新布防”会同时清除上一轮帧率和到达时间，防止短时间显示旧的绿色 MTC 状态。软件更新顶层模态增加跨全部工作区反复打开的渲染错误回归测试。Electron 从已结束支持的 37.3.1 精确升级至 39.8.10，正式运行依赖审计无已知漏洞。[Release Windows #14](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33112754200) 已全步骤成功，[v0.2.13](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.13) 已发布为 Latest；本机已完成 0.2.12 → 正式 0.2.13 的软件内更新、1920×1030 更新弹窗和零残留卸载验收。

`0.2.14` 本地候选版补齐参考音频提取、时间线素材时长与分层拖放/修剪、工作区交互及受管 OBS 输出清理，并把 P1 MTC 的“Windows 输入端口已就绪”和“P1 实际正在发送”明确分开。后续本地开发又补齐跨工程异步保存/导入隔离、跨盘素材路径防护、预检结果提交门槛、混合图片/视频的独立 OBS 输入、失败或超时后的保守活动来源跟踪、500ms 连续稳定判定、手动接管错过结算、外部程序所有权与重复启动保护。2026-08-31 已通过 37 个测试文件、237 项单元测试和 14/14 Electron E2E。实机确认 P1 1.14.2 播放时对 loopMIDI 与 Windows MIDI Services 软件环回均显示“未发送”且无 quarter-frame；界面和预检不再暗示仅选择虚拟端口即可完成现场签收。该版本仍是未提交、未发布的本地候选版；本轮按操作员要求不生成新安装包、不执行安装生命周期、不提交、不打标签、不推送、不发布，不能描述为正式 Release。

## 发布修复版本

以下命令只应在所有校验通过后执行，且不得强推：

```powershell
git add --all
git commit -m "fix: 修复现场问题"
git push origin codex/tuanbo-link-console
git tag v0.2.2
git push origin v0.2.2
```

每次发布必须使用新的、递增的语义化版本。已经推送的标签不移动、不复用。

## 测试电脑操作

1. 保存当前工程。
2. 打开“软件更新”，点击“检查更新”。
3. 发现新版本后点击“下载更新”。
4. 下载完成后点击“重启并安装”。
5. 在系统确认框再次确认。

安装更新只退出团播联动台，OBS 与 P1 保持运行；直播伴侣不在联动台的进程管理范围内。当前工程未保存时，主进程会阻止安装。
更新完成后程序必须仍位于更新前的安装目录，卸载项必须保持当前用户范围；若路径或范围发生变化，应停止现场使用并保留诊断证据。

当前候选包未签名，Windows SmartScreen 可能提示未知发布者；在取得代码签名证书前不得把它描述为已签名版本。

## 失败定位

- `Token 无效或没有权限`：重新创建仅限目标仓库、Contents 只读的 Token。
- `尚未找到正式 Release`：检查标签对应的 GitHub Actions 是否完成，以及 Release 是否包含 `latest.yml`、安装包和 blockmap。
- 下载失败：保留界面错误和 GitHub Actions 日志，不删除 lockfile、不升级依赖绕过。
- 安装被阻止：先保存当前 `.tblink` 工程，再重新安装。
