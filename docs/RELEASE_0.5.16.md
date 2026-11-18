# 0.5.16 发布验证记录

2026-11-18（北京时间）正式发布。用户明确要求直接发布本次修复，由现场安装后实测；软件更新源、GitHub 和官网均已上线。

- 发行提交：`eeffd76983a94c37f19208e443670b659e3b81c0`，标签 `v0.5.16`。
- 官网自动提交：`4685ca46b20915a0f04b16d9caa0ca246659e76c`。
- 更新说明：[release-notes/0.5.16.md](../release-notes/0.5.16.md)。

范围：解决 SEQGO 对密集灯具节点的 Lua 执行开销、分批处理大序列和大量 Cue，保留完整核对及备份。真实 onPC 数据与现场边界见 [专项记录](MA2_READ_REGRESSION_20261118.md)。

本地检查已通过：4330 项单测、83 项按环境跳过，34 项发版脚本测试；类型检查、lint、正式模式构建及构建内容检查、版本检查全部通过。最终代码的真实 onPC 128 Cue 修改与再次检查合计 3542 ms。

同一发行提交在独立 Windows CRLF 检出、Windows 定时器条件下再次通过 4330 项单测（83 项按环境跳过）和 34 项发版脚本测试。

- [Verify Desktop](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44258173237) 通过：Linux 单测 4316 通过、97 跳过；类型、lint 和正式构建检查通过。
- [推送后的服务端和官网检查](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44258173285) 通过。
- [Release Windows](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44258919545) 通过：Windows 单测 4333 通过、80 跳过；类型、lint、打包和 8 项产物检查通过。包内音乐分析固定部分 23916 个文件、11 个模块校验通过。
- [Website Release](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44261908925) 与 [官网部署](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/44261985425) 均通过。

UTC 07:49:37，更新源上线，GitHub Release 转正式 Latest。搬运变化部分 3946747 字节（完整包的 0.56%），服务器以 0.5.15 拼出完整包并重新验证。

UTC 07:53:13 上线核验通过：版本、发行提交、Ed25519 更新签名、latest.yml 和 blockmap 的 SHA-256、安装包 HEAD 200 与长度、官网版本/安装包链接/本版更新说明均一致。

- 安装包：`Tuanbo-Link-Console-0.5.16-x64.exe`，707891985 字节。
- SHA-256：`c6f2edd581f62954b66fba5fac57922c8ec7d747187646df50ecd896bd5fcab6`。
- 更新签名 keyId：`release-2026-10-a`；EXE Authenticode 仍为 `NotSigned`，不将更新签名描述为 Windows 代码签名。
- [GitHub Release](https://github.com/Fldicoahkiin/tuanbo-link-console/releases/tag/v0.5.16)；[官网下载页](https://tuanbo-link.jinhefilm.com/download/)。

现场 MA2 3.3.4.3、Sequence 315 尚未实机验证；本机 onPC 3.7 和合成大数据不代替现场验收。零秒 Cue 及预滚的既有未完成验收边界保持。

本机旧候选版只通过正常界面断开了控台连接，以免与联调脚本争用；没有将旧窗口当作本版 UI 验收。诊断原文、测试生成数据和发布核验输出均留在本机 ignored artifacts，未上传公开仓库。
