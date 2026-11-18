# 0.5.15 发布记录

2026-11-18（北京时间）正式发布。用户明确要求修复实体 MA2 连接读取回退，完整检查后提交并立即更新软件及官网。

后续现场反馈：11 月 18 日再次收到 0.5.15 在 MA2 3.3.4.3 检查 Sequence 315 超时的诊断。下方是该版发布时的验证记录，不能当作现场故障已解决。遗漏的密集灯具 Lua 解析开销及 0.5.16 修复验证见 [专项记录](MA2_READ_REGRESSION_20261118.md)。

## 来源和范围

- 发行提交：`d4763926d923b2ba67977dd1b25acdb9ba564fcd`，标签 `v0.5.15`。
- 官网自动提交：`763e3aca14ba932f052e1055e6dd0fd10609f47c`。
- 修复：选曲准备只返回必要结果，大序列在控台内流式核对；同次共享序列去重；读取进度、取消、工程切换和失败释放。保留原内容备份、写前比较、写后核对以及原始 Cue 时间与 MIDI 播放。根因和测试细节见 [专项记录](MA2_READ_REGRESSION_20261118.md)。
- 更新说明唯一来源：[release-notes/0.5.15.md](../release-notes/0.5.15.md)。

## 验证

- 本机完整单测 4321 通过、83 条按环境跳过，发版脚本测试 34 通过，类型、lint、正式模式构建及无开发测试通道检查通过。
- 同一发行提交在独立 CRLF 检出、Windows 定时器条件下再次运行全部单测：4321 通过、83 跳过；发版脚本测试 34 通过。
- 本机 onPC 3.7.0.5 实际网络路径验证通过，修改触发与再次读取合计 633 ms，仅操作未分配执行器的自建测试序列，确认所有权后删除；不代表实体 3.3.4.3 的读取时间。30 条时间线与 33 MiB 序列通过真实 Lua 模拟回归。
- [Verify Desktop](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44129203015) 通过。
- [Release Windows](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44130110145) 通过；Windows 单测 4324 通过、80 跳过，类型和 lint 通过，产物清单 8 项检查通过、0 失败。
- 包内音乐分析固定部分 23916 个文件、11 个模块校验通过。
- [Website Release](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44134279216) 和 [官网部署](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44134421602) 均通过。

## 上线核验

UTC 2026-11-17 17:11:48，软件更新源上线，GitHub Release 转正式 Latest。搬运增量 7871704 字节（完整包的 1.11%）；服务器以 0.5.14 拼出完整包并重新验证。

UTC 17:16:42 核对通过：更新源版本与清单一致、Ed25519 发布签名有效、latest.yml 和 blockmap 的 SHA-256 与构建清单一致、安装包 HEAD 返回 200 且长度一致、官网版本/下载链接/更新说明均为 0.5.15。

- 安装包：`Tuanbo-Link-Console-0.5.15-x64.exe`，707894822 字节。
- 安装包 SHA-256：`8229af9040bf3bb721176919f2bcdd4c72eb41cbaa5f16e34934ef024e27bfe3`。
- 发布签名 keyId：`release-2026-10-a`；EXE 的 Authenticode 状态仍为 `NotSigned`，不将更新清单签名描述为 Windows 代码签名。
- [GitHub Release](https://github.com/Fldicoahkiin/tuanbo-link-console/releases/tag/v0.5.15)；[官网下载页](https://tuanbo-link.jinhefilm.com/download/)。

## 保留的验收边界

现场实体 3.3.4.3 尚未安装新版实测；模拟及本机 onPC 不能替代现场验收。桌面旧候选实例没有被强制切换，不将旧窗口视为新版 UI 验收。零秒 Cue 与不提前改变灯光的预滚问题仍按既有已知限制记录，本次未改播放或平移 Cue。

原始用户诊断不入库；测试输出和下载核验报告只保存在本机 ignored artifacts，不上传公开仓库。
