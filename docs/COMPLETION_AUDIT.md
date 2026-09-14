# 团播联动台完成审计

最新实现与现场证据：[2026-09-08 P1 自动跟随](P1_AUTO_FOLLOW.md)；此前复审：[2026-09-05 交付审查](DELIVERY_AUDIT_20260905.md)。下列版本记录保留为历史证据，不能替代本次候选包或现场验收。

本文把计划要求分为三种状态，避免把自动测试、模拟适配器或当前账户验证误报为真实现场完成。

- **已实现**：代码与自动验证已经覆盖，证据可在仓库内复查。
- **本机已验证**：在当前 Windows 机器使用真实程序或真实安装产物验证过。
- **待现场签收**：必须由操作员提供凭证、设备、登录状态或独立 Windows 环境后才能完成。

## 产品边界与架构

| 要求 | 状态 | 证据 |
|---|---|---|
| OBS 与 P1 构成唯一联动链；直播伴侣只在软件之外采集 OBS，联动台不检测、不启动、不关闭也不预检直播伴侣 | 已实现 | `README.md`、`docs/DESIGN_BASELINE.md`；进程契约与设置仅保留 OBS/P1 |
| `.tblink` schema v1，不迁移旧 ShowPackage；机器私有设置与工程分离 | 已实现 | `packages/schema/src/link-project.ts`、`packages/schema/src/integration-profile.ts` |
| 工程修改全部经 Command，支持 undo/redo；工程帧率与默认竖屏/可切横屏输出画布可在正式 UI 配置 | 已实现 | `packages/core/src/link-command.ts`、`apps/desktop/src/renderer/src/link/stores/document-store.ts`；全部 Command 的 execute/undo 测试与画布/帧率 E2E |
| Domain → Adapters → Stores/Runtime → Components → IPC 单向分层 | 已实现 | ESLint boundaries 规则与 `pnpm lint` |
| IPC 输入在主进程边界校验 | 已实现 | `packages/schema/src/link-ipc.ts`、`apps/desktop/src/main/link-main.ts` |

## 工程、时间码与动作执行

| 要求 | 状态 | 证据 |
|---|---|---|
| 原子保存、覆盖保存失败保留原文件、参考音频 SHA-256 去重、波形可重建 | 已实现 | `apps/desktop/src/main/link/atomic-file.ts`、`link-project-service.ts` 及测试 |
| 24、25、29.97 drop-frame、30 fps 完整 quarter-frame 解码；波形播放头使用 30000/1001 精确换算 | 已实现 | `packages/core/src/mtc-timecode.ts`；四帧率、反向序列、非法 drop-frame 和十分钟播放头测试 |
| Cue 使用跨越判定；选择节目时旧 Cue 标记错过；倒退、跳变、归零不自动重放 | 已实现 | `packages/core/src/cue-runtime.ts` 及状态机测试 |
| 500ms 丢失、250ms 非预期跳变冻结自动 Cue；布防后首帧前丢失同样冻结；恢复必须人工选择 | 已实现 | `cue-runtime.ts`、`link-runtime-coordinator.ts`；丢失、首帧前中断与恢复测试 |
| 排练首错阻断，直播失败继续；失败动作单独重试且生成新 executionId | 已实现 | `packages/core/src/cue-action-runner.ts` 及测试，现场运行台失败列表 |
| OBS 允许动作完整，默认请求超时 2 秒，不控制推流/录像 | 已实现 | `obs-websocket-adapter.ts` 及鉴权、断线、库存和动作超时测试 |
| MIDI Note、CC、Program、MSC GO/STOP/RESUME/LOAD；MSC 显式 Device ID 与 Command Format；端口消失立即失败且不切换端口 | 已实现 | `link-midi-adapter.ts` 及 MSC 编码、非法命令和端口消失测试 |

## 集成、预检、日志与界面

| 要求 | 状态 | 证据 |
|---|---|---|
| OBS 密码只用 Electron safeStorage；不可用或不可解密时阻断 | 已实现 | `secure-profile-store.ts` 及测试 |
| 精确 exe、PID、启动时间和所有权跟踪；Chromium 同路径多进程只选择唯一主窗口；只正常关闭本次启动项，不强杀 | 已实现 | `external-process-manager.ts` 及所有权、同路径多进程、歧义和超时测试；退出时逐项确认 |
| 集成中心按 OBS → P1 启动或连接；预检通过后确认 OBS Program 已切到“团播联动台输出”并自动从头待命，正式音乐仅由 P1 播放 | 已实现 | `IntegrationWorkspace.tsx`、`obs-websocket-adapter.ts`、`link-runtime-coordinator.ts` |
| 预检覆盖资源、当前节目、Cue/动作、OBS 鉴权、工程/OBS 画布一致性、P1 正式音频输入、其他 OBS 目标、MIDI/MTC、OBS/P1 版本、磁盘、凭证与脱敏 | 已实现 | `packages/core/src/link-preflight.ts` 及测试 |
| 结构化运行日志、设备状态、状态迁移、动作结果和脱敏诊断包 | 已实现 | `run-logger.ts`、`link-runtime-coordinator.ts`、`LinkApp.tsx` 及测试 |
| 工程、Cue、集成、日志四个工作区；当前节目由操作员手动选择；集成中心统一完成启动、预检、待命和停止，运行期间锁定高风险编辑入口 | 已实现 | `apps/desktop/src/renderer/src/link`；Electron Playwright smoke |
| 软件更新窗口使用原生顶层模态、覆盖完整视口且隔离底层工作区 | 已实现 | `UpdateCenter.tsx`、`link.css`；1180×640 Electron E2E 验证原生对话框已打开、覆盖全视口且顶部/中部/底部均未被裁切 |

