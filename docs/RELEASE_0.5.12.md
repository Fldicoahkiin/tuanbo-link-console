# 0.5.12 发布记录

北京时间 2026-11-17 已正式发布。软件版本、GitHub Latest、腾讯云更新源和官网下载页均为 **0.5.12**。

## 来源

- 发布标签：`v0.5.12`。
- 软件提交：`10e79643cc8fcb1e791a80fba3314881b207d5e7`。
- 完整包含用户指定的 `864dddd90867eceaca26d777a9fb24f52296ec03`，以及之后的本地修复和发布准备；GitHub 比较结果为 ahead 3、behind 0。
- 官网版本信息提交：`59d2190957bc5d058ee862018f2cfec0c9713658`。
- 用户可见的变更统一记录在 [0.5.12 更新日志](../release-notes/0.5.12.md)。

## 验证

- 本地类型检查、lint、正式模式构建和构建校验通过。
- 干净 Windows 检出及粗粒度定时器检查：4258 项通过，82 项按条件跳过；另有 34 项发布脚本测试通过。用与云端相同的 Node 25.8.2 复查整套单测也通过。
- 干净安装时修正桌面端 Lucide 的 React 类型依赖，避免误用运营后台的 React 19 类型；补齐连接测试导入前的浏览器存储模拟。没有修改已有规则测试或放宽断言。
- 本地官网、购买流程和运营后台浏览器检查通过，未执行真实付款或生产凭据操作。
- [Verify Desktop](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/43898774066) 通过。
- [Release Windows](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/43899991640) 通过：Windows 单测 4261 项通过、79 项按条件跳过；构建清单 8 项检查通过、0 项失败。
- [Website Release](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/43904698352) 和 [官网部署](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/43904802234) 通过，部署步骤实际执行成功。

## 产物及上线核对

- 安装包：`Tuanbo-Link-Console-0.5.12-x64.exe`，707,875,634 字节。
- 构建清单及服务器完整校验的安装包 SHA-256：`5cf310e1df83d699689885218569b70993648c8f8d35329cc6fcd3ac616817f8`。
- 发布签名：`release-2026-10-a`；构建清单确认来源工作区干净。Windows Authenticode 状态为 `NotSigned`，与更新源的发布签名是两回事。
- 搬运采用增量：7,893,046 字节的变化内容，服务器据 0.5.11 重建完整安装包，重新校验后发布。北京时间 00:11:16 转为 GitHub 正式 Release 并标记 Latest。
- 客户端核验了线上 `latest.yml` 与 GitHub 附件完全一致，发布签名、版本、大小、摘要及官网 `release.json` 一致；安装包 HEAD 返回 200，首部、中部、尾部各 1 MiB 的 Range 返回 206，字节与 GitHub 相应范围一致。完整安装包校验由服务器发布流程执行，客户端本次没有重新下载完整包。
- 已用真实浏览器打开官网下载页，确认显示 0.5.12、下载链接正确且无页面脚本异常。

入口：[GitHub Release](https://github.com/Fldicoahkiin/tuanbo-link-console/releases/tag/v0.5.12)、[官网下载页](https://tuanbo-link.jinhefilm.com/download/)、[更新源](https://updates.tuanbo-link.jinhefilm.com/windows/x64/latest.yml)。

本轮完成自动化验证和发布核验，不替代 OBS、实体 MA2 及完整 MTC 播放的现场验收；既有待验收项仍见 [实施状态](plan.md)。
