# 2026-09-05 交付审查

> 现场复测补充：原候选安装包存在将 MIDI 端口可用误报为 MTC 已连接的问题，不应作为正式联动交付包。修正后的本地运行目录为 `apps/desktop/dist-mtc-20260905/win-unpacked`。P1 输出枚举的新发现及纯软件兼容验证见 [P1 MIDI 兼容记录](./P1_MIDI_COMPATIBILITY.md)。原安装包与下面的摘要仅保留为历史构建记录。

## P1 纯软件连接修复后的结果

P1 1.14.2 输出枚举的 76 字节查询与 Windows MIDI Services 不兼容。通过仅在 P1 目录安装枚举兼容模块，虚拟输出列表恢复；P1 自身连续 12 秒发出并被接收 1440 条 MTC。当前真实工程“节目 1”进入 running，视频及两个来源的时间线显示、变换、隐藏和播毕停止均得到 OBS succeeded 回执。P1 停止发码后断流保护生效，人工停止后恢复 idle。无需增加硬件或更换 P1。

新构建通过 248 项单测、15 项 Electron E2E、类型检查、Lint 和构建。新安装包位于 `apps/desktop/dist-delivery-20260905/Tuanbo-Link-Console-0.2.14-x64.exe`，SHA-256 为 `81C67F515F9FD9F4BF706CF464C0B9F61282E19942FC8FA94A93F30FC0824EC2`。兼容模块单独附带，本机已安装；其他 P1/Windows 版本需要重新验证。

本轮新增证据解决了此前 P1 无实际时间码、OBS 无动作的阻断；尚不代表操作员已确认画面效果、所有工程已验收或长时间运行无异常。

## 结论

当前 0.2.14 本地候选包已通过代码回归、桌面操作、打包程序素材处理，以及当前账户安装／覆盖／启动／正常退出／卸载验证。可以交付用于安装和现场验收。**不能据此宣称真实 P1 → MTC → OBS／灯光全链路已经签收，也不能保证所有未知输入下没有 bug。**

源码位置：`C:\dev\tuanbo-yijianchufa`。任务目录 `C:\Users\WYZB\Documents\ChatGPT\团播切片` 原有内容为 90 张截图，不含应用源码。审查时源码已有大量未提交改动，本轮在其基础上修复，没有 commit、push、打标签或发布 GitHub Release。

## 本轮确认并修复的问题

| 严重性 | 问题与实际影响 | 修复与证据 |
|---|---|---|
| P1 | 导入素材使用整文件 readFile 计算摘要，大视频可能超出读取限制或占用大量主进程内存 | 改为分块流式 SHA-256；多块素材导入、摘要和文件内容回归通过。没有将 3MB 测试冒充多 GB 实测 |
| P1 | 手动保存与自动保存可能并发原子替换同一文件，旧快照存在最后覆盖新快照的风险 | 主进程按规范化目标路径串行保存；保存失败仍原样反馈，后续显式保存不被阻断；并发与失败恢复测试通过 |
| P1 | 保存任一快照后主进程无条件清除 dirty，期间的新修改可能失去退出保护 | dirty 由带修订检查的 renderer 状态同步；新增 Electron 用例修复前确实失败并导致窗口退出，修复后保留未保存提示 |
| P1 | 提示操作员去 P1 播放，却在首帧前 500ms 内自动进入信号丢失 | 外部播放待命明确等待首帧；测试等待 30 秒仍待命，开始播放后 500ms 断流保护仍生效，曲目中途首帧仍拒绝 |
| P1 | 从已有 MTC 布防后若完全不再来帧，armed 状态漏掉断流检测 | 补充 armed 且已有样本的超时检测；1501ms 对 1000ms 样本回归通过 |
| P1 | 暂停、时间码丢失、错误或停止后，异步队列及同一 Cue 内后续动作仍可能发送 | 运行批次失效标记与发送前检查；真实协调器接入模拟 MIDI 后停止，确认在途动作收尾、排队动作 skipped、最终 idle；停止清理和显式重试仍可执行 |
| P2 | 打包未明确限定文件范围，开发与测试文件可能进入交付包 | 限定 out、图标、package.json 和构建器收集的生产依赖；检查 app.asar 不含 src、scripts、test-e2e、test-results |
| P2 | 隐藏运行时安装验收脚本依赖 Get-Process.MainWindowTitle，误报启动失败 | 改为隔离用户数据目录的 Electron renderer 启动检查；重跑全部安装生命周期通过 |