## Windows 构建与本机证据

| 要求 | 状态 | 证据 |
|---|---|---|
| Node 25.8.2、pnpm 10.33.0、Electron 39.8.10 精确基线 | 本机已验证 | Electron 37 已结束上游支持；39.8.10 经类型、163 项单测、12 项 Electron E2E、构建与生产依赖审计验证，版本写入 lockfile 与 release manifest |
| install/typecheck/test/lint/build/verify/dev | 本机已验证 | 本轮最终验证记录和 `docs/WINDOWS_ACCEPTANCE.md` |
| x64 NSIS、unpacked、Windows release manifest、SHA-256、未签名状态 | 本机已验证 | `apps/desktop/dist` 与 `pnpm verify:release` |
| Windows 可执行文件产品名、版本与图标写入稳定，资源编辑失败会中止打包 | 本机已验证 | `apps/desktop/scripts/edit-windows-executable.mjs`；连续两轮打包与最终 release manifest |
| 当前账户安装、同版本覆盖、启动、正常退出、卸载、无残留进程 | 本机已验证 | `pnpm verify:installer`、`scripts/verify-windows-installer.ps1`、`docs/WINDOWS_ACCEPTANCE.md` |
| 私有 GitHub Release 检查、完整下载、重启安装且保持目录与安装范围 | 本机已验证 | 0.2.5 → 0.2.6 真实安装版更新；112,138,872 字节完整下载，更新后原目录、HKCU `/currentuser`、主窗口与正常卸载均通过 |
| 0.2.7 软件更新弹窗在工程节目单上方完整显示 | 本机已验证 | 原生顶层模态；已加载工程 Electron E2E 与实际 `win-unpacked` 视觉验收均通过，GitHub Release Windows #8 成功 |
| Windows Web MIDI 输入显式打开并接收 30fps MTC | 本机已验证 | loopMIDI 系统回环 240/240；隔离 Electron 联动台运行回环接收 960 条并显示 `00:00:01:28`、`MTC 30 running` |
| 外部程序中文进程/窗口标题保持 UTF-8 | 本机已验证 | PowerShell 进程探测使用 `EncodedCommand` 与显式 UTF-8 输出；隔离 Electron 实测“直播伴侣”无乱码 |
| 0.2.8 正式 GitHub Release | 本机已验证 | [Release Windows #9](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33098554787) 全步骤成功；[v0.2.8](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.8) 为 Latest，标签提交 `06b09fc5f62f8d7d3ab07db48d90130a7009987c`，6 个资产齐全；正式安装包 SHA-256 `1e55e2e0fe8349d3b5398c8bbf3635c2c5f26acdd4917962223b19864fbc159c` |
| 正式安装版 0.2.7 → 0.2.8 软件内更新 | 本机已验证 | 官方 0.2.7 安装包经更新中心发现、下载 0.2.8 并执行“退出并安装”；自定义目录、HKCU `/currentuser`、唯一主窗口与外部 OBS/P1/直播伴侣进程均保持不变，随后正常卸载且目录、进程、注册表残留为 0 |
| 0.2.9 一键连接、MTC 状态与更新窗口修复 | 本机已验证 | 一键连接使用本次实时枚举且不静默清空端口；MIDI 初始化并发幂等；无持续 MTC 时预检与演出控制均显示无信号；更新窗口使用文档根节点固定顶层遮罩；[Release Windows #10](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33102009894) 全步骤成功，[v0.2.9](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.9) 为 Latest |
| 正式安装版 0.2.8 → 0.2.9 软件内更新 | 本机已验证 | 官方 0.2.8 安装包经更新中心完整下载 112,142,314 字节的 0.2.9 并执行退出安装；原目录、当前用户安装范围、重新启动与外部 OBS/P1/直播伴侣进程均保持正确，随后正常卸载且目录、进程、注册表残留为 0 |
| 0.2.10 更新安全与错误可见性 | 本机已验证 | 更新弹窗打开时底层工作区 `inert` 且关闭按钮获得焦点；检查/下载未知错误中的 Token 被替换为 `[REDACTED]`；素材缩略图解码失败明确标红并显示根因；[Release Windows #11](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33104369530) 全步骤成功，[v0.2.10](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.10) 安装包为 112,118,320 字节，SHA-256 `92e4f8ad5bb176eccbaa94032004b3fe2f48a63c41b0af655d8bb05861680e7f` |
| 0.2.11 数据保护与异常路径 | 本机已验证 | 新建工程不再覆盖未保存修改；布局及工程恢复存储失败明确告警；协调器彻底释放 MIDI 监听并上报端口关闭失败；媒体代理失败清理临时文件；取消更新安装恢复按钮；最小窗口五个工作区边界检查通过；[Release Windows #12](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33106205421) 全步骤成功，[v0.2.11](https://github.com/JinHe9527/tuanbo-yijianchufa/releases/tag/v0.2.11) 为 Latest，正式安装包 SHA-256 `6d41a254d3df1598e6ad86f0eb538382eda30cde84f084d12b98b63aa6e1e093` |
| 安装版 0.2.10 → 正式 0.2.11 软件内更新 | 本机已验证 | 独立目录中的本地同版本 0.2.10 安装构建发现并完整下载正式 0.2.11（112,120,449 字节），原目录升级、自动重启、最新版复查、顶层模态、外部程序保护及卸载零残留全部通过 |
| 0.2.12 演出控制初始化与 MTC 订阅复用 | 本机已验证 | 工程恢复后等待运行协调器与桌面集成初始化完成再开放演出控制；首次预检不再静默无响应或短暂误报；独立 Electron 发送端通过 loopMIDI 连续发送 12 秒、30fps、2880 条 quarter-frame，重复预检时 MTC 更新、稳定性和帧率三项均通过 |
| 0.2.13 P1 端口等待与 MTC 订阅有效性 | 本机自动验证 | 集成档案必须精确匹配唯一连接的输入端口；P1 启动后先等待端口出现再订阅；端口改名、断开或重建不会复用旧订阅；重新布防会清除上一轮帧率与 MTC 到达时间 |
| 0.2.13 正式 Release 与软件内更新 | 本机已验证 | [Release Windows #14](https://github.com/JinHe9527/tuanbo-yijianchufa/actions/runs/33112754200) 成功；0.2.12 完整下载 118,283,132 字节后原目录升级并自动重启；1920×1030 更新模态完整居中且底层 inert；卸载后目录、进程、注册表残留为 0 |
| 0.2.14 本地开发候选回归 | 本机自动验证 | 2026-08-31 本地开发树通过 37 个测试文件、237 项单元测试、类型检查、ESLint、生产构建、桌面产物边界检查、14/14 Electron E2E 及当前生产依赖高危漏洞审计；覆盖运行防误关、跨工程异步写入隔离、跨盘素材路径、混合图片/视频 OBS 来源、失败后保守清理、500ms MTC 稳定窗口、手动接管错过结算和外部程序重复启动保护。按操作员要求未生成新安装包、未提交、未打标签、未推送、未发布 |
| 独立标准 Windows 账户安装、0.2.5 → 0.2.6 升级覆盖和卸载 | 本机已验证 | 临时标准账户离线 HKCU 卸载项、版本和路径检查；验收后账户、用户配置、安装目录与进程残留均为 0 |
| 干净 Windows 交互桌面启动 | 待现场签收 | 临时账户未建立交互式桌面会话，不能把非交互凭证进程伪报为 GUI 启动通过 |
| 生产依赖高危漏洞审计 | 本机已验证 | Electron 升至 39.8.10 后，`pnpm audit --prod --audit-level high` 无已知漏洞；锁定 `ws 8.21.0`、`js-yaml 4.3.1` |

## 真实联调门槛

以下项目不是代码回避项，也不得用模拟结果替代：

| 项目 | 当前事实 | 完成条件 |
|---|---|---|
| OBS | 32.2.2 正在运行；正式打包产物使用现有加密配置认证 obs-websocket 5.7.4 成功，并读取 3 个场景、3 个输入、2 个转场；尚无操作员签收的全部动作证据 | 操作员完成全部 OBS 动作、断线与失败策略验收 |
| P1 | 1.14.2 已进入 Audio 模式、打开 `11111.hia` 并实际播放；发送 MTC 已勾选为 30Hz，但 P1 显示“未发送”。loopMIDI 和 Windows MIDI Services 原生 A/B 软件环回分别监听均为 0 条 quarter-frame，软件链路已排除 | 接入 P1 官方操作说明所示的物理 USB-MIDI 设备，以 MIDI OUT→IN 建立链路；播放后确认 P1 显示“已发送”，再签收归零、帧率、丢失和恢复；只有使用反向控制时才需确认控制输出与消息约定 |
| 直播伴侣 | 12.8.1 主程序已定位；实机探测到同路径 11 个 Chromium 进程和唯一“直播伴侣”主窗口 | 操作员确认登录状态；持续采集 OBS 输出时完成只读监测验收 |
| 现场工程 | 尚无已签收的参考音频和五 Cue 节目 | 按 `WINDOWS_ACCEPTANCE.md` 场景 1–11 逐项记录结果和证据 |

只有本节和干净账户交互桌面验收全部通过后，目标才可标记完成；等待操作员补齐外部条件期间不得误标为完成。
