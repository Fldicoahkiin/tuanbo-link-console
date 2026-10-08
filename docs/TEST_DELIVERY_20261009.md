# 0.4.45 含离线音乐模型的免激活测试版

用户明确要求完整测试安装包、必须包含音乐分析模型，并授权全部代码提交 GitHub、合并。此次交付独立 `portable-test` 渠道，不改变正式版的授权规则。原始现场问题继续记录在 [READINESS_20261008.md](READINESS_20261008.md)。

## 安装文件

- `D:/Tuanbo-Test-Offline-20261008/Tuanbo-Link-Test-NoActivation-0.4.45-x64.exe`
- 988453452 字节（约 988 MB / 943 MiB）。
- SHA-256：`BAB54A22E844C2EED50A058646364DC01E143B3923FC8A3EF1DA426E0642F8C6`。
- Authenticode：NotSigned。
- 独立名称：团播联动台功能测试版；appId：`com.tuanbo.control.functionaltest`。
- 免激活、不绑定某一台主机，无到期日；测试渠道关闭正式自动更新源。
- 程序来源提交：`f3a153c2c98b550f30842c5eabccd384b52e429d`。后续提交仅更新交付说明。
- 不交付此前生成的不含模型包；本文件列出的安装包是最终交付文件。

## 已包含的音乐组件

Python 3.11.9、PyTorch/torchaudio 2.7.1 CPU、Beat This! final0/1/2、All-In-One harmonix-all 八折模型、HTDemucs，以及分析器全部运行依赖。音乐资源共 23927 文件、2095387620 字节。安装后无需系统 Python、Git、编译器或联网下载。`python311._pth` 将导入路径限制在随包运行时内；推理链路禁止 Python 网络连接。

这个安装包明确提供 **CPU** 模式，不包含 CUDA 运行库，不将 CPU 性能冒充 RTX 4070 的验收成绩。模型元数据冲突及许可文件保留，见 [DISTRIBUTION_NOTICE.md](../tools/music-analysis/DISTRIBUTION_NOTICE.md)。这次内部测试不代表商业模型再分发条件已澄清。

## 2026-10-09 安装后验证

1. NSIS 静默安装到独立目录 `D:/Tuanbo-Test-Offline-20261008/installed`，退出码 0。安装后 app.asar 与构建产物摘要相同：`04F3B4993640CF57CF0CF3633C1493D1CFA971849D78116992B84B25A8E57AAF`。
2. 空白配置、损坏授权文件、重新启动均直接进入工作区；真实主进程输出权限、工程创建、原生播放设备枚举和日志查询通过，正式更新源保持禁用。证据：`installed-license-acceptance/acceptance.json`。
3. 安装后的音乐运行时 23927 个文件全部按摘要核验。通过真实 Electron IPC 启动安装目录内的 Python，使用用户 32.933 秒参考音源完成三个节拍模型、结构模型及声部分离。没有使用开发环境 Python 或模拟模型输出。
4. 首次端到端 115.275 秒（模型报告 109.110 秒），输出 65 个普通拍点、6 个段落；缓存复测端到端 3.332 秒（工作进程报告 1.020 秒），确认缓存命中。完整主机时间包含进程启动与轮询，不能用工作进程内部耗时替代。证据：`installed-music-acceptance/acceptance.json`。音源与证据仅保存在本地，不提交 GitHub。
5. 顶部连接状态容器原先整块 `no-drag`，导致按钮旁的大片空白也不能拖动，现改为 `drag`，具体按钮继续 `no-drag`。顶部模式/连接定位 Electron 回归 2 项通过，真实当前窗口的标题栏双击最大化/还原通过。自动化拖动没有提供可靠的位置变化证明，不将它列为完整原生拖动验收。

此前全仓 Windows `pnpm verify:release` 通过（1632 单测通过、61 跳过），Python 56 项通过；本轮新增打包/安装验证脚本 lint、前端构建与顶部专项通过。此次未重复声称全部 Electron 用例、全部真实硬件或长时间压力测试通过。

## 仍存在的限制

- 当前 CPU 安装包未验证五分钟音乐 P95 ≤180 秒；本次端到端缓存 3.332 秒也未达到原计划 ≤2 秒门槛。
- 模型能运行和输出数量不是识别正确率；真实曲库、独立校准及盲测仍未完成。
- OBS 素材定位偏差、切场景后的美颜来源停更提示仍需处理；不能据灯光播放或此安装测试宣布整套系统可正式直播。
- 未完成本轮安装卸载/跨版本升级全流程、另一台实体电脑或断开操作系统网络的整机验收。已验证的是随包运行时隔离与推理网络禁止机制。

## 复现

```powershell
node scripts/build-portable-test.mjs <新的输出目录>
node scripts/verify-portable-test.mjs <安装后的EXE> <新的授权验收目录>
node scripts/verify-installed-music.mjs <安装后的EXE> <真实WAV> <时长毫秒> <新的音乐验收目录>
```