已发送给外部软件的请求无法撤回；本轮修复取消尚未发送的排队动作，停止流程仍等待在途动作结束并清理受管输出。

## 本轮验证

| 验证 | 结果 | 原始证据（仓库 output 目录） |
|---|---|---|
| 类型、单测、ESLint、生产构建、桌面边界检查 | 38 个测试文件、246 项单测全部通过 | audit-20260905-verify-final.log |
| Electron 桌面操作 | 15/15，通过工程新建、保存、恢复、时间线、最小窗口、更新弹窗、异常提示及关闭保护 | audit-20260905-e2e-final.log |
| 生产依赖审计 | 61 项依赖，已知漏洞 0 | audit-20260905-dependencies.json |
| 安装产物媒体处理 | 真实打包程序启动；内置 FFmpeg 生成／探测 MP4、视频代理、提取音轨、中文路径、HTTP Range 206、工程保存重开均通过，无 renderer 异常 | audit-20260905-packaged/result.json、packaged-window.png |
| 安装生命周期 | 当前用户首次安装、同版本覆盖、窗口就绪、正常关闭、产品卸载器卸载全部通过；进程及注册表残留 0 | audit-20260905-installer-final.log |
| 发布产物 | exe 产品信息、版本、更新配置、SHA-256 和未签名状态检查通过 | audit-20260905-packaging-final.log、audit-20260905-manifest-final.log |
| 文件清单 | 项目源码、配置、脚本、文档的路径／大小／SHA-256；生成物、依赖包与 skills 不作为逐行源码审查对象 | audit-20260905-file-inventory.csv |

本次使用 Windows x64、Node.js 24.19.0、pnpm 10.33.0、Electron 39.8.10。原有文档中的 25.8.2 是历史开发基线。

## 交付候选

安装包：`apps/desktop/dist-20260905/Tuanbo-Link-Console-0.2.14-x64.exe`

大小：119,667,521 字节。SHA-256：

```text
36207ac9d019f9ac0bb7b7b32beeda220e0b7e6ef776850102a1957047597035
```

这是未签名的本地候选包；Windows 可能显示发行者未知或 SmartScreen 提示。版本仍为 0.2.14，不能将旧 0.2.14 包与本次包混用，须核对摘要。release-manifest.json 如实记录 gitWorkingTreeDirty，提交 SHA 不代表全部当前源码。

默认下载解压步骤在本机出现目录 rename EPERM；本次使用已经通过 E2E 的本地 Electron 运行时在独立输出目录打包，并验证最终 exe。复现打包命令：

```powershell
$env:TBLINK_DIST_DIRECTORY = 'apps/desktop/dist-20260905'
pnpm build
pnpm --filter @tb/desktop exec electron-builder --publish never '--config.directories.output=dist-20260905' '--config.electronDist=C:/dev/tuanbo-yijianchufa/node_modules/electron/dist'
node scripts/verify-desktop-artifacts.mjs --dist
pnpm release:manifest
```

## 尚未完成的现场门槛

1. 真实 P1 播放并持续输出 MTC、逐首归零、帧率、断流与人工恢复，以及实际 OBS／灯光动作和正式声音。历史文档记录 P1 软件环回未发送；本轮未重新验证该硬件链路，不能把它描述为已经解决或把模拟 MIDI 视为 P1 实机证据。
2. 操作员正式工程的资源完整性、全部 Cue 执行和长时间连续运行。
3. 干净 Windows 交互账户／另一台机器兼容性；本轮安装验收是当前账户和隔离应用数据，不等同于干净机器。
4. 私有 GitHub 更新的真实远端版本升级；本轮测试了本地更新 UI 和安装生命周期，没有使用用户 Token 发布新版本或执行远端升级。

因此交付状态是“本机可安装运行、待现场联调签收”，不是“全部现场条件无条件通过”。
