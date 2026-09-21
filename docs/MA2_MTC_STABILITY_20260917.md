# Windows MIDI / MTC 断流排查（2026-09-17）

本机 loopMIDI 在获授权的 MidiSrv 维护后恢复，并通过 **600 秒真实媒体回环**。已修复发送连接失效及媒体回跳的防护缺口，增强真实回环验证，保留维护前底层零接收、字节不一致和时序超限证据。**服务内部故障的具体触发机制与复发风险尚未完全查明，实体 MA2 未验收**；不能用这次 Windows 回环通过代替最终电脑与实体控台验收。

## 失败证据与定位边界

- 原始 `acceptance-ma2-completion-mtc`：音频到 1953.711ms；应用发送 237 次，输入收到 204 次但近期全是 `[176,119,1]`，完整 MTC 周期为零。发送调用计数不能证明 Windows 端实际传输了相同字节。
- `acceptance-ma2-mtc-repro-20260917`：本轮 A→A 试验零接收。原生双端回环必须 A→B；原始验收未保存输入端配置，不能据此断言原始故障只是接错端口。
- `acceptance-ma2-mtc-loopmidi-20260917`：正确的 loopMIDI 同名测试端口仍零接收。
- `acceptance-ma2-mtc-winmm-20260917.json`：独立 Python ctypes 直接调用系统 WinMM，打开、启动、16 次短消息发送和关闭全部返回 0，但实际收到 0 条；这条故障已绕过应用、React、Electron 和媒体调度，定位到 Windows MIDI / teVirtualMIDI 传输路径。尚不能断言具体驱动内部根因，也不能声称已修复该路径。
- `acceptance-ma2-mtc-winmm-native-20260917.json`：原生 Native A→B 同样的 16 条消息逐字一致。
- `acceptance-ma2-mtc-winmm-peer-20260917.json`、`acceptance-ma2-mtc-winmm-concurrent-20260917.json`：WinMM 同进程及独立进程并发开关客户端，480 条测试消息逐字一致。没有用成功的原生通道替代生产端口设置。
- `acceptance-ma2-mtc-delivery-20260917`：原生 Native A→B 在并发 Electron 客户端开关与强制 GC 后发生字节不一致。发送 1488、接收 1489、1370 条匹配、119 条不匹配、7 次 QF 失序；诊断出现约 0.87s 的积压。发生失配后的 FIFO 配对不再可信，因此时间戳数据仅用于定位，不能用于通过验收。尚未证明是哪一个并发操作导致故障。

本轮没有重启 MidiSrv，没有重启/关闭用户的 loopMIDI、P1、MA2、OBS，没有更新驱动或修改正式 MIDI 端口，也没有切换生产时钟来源。系统显示 WinMM 文件版本 `10.0.26100.8875`，Windows MIDI 工具 `1.0.17-rc.4.25`。已检查 loopMIDI 窗口：测试端口总数据仍为零，并非仅应用接收端未处理。

## 代码修复与验证改进

1. `MediaMtcOutput.tick` 同时检查 `state=connected` 和 `connection=open`。关闭或 pending 连接明确失败，禁止继续调用 `send()` 触发隐式重开。真实 Electron 测试主动关闭实际生产发送对象后，音频停止，显示错误，发送计数不再增加。
2. 未显式定位的媒体时钟回跳立即失败，不再静默等待旧的 quarter-frame 位置。正常暂停/定位通过既有 `stop()` 重置，再发 full-frame。时钟仍来自真实 `HTMLAudioElement.currentTime`。
3. 保留原有 100ms 调度中断保护、不向未来排队、不自动补发失败会话、不自动重试和不切换时钟的行为。
4. 回环测试先发送一次 8 条各不相同的路由探针，逐字核对后才播放。错误配对、零接收和重复旧消息在预检即失败。此为专用测试端口的验收前置检查，不是给所有正式 MIDI 输出新增了回执能力。
5. 连续测量逐字核对发送与接收顺序，保存配置、发送队列、原始接收字节、媒体时钟误差、发送时媒体采样及系统接收时间戳。原有一帧误差门槛保持不变；增加诊断数据不用于放宽阈值。
6. 只有全部断言通过才生成 `acceptance.json`；失败生成 `failure.json`。`result.json` 只是测量数据，存在该文件不表示通过。
7. 两个旧手工探针 `send-windows-mtc.mjs` 和 `probe-link-mtc-runtime.mjs` 原来每秒发送 `fps*8` 条、每组 8 条前进一帧；改为 `fps*4` 条、每组前进两帧。生产 `MediaMtcOutput` 本来就是正确的四分之一帧频率，这不是生产断流根因。
8. 新增 `tools/ma2/probe-winmm.py`，只允许 `TBLINK SOAK ` 专用端口，逐条记录 WinMM 返回码和实际字节；可对照同进程/独立进程端口开关，不重试、不重启服务。

