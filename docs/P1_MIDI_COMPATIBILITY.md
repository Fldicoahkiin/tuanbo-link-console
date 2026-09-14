# P1 1.14.2 与 Windows MIDI Services 的输出枚举兼容性

2026-09-05 现场：P1 已勾选发送 MTC 30Hz，播放正常但显示“未发送”。设置中的 MIDI 输出列表为空，输入列表有三个虚拟端口；连续监听 12 秒收到 0 条消息。联动台停在 armed，没有执行 Cue。

## 新发现：不能据此认定必须增加物理设备

本机 P1 可执行文件调用 `midiOutGetDevCapsW` 的一处输出枚举传入 76 (`0x4c`) 字节，另一处传入 84 (`0x54`) 字节。输出结构 MIDIOUTCAPSW 长度是 84 字节，76 是输入结构的长度。

通过独立 WinMM 调用复现：

| 输出设备 | 查询 76 字节 | 查询 84 字节 | 打开输出 |
| --- | --- | --- | --- |
| Microsoft GS Wavetable Synth | 0 | 0 | 0 |
| 团播联动台 P1 MTC | 11 | 0 | 0 |
| Default App Loopback (A) | 11 | 0 | 0 |
| Default App Loopback (B) | 11 | 0 | 0 |

0 表示成功，11 为 MMSYSERR_INVALPARAM。厂商手册展示物理 MIDI 线并不证明只能使用物理设备；早期验收记录中“需物理 USB-MIDI”的推断应由本次实测修正。

微软接口文档：<https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/nf-mmeapi-midioutgetdevcapsw>。文档说明仅回填调用方指定长度或更少，因此此处也是旧程序与当前系统实现的兼容差异。

## 兼容实现

`tools/p1-midi-compat/winmm.c` 仅将 76 字节输出设备查询改为在临时完整结构内查询，成功后回填 76 字节，避免写越调用方缓冲区。其他查询保持原行为，其他 winmm 导出转发至系统库。它不产生、替换、修改 MTC 或音乐时钟。

采用 P1 目录内的独立兼容 DLL，不改 P1.exe 和系统注册表。模块已在本机加载，181 个系统导出按名称及序号均可解析，0/76/84 字节查询与缓冲区边界检查通过。

## 真实现场结果

- P1 重启后 MIDI 输出列表出现三个虚拟端口；勾选“团播联动台 P1 MTC”。
- 播放正式 P1 素材时，P1 显示“发送中”；独立接收端连续 12 秒收到 1440 条 quarter-frame，无人工时间码发送器。
- 当前“节目 1”在 P1 开播后 `armed → running`。日志确认 OBS 视频播放、4 秒 5 帧显示第一个来源及变换、9 秒 5 帧隐藏第一个并显示第二个来源及变换、14 秒 5 帧隐藏第二个，均返回 succeeded。
- 约 37.9 秒素材停止成功；P1 播毕停发后，联动台进入 timecodeLost，验证断流冻结。人工停止恢复 idle。
- 证据：`output/p1-mtc-live-diagnosis.json`、`output/p1-real-obs-follow.jsonl`、`output/p1-compat-installed-hashes.json`。

这里只确认本机 P1 1.14.2 和当前工程的真实消息及 OBS 动作回执；长时间运行、其他 P1/Windows 版本和全部工程不在此项验证范围。OBS 画面尚需操作员复核。

## 使用与恢复

先在联动台选择节目并点击“启动并待命”，再在 P1 从头播放对应素材。重播需先停止联动再重新待命。停止播放时没有持续 MTC 属正常现象，软件不会再把空闲端口显示为时间码已连接。

本机目录 `D:\HirenderP1` 增加 `winmm.dll`（兼容模块）和 `tblink_winmm_system.dll`（本机系统库副本）。恢复时先正常退出 P1，再运行随附 `install.ps1 -Remove`。其他电脑应重新验证系统版本；不分发本机 Windows 系统库。
