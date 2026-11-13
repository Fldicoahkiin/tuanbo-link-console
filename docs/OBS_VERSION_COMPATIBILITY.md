# OBS 多版本实机兼容性 · 2026-09-23

## 2026-11-13：版本记录误当作画面联动限制

用户反馈 OBS 升级到 33.0.1 后，联动台提示“画面没有联动或已停止”，原因为“期望……，检测到 33.0.1”。该文字来自 `packages/core/src/link-preflight.ts` 的版本检查，不是 OBS 插件加载报错。设置中的“已测试的程序版本”是手动记录，新建本机设置默认记录 32.2.2；此前版本不完全相等就产生阻断项，`apps/desktop/src/main/link/native-obs-outputs.ts` 据此拒绝画面准备。

现在仅 OBS 的已知版本差异作为提醒：显示本机记录和当前版本，提示开播前确认画面播放、切换和停止。不改写用户的版本记录；版本无法取得、连接失败、场景或素材缺失仍按原检查报出，P1 版本检查不变。对应回归在 `packages/core/src/link-preflight.test.ts`，覆盖联动台播放和 P1 跟随、直播和排练，以及 33.0.0、33.0.1、31.1.2 与旧记录不同的情况。

自动化验证：修复前新增的 12 个版本差异用例失败，修复后该文件 34 项通过；全量单测 4220 项通过、81 项按环境跳过，发布工具测试 43 项通过；类型检查、lint、正式模式构建及无本机测试通道检查通过。

这项修复解除的是错误的版本阻断，不代表 OBS 33 的全部插件和正式音视频输出已经实机验收；下表仍只是 0.4.15 当时的实测记录。

## 0.4.15 历史验收

联动台版本：0.4.15。测试主机：Windows 11 x64，10.0.26200。

## 实测结果

使用真实 OBS Windows 程序、真实 Electron 主程序、真实 IPC 和 Windows safeStorage；没有 mock OBS 认证、场景、预览或密码存储。联动台测试进程移除了 PATH。每次测试使用独立 OBS 目录、配置、场景、端口、测试密码及联动台用户数据目录。

| OBS 版本 | 实际 WebSocket 版本 | 构建程序 | 0.4.15 打包程序 |
| --- | --- | --- | --- |
| 30.2.3 | 5.5.2 | 10/10 | 11/11 |
| 31.1.2 | 5.6.2 | 10/10 | 11/11 |
| 32.2.2 | 5.7.4 | 10/10 | 11/11 |

打包程序的额外检查确认原生 DLL 的实际加载位置是本次隔离 OBS 目录，排除误用系统已安装插件的假通过。测试结束后只正常关闭本次启动并按路径、PID、启动时间核验的 OBS，没有强杀，没有启动推流或录像。

版本来源：[OBS 30.2.3 官方发布](https://github.com/obsproject/obs-studio/releases/tag/30.2.3)、[OBS 31.1.2 官方发布](https://github.com/obsproject/obs-studio/releases/tag/31.1.2)；32.2.2 使用仓库已有的便携测试副本，运行时通过 GetVersion 再次核对版本。

## 每个打包版本的 11 项检查

1. 原生预览 DLL 确实从隔离的 OBS 目录加载。
2. 通过设置界面输入错误密码，明确收到认证拒绝。
3. 改为含中文、空格、引号和美元符号的正确测试密码，点击“保存并连接 OBS”成功且错误消失。
4. 读取真实场景、输入与画布尺寸。
5. 联动台切换测试场景，修改测试来源的位置、缩放、裁剪、显隐；再在 OBS 侧修改并由联动台读回。
6. 为当前联动台窗口接入并停用应用音频来源。
7. 获取真实原生视频帧：640×360、921600 字节 RGBA。
8. 对同一 OBS 连续执行三次显式连接操作。
9. 临时令测试联动台进程的 SystemRoot 指向不存在的目录，正确认证仍成功；测试后恢复。
10. 关闭并重启联动台，用 Windows 加密保存的密码重新连接。
11. 改为不可达端口，收到明确失败；恢复正确地址后连接成功。

## 复现与修复

32.2.2 基线测试中，正确密码首次连接和重启后读回均成功，但重复连接时，认证之后的 PowerShell 进程定位在两秒内未完成，导致整个连接 IPC 失败。0.4.15 移除了登录步骤中的原生定位初始化；原生定位服务仍在实际使用时自行定位并明确报告错误，不绕过认证、不自动重试、不隐藏功能错误。

本轮没有复现“正确密码仍被 OBS 拒绝”。视频中的 Authentication failed 不能据此宣称已修复。若远端仍出现该错误，仍需结合该端的具体连接地址、版本和脱敏日志定位。

测试工具另发现 OBS 的 Startup complete / Loaded scenes 日志可能先于 WebSocket 前端就绪，此时读取 GetVersion 返回 207。工具等待测试 OBS 前端就绪后才开始验收；这属于测试环境准备，不代表验收了用户快速启动时的所有时序，也没有给产品加入自动重试。

## 本地证据与复跑

- 测试脚本：`scripts/verify-obs-compatibility.mjs`。
- 打包程序日志：`repair-obs-30-packaged.log`、`repair-obs-31-packaged.log`、`repair-obs-32-packaged.log`。
- 30.2.3 结果与截图：`artifacts/obs-compatibility/run-30.2.3-8gwpqe/result.json`、同目录 `settings.png`。
- 31.1.2 结果与截图：`artifacts/obs-compatibility/run-31.1.2-3MSB2d/result.json`、同目录 `settings.png`。
- 32.2.2 结果与截图：`artifacts/obs-compatibility/run-32.2.2-v0OgOM/result.json`、同目录 `settings.png`。
- `pnpm verify` 通过：849 项单测通过、35 项既有测试跳过，类型检查、Lint、构建和产物校验通过。
- 独立安装包：`apps/desktop/dist-obs-compatibility/Tuanbo-Link-Console-0.4.15-x64.exe`；同目录 `release-manifest.json` 记录产物哈希和版本检查。

原生 PowerShell 下从仓库根目录复跑，例如：

```powershell
node scripts/verify-obs-compatibility.mjs artifacts/obs-compatibility/30.2.3 30.2.3 apps/desktop/dist-obs-compatibility/win-unpacked/团播联动台.exe
```

## 覆盖边界

这份报告确认的是表列具体 OBS 版本、当前 Windows 11 和上述功能链路，不代表覆盖所有 30/31/32 补丁版本、Windows 10、其他显卡与驱动、普通账户和管理员混合权限、旧工程迁移或全部外设。

应用音频项的创建和窗口绑定通过，不等于已测量现场正式音频质量、长时间播放稳定性或完整声光同步。P1、MIDI 硬件与 MA2 各版本不在本轮 OBS 矩阵中。插件测试使用隔离目录加载，未验收目标电脑的 UAC 安装流程；安装包完成打包程序运行和产物检查，未执行当前用户安装覆盖。
