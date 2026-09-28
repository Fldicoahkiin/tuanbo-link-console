# 团播联动台软件更新

2026-09-28：当前源码改为公司 HTTPS 更新源，DNS、源站 TLS 和静态更新路由已完成并验证；尚未发布新安装包。旧版本历史验收记录留在文末，不代表本次域名和保护配置已验收。

## 当前链路

- 更新源：`https://updates.tuanbo-link.jinhefilm.com/windows/x64/`，`electron-updater 6.8.9` 的 generic provider。
- 唯一配置来源：`apps/desktop/package.json` 的 `build.publish.url`；主进程直接引用相同配置，打包生成的 `app-update.yml` 应与其一致。
- 客户不填写 GitHub Token，不需要公司网站账号；旧更新 Token 的 IPC、schema 和输入 UI 已移除，客户端不再读取它。已有本地加密凭证不会被静默删除，也不会迁移到公司服务。
- 用户打开更新中心后检查→下载→确认重启安装；没有启动自动检查、自动下载、退出即安装、失败自动重试或自动降级。
- 固定完整 NSIS 包下载，保留 SHA-512 校验；差分下载关闭，blockmap 仍可随构建归档。新源协议仅允许 HTTPS、无用户名/密码、无 query/fragment，且必须为目录地址。
- 检查与下载互斥，已经下载的版本保留等待安装。运行中或工程未保存时拒绝安装；系统确认框返回后再次检查，防止确认期间状态变化。安装失败恢复关闭保护。
- 安装沿用原目录和当前用户范围，只退出团播联动台，不关闭 OBS/P1。开发模式不执行更新。
- 网络层采用锁定版本 `builder-util-runtime` 的 60 秒 socket 空闲超时。完整包传输可超过 60 秒，不是整次下载的总时限；慢链路需实测。授权请求另有独立的 10 秒时限。

当前 feed 是公开静态资源，下载本身不发授权，使用软件仍要求付费许可。`updatesUntil` 对新版使用资格尚未接入；服务器短效下载链接、版本资格目录和安装后资格验证都属于后续工作，不能说已实现按升级期收费。

## 同服务器静态出口

不需要 HTML 网页，Nginx 静态站点提供以下文件即可：

```text
/srv/tblink-updates/windows/x64/
  latest.yml
  Tuanbo-Link-Console-X.Y.Z-x64.exe
  Tuanbo-Link-Console-X.Y.Z-x64.exe.blockmap
```

`latest.yml` 由 electron-builder 生成，包含版本、安装包相对文件名、大小和 SHA-512。不要手填摘要，不要把内部绝对路径写进去。正式稳定版本用数字 `X.Y.Z`；当前反向代理白名单不服务 prerelease、其他架构或任意文件。

清单 `Cache-Control: no-store`；带版本的安装包不可变、长期缓存。不开目录浏览，未匹配路径 404。服务器、CF 记录和探测命令见 [COMMERCIAL_DEPLOYMENT.md](COMMERCIAL_DEPLOYMENT.md)。

Git、版本标识、构建位置与服务部署关系见 [完整链路核查](RELEASE_CHAIN.md)。

## 发布流程与上线门槛

2026-09-29 用户明确授权“创建正式发行、开放收款，后续会真实找人测试”。本次 `0.4.29` 按此授权先创建正式 Release 并部署已通过构建和摘要检查的产物，真实安装／激活／更新验收后补；这取代下文“签名和实机验收前不公开”的本次流程限制。现阶段没有代码签名证书，manifest 必须继续如实记录 `NotSigned`，发行说明明确未签名及实测待完成，不关闭摘要校验、不伪造签名状态。未来签名接入仍按下述要求实施。仅有发布授权或构建排队不代表本次发行已经完成，实际结果以部署记录为准。