另修复阻断测试启动的 `LinkApp.tsx` 声明顺序：`useDocumentShortcuts` 移至 `saveProject` 初始化之后。共享 `out` 在测试期间被再次构建并报 `Cannot access 'saveProject' before initialization`；失败目录 `acceptance-ma2-mtc-soak-20260917` / `acceptance-ma2-mtc-route-block-20260917` 属于启动失败，不能归入 MIDI 结果。后续使用独立 `out-mtc-acceptance`。

## 已完成检查

- 全量单测：785 通过，35 条环境条件测试跳过，见 `acceptance-ma2-mtc-unit-20260917.log`。
- 类型检查通过，见 `acceptance-ma2-mtc-types-20260917.log`；后续新增验收诊断又通过 e2e TypeScript 检查。
- 本轮 TypeScript 文件定向 ESLint、两个脚本的 Node 语法检查通过；构建和独立验收构建通过。
- 四种帧率各一小时的确定性调度回归通过，包括 QF 顺序、总数、有界误差；**不是实时或实体测试**。
- `acceptance-ma2-mtc-baseline-soak-20260917`：修改前原生 Waveform A→B 连续 300 秒通过，包含强制 GC、并发客户端开关、最小化/恢复。说明当前环境并非所有通道都持续失败，不证明 loopMIDI 已恢复。
- `acceptance-ma2-mtc-regression-20260917`：修改后 15 秒真实媒体 + Windows 回环通过；实际发送端关闭后停播、不重开。
- `acceptance-ma2-mtc-isolated-route-block-20260917`：loopMIDI 专用端口在播放前被新路由预检明确拒绝。它是保留的环境失败证据，不能列为稳定性通过。
- `acceptance-ma2-mtc-gc-only-20260917`：Native A→B 60 秒、只强制 GC，通过原一帧门槛、逐字顺序和断开停播验证。
- `acceptance-ma2-mtc-peer-only-20260917`：Native A→B 60 秒、只执行并发客户端开关，通过原一帧门槛、逐字顺序和断开停播验证；已生成 `acceptance.json`。单因素通过不能推翻 GC + 并发组合试验的字节不一致失败。
- `acceptance-ma2-mtc-isolated-soak-20260917`：**600 秒真实持续测量失败**。使用 3605 秒未缓存音频，强制 GC、并发端口开关、最小化/恢复。测量 600528ms，72062 条消息全部逐字匹配，9006 个完整周期，0 失序，首尾平均漂移 0.68726ms；误差范围 **−50.109～+8.317ms**，最大绝对误差超过 33.333ms 门槛，没有放宽断言。该轮运行时尚未加入后续 `delivery.json` 分解指标，不能倒推超限发生在发送还是接收回调。测试期间另有全量类型/单测及独立端口诊断负载；该结果属于有负载条件，不能以此宣称空载必定失败，也不能删除它后只保留短测通过。

上述记录为获得维护授权前的结果。随后获得的授权、单次服务维护及前后对照见下一节；维护前失败证据继续保留。服务维护后恢复不等于具体触发缺陷已被永久修复或实体控台通过。

## 获得授权后的服务维护对照

用户随后明确授权“现在允许重启一次 MidiSrv”。2026-09-17 19:37:17（北京时间）仅执行一次 `Restart-Service MidiSrv`。命令报告 `Service 'Windows MIDI 服务 (MidiSrv)' stop failed`，但服务 PID 从 **9856** 变成 **40876**，新进程启动时间 19:37:18，状态为 Running。不能将此描述为一次正常无错误的服务重启；具体退出/恢复机制尚未确认。没有再次执行重启，也没有强杀任何进程。原始记录见 `acceptance-ma2-mtc-service-restart-20260917.log`。

服务进程更替后，使用完全相同的 `TBLINK SOAK MTC` 输入/输出与 WinMM 探针，16 条消息全部逐字匹配，各 API 返回 0，见 `acceptance-ma2-mtc-winmm-after-service-20260917.json`。维护前同端口零接收，见 `acceptance-ma2-mtc-winmm-20260917.json`。这为服务运行状态参与故障提供了直接对照证据，但尚未识别内部触发缺陷，不能声称代码修改已防止其复发。

