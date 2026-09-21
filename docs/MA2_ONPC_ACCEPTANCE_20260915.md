# MA2 onPC 验收记录 · 2026-09-15

## 当前结论

**本机工程交换与灯光编辑回归通过；完整播放验收尚未通过。** 真实 MTC 持续测量约 30 秒后断流，原生 Windows MIDI 接口也复现发送错误。不能把软件测试全绿或 XML 同步成功当作音乐、控台和执行器的完整闭环成功。

环境：Windows 原生，grandMA2 onPC 3.3.4.3；数据目录 `C:\ProgramData\MA Lighting Technologies\grandma\gma2_V_3.3.4`。Windows MIDI Services Console 报告版本 `1.0.17-rc.4.25`。本轮未连接实体控台。

## 已完成

| 验收 | 结果 | 证据（仓库根目录） |
| --- | --- | --- |
| 初始 `pnpm verify` | 705 通过、32 跳过；类型、Lint、构建、产物检查通过 | `acceptance-ma2-20260915-verify.log` |
| 6 个 MA2 文件，开启本机原生条件测试 | 87/87 通过；包含普通检查与真实 onPC 条件用例 | `acceptance-ma2-20260915-native.log` |
| 灯光界面最终回归 | 22/22 通过，2.1 分钟 | `acceptance-ma2-20260915-lighting-final.log` |
| Electron 界面 → 实际 IPC → 本机 onPC | 1/1 通过；导入、改时间、同步回读、双方冲突取控台版本、保存重开、还原 | `acceptance-ma2-20260915-ui-roundtrip/` |
| 原生新建空 Timecode、重复创建拒绝覆盖 | 2/2 通过（含 1 个原生用例） | `acceptance-ma2-20260915-create-native-final.log` |
| 修改后类型检查 | 通过 | `acceptance-ma2-20260915-typecheck-latest.log` |
| 本轮灯光组件及 Electron 测试定向 Lint | 通过 | 命令执行结果 |

原生 UI 往返使用自有 Timecode 9902：1.5 秒 → 界面改 1.2 秒 → 原生导出确认 36 帧；随后本地改 1 秒、控台改 42 帧，界面出现冲突，选择控台后保存 1.4 秒，重开再次比较无冲突。测试 finally 回读并恢复原始 Timecode，产物含 before/written/restored XML 和冲突、重开截图。

最终 22 项界面测试覆盖十万事件可见区显示、多选移动、剪贴板与撤销、关联控台、读取预览、小数 Cue 对应、5 份原生 REAPER 文件、变速曲线、时间线打点与重开、录制、音乐尾部处理、Master 编辑与冲突显示、设置 IPC 及不同窗口尺寸。**其中 MA2 网络设置用例使用模拟 TCP 服务，不能计为实际远程登录通过。**

## 修复

1. 空节目在时间线上创建首个点后，后续打点被当前节目尾部截断，造成点重叠。灯光编辑吸附使用编辑允许的时间范围；不修改正式播放定位边界。实际界面复现后修复，多选、拖动、删除和撤销已回归。
2. 界面验收脚本跟随现有设置子菜单、节拍属性区域、删除按钮名称及占用画面轨道的显示规则更新。原先 5 项失败已逐项复测，最终整组 22 项通过。
3. 新建 Timecode 的原生断言原先逐字节比较 XML，跨秒导出的 `Info.datetime` 会变化。改为比较解析后的完整 Timecode 内容；重复创建仍要求明确拒绝，未放宽对象内容检查。
4. 持续 MTC 测试增加页面错误和最近 32 条原始 MIDI 消息记录，保留原来的断流和精度门槛。

初始整套桌面回归曾中断，不能报告全部桌面功能通过。工作区并行出现其他任务的 OBS、preload、进程管理等改动；本记录只对上述实际执行的检查负责，初始 verify 也不代表后续所有改动的最终验证。

## 当前阻断：真实 MTC

第一轮：真实 HTML 音频时钟驱动生产 MTC 输出，经 `TBLINK SOAK Waveform A → B`，MA2 输入为 B。约前 30 秒收到 454 个完整周期、无错序，误差约 −5.73 至 +8.16 毫秒；随后断流超过一秒，音频仍播放。MA2 原生监视端口同步记录 TC Slot 2 丢失锁定。整轮失败，不能只取前半段宣布通过。

证据：`acceptance-ma2-20260915-mtc-native/`。第二轮 `...-mtc-diagnostic/` 记录输入重复收到初始化 CC `[176,119,1]`，没有完整 MTC；`...-mtc-loopmidi/` 对照中软件调用发送 236 次但接收为零，loopMIDI 自有测试端口计数为零。页面错误记录为空。

进一步对照：

- Windows MIDI 服务 ping 10/10 有响应。
- MIDI 2.0 系统工具直接向 A 发送单条消息，B 的原生监视收到。
- 绕过 Electron，C# P/Invoke 调用 WinMM：`midiOutOpen` 返回 0，8 次 `midiOutShortMsg` 全返回 1，关闭返回 0。接收侧捕获重复 `0x10F10000`，而发送序列递增。
- 证据：`acceptance-ma2-20260915-midi-winmm.log`、`acceptance-ma2-20260915-midi-diagnostics/`。问题已在 Windows 旧 MIDI 兼容通道复现；尚未确定底层根因，不以修改软件调度或放宽门槛掩盖。

已向用户申请重启 Windows MIDI 服务并重连 MA2 输入，因为这会断开全机其他软件的 MIDI 连接。未获确认前不执行服务重启。

## MA2 对象与恢复

- 原有自有 Timecode 9901–9904、Sequence 9901/9904、Executor 99.219/99.1 用于验收；未改灯具参数。
- 9902/9903 由测试 finally 回读还原。
- 本轮新建空对象 9905、9906，分别命名 `TBLINK_CREATE_ACCEPTANCE_9905/9906`；保留作为明确标记的验收产物。
- MTC 测试曾把自有 9904 临时设为 Slot 2。已执行 `tblink_onpc_mtc_acceptance.lua` 的 restore，停止自有 Timecode 和 Executor 99.1，并确认 before/restored XML 的完整 Timecode 节点相等。
- MA2 MIDI 输入保持原来的 `TBLINK SOAK Waveform B`。验收期间切至 Page 99；桌面出现其他任务的 OBS 防火墙提示，未操作该提示。

## 下一轮必须完成

1. 经确认恢复 MIDI 服务后，原生 WinMM 发送对照成功，重连 MA2 输入。
2. 重跑至少 60 秒真实音频 MTC 测量，包含最小化与恢复；无断流、错序，误差不超过一帧。随后长时稳定性测量。
3. 在 onPC 直接核对音乐定位、播放、暂停、重播、循环与自然结束，以及实际 Cue、Master 执行结果。
4. 已观察内部时钟采样时播放头为 1:24 帧、Master 显示 30%；此为实际画面观察，不能写成精确 2 秒的预期值验收。还需更准确的多点播放核对。
5. 需要网络模式时，再验真实 Show 用户远程登录与双端口完整同步；实体控台独立验收。

## 使用入口

本机 onPC：运行桥接插件 → 联动台“设置 → 设备连接 → MA2 控台”选择本机 onPC 并填写对应版本数据目录 → 编辑器灯光工具“节目同步”读取 Timecode → 加入当前节目或关联轨道 → 编辑 Cue 引用、时间和 Master → 比较差异并处理冲突 → 同步并确认回读成功。

音乐驱动 MA2 还需要单独配置 MTC 输出与 onPC MIDI 输入，不能用工程同步代替时间码连接。当前该播放链路处于故障定位阶段。