1. 在 Windows 原生环境完成仓库 `pnpm verify:release` 及设备回归。同步根包和桌面包版本，使用递增且未发布过的版本号。当前工作没有改版本号、打标签或发布。
2. **当前脚本仍检查 `unsigned-candidate-confirmed`，`win.signAndEditExecutable` 为 false，不能把该检查通过视为正式商用签名通过。** 取得代码签名证书后，需接入构建签名、真实证书的发布者校验，并调整 manifest 的正式发行检查。必须同时验收应用 EXE 和 NSIS 安装器。未完成前不把候选文件放到公开正式 feed。
3. 检查成品的 `app-update.yml` 与公司地址一致；确认目标安装器版本、大小、SHA-512 和 Authenticode 发布者。当前依赖在没有配置 `publisherName` 时会跳过 Windows 更新签名验证，因此仅改 HTTPS 地址尚未完成可信更新链路。不能猜公司中文名就是证书发布者。
4. 在隔离测试源用两套版本验收更新、损坏下载拒绝、错误发布者拒绝、网络中断、运行/未保存拒绝、取消安装、原目录与卸载信息保持。测试主进程与 preload 必须完整重启，不能仅刷新 renderer。
5. 经发布授权后，把签名且验收通过的版本化安装包和 blockmap 上传到服务器临时目录，校验完成后移入同一文件系统下的公开目录。保留旧版本文件。
6. 将对应清单上传为临时文件，再以同目录原子 rename 最后替换 `latest.yml`。不要先上传清单，否则客户会读到尚不存在或尚未传完的包。清单路径和版本文件内容发布后不可分别随意修改。
7. 由公网客户路径检查清单缓存头、文件大小、Range 和摘要，再用 Windows 客户端完成全链路；保存脱敏验收记录。失败时停止发布下一版，不能自动切到未知镜像。

现有 `.github/workflows/release-windows.yml` 在 `v*` 标签推送后构建并上传 GitHub 草稿 Release 资产；新增手动入口要求指定完整提交，只保留候选 artifact，尚未推送运行。两条路径都**不会同步腾讯云出口**。`build.publish` 改为 generic 不会让 `softprops/action-gh-release` 自动上传服务器。待签名、SSH 发布身份与服务器目录验收完成后，再增加受控 CI 发布阶段，按“产物先、清单后”自动同步；生产密钥通过 CI 秘密存储提供，不在 YAML 写口令。本轮未 push，因此没有触发该流水线。

官方参考：[electron-builder 自动更新](https://www.electron.build/v26/docs/features/auto-update/)、[发布配置](https://www.electron.build/v26/docs/publish/)、[Windows 代码签名](https://www.electron.build/docs/features/code-signing/code-signing-win/)。实现行为以本仓库锁定的 electron-updater 6.8.9 / electron-builder 26.15.3 为准，不把更新版文档中新增的清单签名能力当作当前依赖已有能力。

## 旧安装迁移与故障

已安装的旧客户端仍指向历史 GitHub 源，修改本仓库不会远程改变它们。首次迁移默认手动安装一个已签名、经过验证且包含新地址的版本；若以后选择通过旧 feed 发桥接版本，须另行确认旧仓库发布权限与验收，不在本轮执行。旧 0.2.0/0.2.1 的历史下载缺陷仍需要手动跨过。

- “尚未发布可用的正式版本”：检查 `latest.yml` 是否已按白名单路径上线，不能用 HTML 占位页返回 200。
- TLS 失败：核查多级子域名证书、DNS、CAA、云防火墙以及灰云/橙云方式。
- 摘要不匹配：停止交付，检查文件被覆盖、上传不完整、代理缓存或被篡改；不关闭校验来恢复下载。
- 下载慢：检查服务器 4Mbps 共享带宽、剩余流量和并发，不能承诺国内一定秒下。
- 客户端仍访问 GitHub：核对实际安装版本和包内配置，按迁移流程处理。

## 本轮验证

本轮 macOS 本地 `pnpm typecheck`、`pnpm lint`、Electron main/preload/renderer 构建通过；更新与授权专项 4 个文件共 28 项通过；Chromium 真实组件配测试桥 4 项通过，截图已检查。新增浏览器测试另通过 e2e TypeScript 检查。后续已完成反向代理和公网 HTTPS 探测及证书续期演练，见部署文档。Windows NSIS 安装、签名和原目录更新尚未验收，不能用组件 mock 替代真实签名下载。

## 旧版本历史记录（保留原记录，非当前状态）

以下内容来自以前的 Windows 与 GitHub 发布记录，本轮未重新验证其远端链接、签名或实机结果；其中“本机”“本轮”“Latest”“未提交”等均指当时，不是当前交付。

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