`acceptance-ma2-mtc-loopmidi-after-service-20260917` 的 **600 秒真实媒体回环通过**，输入/输出仍为原 loopMIDI 测试端口，未改生产端口或时钟来源；使用原独立构建与 3605 秒未缓存音频，开启强制 GC、并发客户端端口开关、最小化/恢复。本次没有并行执行全量构建/单测，因此与维护前有额外编译测试负载的原生回环时序结果不是完全相同的负载对照。

- 实测 600062ms，9000 个完整周期，0 QF 失序；末次采样 72011 条发送消息全部逐字匹配，0 字节不匹配、0 待接收积压。
- 媒体时钟误差范围 −12.4553～+8.1543ms，最大绝对误差 12.4553ms，小于原 33.3333ms 门槛；首尾平均漂移 −0.03518ms。
- 强制关闭实际发送端口后，音频暂停，显示“连接已失效”，发送计数停止增长，连接保持 closed；没有自动重开、自动重试或切换时钟。
- 页面错误为空，生成 `acceptance.json`，其中 `passed=true`、`physicalConsoleAcceptance=false`。运行日志见 `acceptance-ma2-mtc-loopmidi-after-service-20260917.log`，详细数据见该目录下 `result.json`、`delivery.json`、`sent.json`、`disconnect.json`、`configuration.json`。
- 结束时 MidiSrv 仍为 PID 40876 / Running；没有执行第二次重启或其他服务干预。

当前可确认：同一 loopMIDI 路径在应用之外的 WinMM 层由零接收恢复为逐字一致，恢复与服务进程更替有直接时间对应关系；随后应用真实媒体链路的十分钟压力回环通过。仍不能确认：服务内部触发缺陷、超过十分钟的实际稳定性、最终演出电脑与实体控台的执行准确性。生产 P1/MA2 等原有 MIDI 客户端经历了服务维护，需要由操作员在恢复演出前明确核对连接与 Slot；本轮未擅自操作它们重连或开播。

## 复验命令

必须在 Windows PowerShell 执行，测试端口必须专用且没有其他发送者。逐个运行，不要在同一对端口上并行执行探针与 soak。

```powershell
pnpm --filter @tb/desktop exec electron-vite build --outDir out-mtc-acceptance
$env:TBLINK_MTC_SOAK='1'
$env:TBLINK_MTC_SOAK_BUILD_DIR='out-mtc-acceptance'
$env:TBLINK_MTC_SOAK_SECONDS='3600'
$env:TBLINK_MTC_SOAK_AUDIO_SECONDS='3605'
$env:TBLINK_MTC_SOAK_INPUT='TBLINK SOAK Waveform B'
$env:TBLINK_MTC_SOAK_OUTPUT='TBLINK SOAK Waveform A'
$env:TBLINK_MTC_SOAK_GC='1'
$env:TBLINK_MTC_SOAK_PEER='1'
pnpm --filter @tb/desktop exec playwright test test-e2e/mtc-soak.spec.ts --workers=1 --output=../../acceptance-ma2-mtc-hour

python tools/ma2/probe-winmm.py --input 'TBLINK SOAK MTC' --output 'TBLINK SOAK MTC'
python tools/ma2/probe-winmm.py --input 'TBLINK SOAK Native B' --output 'TBLINK SOAK Native A' --cycles 60 --peer-process
```

上面一小时命令是后续复验方法，**本轮未完成一小时实时运行**。实体 MA2 还需确认实际 MIDI 接口、Slot、帧率、非零歌曲起点、暂停/定位、事件执行和持续播放。对于 WinMM 成功但驱动不交付的情况，Web MIDI 没有接收端回执，应用不能凭 `send()` 无异常声称控台已收到。

## 参考

- [W3C Web MIDI](https://www.w3.org/TR/webmidi/)：`send()` 可隐式打开 closed 端口；`MIDIMessageEvent.timeStamp` 表示系统接收时刻，不是 JS 回调执行时刻。
- [Microsoft WinMM midiOutShortMsg](https://learn.microsoft.com/en-us/windows/win32/api/mmeapi/nf-mmeapi-midioutshortmsg)：短消息与返回码契约。
- [Microsoft Windows MIDI 已知问题](https://devblogs.microsoft.com/windows-music-dev/windows-midi-services-rollout-known-issues-and-workarounds/)：记录过动态虚拟 MIDI 端口兼容性问题；本机故障尚未与具体上游缺陷一一对应，不能仅凭此文认定根因或擅自更改系统。
