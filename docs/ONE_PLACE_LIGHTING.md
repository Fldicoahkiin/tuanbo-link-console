# 只有一处实现 · 灯光和 MA2

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 怎么认控台

只按编号认，不看 Show 名和 IP（`packages/core/src/ma2-console-identity.ts`）

## 歌和控台时间线怎么配对

只看时间码节目编号和 MTC 起始码（`packages/core/src/ma2-pairing-state.ts`）

2026-11-16 最新要求：统一「控台时间线」列表入口，手动关联和右键编辑共用 `runtime/ma2-timeline-actions.ts`，移除旧的替换/追加选择页面与重复入口。同 MTC 自动匹配，手动选择先现读、存档，再执行同一条可撤销配对命令；新建立即创建空时间线及序列，占用编号/格位向后顺延，实际结果回填。控台已有时间线的名称/MTC 由 `ma2-timeline-edit.ts` 核对来源、保留所有事件和相对时间后写入并回读。详细规则见 LIGHTING_WORKFLOW.md 开头。

2026-11-14 修复首次配对只显示“对上”、Cue 没进歌曲：完整的控台读取结果与歌曲起始码唯一匹配时，配对步骤就通过原有导入命令把 Cue 放进歌曲。先读控台再改起始码、先有歌曲再读控台都一样，与这次改动一起撤销。已关联的不重复导入，不覆盖本地编辑；目录未读完整、来源未确认、转换失败、起点重复或操作员已解除关联的先不自动导入。导入失败保留原编排和起始码，原因记在对应时间线上，其他编辑不触发重试。回归：`packages/core/src/ma2-timeline-switch.test.ts`。

## MA2 同步

方式 1、方式 2 和改名走同一个逐首同步、同一份状态（`runtime/ma2-song-sync.ts`、`stores/ma2-sync-store.ts`）

2026-11-16 同步速度：`ma2-network-wire.ts` 在同一请求协议中处理批量响应和本机临时文件响应，只有明确的回环地址启用本机文件，远程仍按网络传输；请求身份、完整长度、写入后读回确认都保留。`ma2-layout-service.ts` 新建序列原生复制不再重复下载来源，目标完整读回负责发现来源在复制期间变化。`ma2-network-wire.test.ts`、`ma2-bridge-lua.test.ts`、`ma2-layout-service.test.ts` 守着；实际速度和协议见 `tools/ma2/README.md`。

2026-11-16：控台时间线页的新建与“将当前编排写入控台”调用 `syncMa2Once(itemId)`，手动只处理当前歌曲，失败后重试不添加 Cue；实时同步开启时仍逐首处理工程。每次写入读取歌曲中已编辑的位置，不经过初始间隔展开。`ma2-realtime-session.test.ts` 守住指定歌曲的范围，`packages/core/src/ma2-song-sequence.test.ts` 守住编辑时间及重复读回不增加点。

本机 onPC 3.7 实测修复：Lua 的 `assert(value, message)` 成功时返回两个值，不能嵌在 MA 原生 `getobj.amount` 的参数中。`tools/ma2/tblink_bridge.lua` 先取 Timecode 池句柄，再单参数枚举，避免连接成功但 TCRANGES 失败、无法分配起始码。`ma2-bridge-lua.test.ts` 校验原生参数个数；`ma2-hardware.test.ts` 的只读诊断实测目录与占用区间编号一致。

2026-11-16：原自有序列请求返回时若歌曲已改为其他控台时间线，不把旧序列重新挂回；等待存档后执行工程命令时也校验，撤销历史不为已关联歌曲重新补自有序列。手动“同步一次”只有本次读回确认或明确失败、暂停才结束，断线等待不因尝试过就结束。测试：`runtime/ma2-realtime-session.test.ts`。

2026-11-16 本机 onPC 连接链路修复：设置里的“本机 onPC”是明确选择本机地址 127.0.0.1，经 `stores/ma2-connection-store.ts` 的 `connectLocalMa2` 使用现有网络管理器登录、准备内置插件并检查回应，成功后保存为网络连接；不再用只检查文件插件、却进不了逐首同步的连接入口。复用本机已保存的登录，失败不搜索或改连其他控台。需要 onPC 已开启 Telnet（Login Enabled），不需要网线。设置页和顶部一键连接都调用 `runtime/ma2-editing-session.ts` 的 `prepareMa2Editing`，依次读取、按起始码导入 Cue、准备素材；只在操作员明确连接时读取，断线重登不触发这一步。测试：`stores/ma2-connection-store.test.ts`、`view-models/connect-devices.test.ts`、`runtime/ma2-editing-session.test.ts`。

2026-11-14：新歌写入位置统一取 `ma2-song-sync.ts` 的 `ma2SongSyncSettings`，两个界面入口共用 `Ma2SongDestination.tsx` 保存工程里的按钮页和起始序列编号。同步等待的原因由 `prepareMa2RealtimeSession` 给出，不能无提示返回；手动同步也展示原因及控台确认后的实际序列、Timecode 和按钮位置。测试：`ma2-realtime-session.test.ts`、`apps/desktop/test-e2e/editor-transport.browser.spec.ts`。

## 执行器按键和推杆走哪条通道

`apps/desktop/src/main/link/ma2-executor-channel.ts`（2026-11-11）：推杆和推杆页的按键走网页遥控；执行器页 Button 区（101–190）的按键默认走控台插件，和 0.5.8 一样，这时对控台不多连、不多读。操作员在 Button 栏的小菜单里选了网页遥控（每台电脑记住，`runtime/ma2-realtime-preference.ts`）才去试读 Button 区，读回的格号和请求的一致才走网页遥控，否则照旧走插件并写明原因；1–90 和 191 以后的按键一直走插件。通道只因为操作员改选择或重新连接而变，出错不换，演出中也一样（`ma2-channel-rules.test.ts` 守着）。两条通道上松开都会取消还在路上的按下。别处不再自己判断按键走哪条

## 控台页显示什么、能做什么

`apps/desktop/src/renderer/src/link/view-models/ma2-console-page.ts`（2026-11-11）：页结构、网页遥控读回、节目状态和时间码在用的执行器合起来，定每一格显示什么、能不能操作。能不能操作一律问 `showGate`：按键任何时候都能按，改执行器、刷新页面在时间码走的时候等；节目不在停着时横幅一直在。在跑和当前 Cue 只信读回，3 秒没读到新的就算旧的。Button 区的实时状态只在按键走网页遥控时经 `Ma2LiveService.buttonLive` 读（`buttonRead` 的 1 秒缓存、`peek`，只读有执行器的行，窗口在后台不读，不为它登录）；推杆区只在这次运行里点过「连接网页遥控」以后读，没点就对控台什么都不多连。按键先显示按下，失败只红这一格、不重发（`stores/ma2-key-feedback-store.ts`）；推杆 1.5 秒没读回只标黄、照常发。等节目的请求在运行日志里记成等待，不记错误（`link-main.ts` 的 `recordMa2Failure`）

## 网页遥控断了自动重新登录

`apps/desktop/src/main/link/ma2-web-remote-relogin.ts`（2026-11-12）：控台页推杆区和 Button 区两条网页遥控连接，这次运行里连上过、又自己断了的才重新登录，只用存过的用户；等多久和上限只在 `output-recovery.ts`（`MA2_RELOGIN_DELAYS_MS`、`ma2.webRemote.relogin`），节奏和停下的规矩和控台那条线共用 `ma2-relogin.ts`（见下一行）。控台拒绝登录、没存用户、安全存储打不开、Show 变了马上停并写明原因；手动连接让路并清零，换控台或 Show、按键改回控台插件就停；不重发按键和推杆值、不改按键通道、不重新试读 Button 区，“控台在不在跟”那条连接不碰。重新登录期间页脚和格子标黄写第几次，到上限或要人处理才标红；界面只每秒问主进程 `link:ma2-web-remote-state`，自己不重试、不登录（`ma2-web-remote-relogin.test.ts` 守着）

## 演出中控台连接断了自动重新登录

`apps/desktop/src/main/link/ma2-network-manager.ts` 的 `loginOnly`（2026-11-12）：节目不在停着时，联动台和控台之间那条 Telnet 线自己断了，用保存的登录重新登；只登操作员这次运行连上、没自己断开的那台控台。节奏和停下的规矩只在 `ma2-relogin.ts`，网页遥控的两条连接也用它；等多久、上限只在 `output-recovery.ts`（`MA2_RELOGIN_DELAYS_MS`、`ma2.relogin`，一次断线 5 分钟）。登上以后只做登录、释放上次断线留下的插件请求和两条短核对（Show 变没变、插件在不在），不读控台、不同步；演出中不装插件，插件不见了或是旧的记成等待，停了再装（`installDeferred`），这期间关灯和网页遥控照常，走插件的按键、同步和读取等着。控台没开远程登录、保存的密码读不出来、控台软件版本或 Show 变了马上停并写明原因；登录只是没等到回应就接着试（控台可能还在启动）。演出中操作员点连接只限这台控台、只登录，盖过自动的、次数清零；换控台、改连接设置照旧等停止。停着时断了照旧按原来的办法恢复。重新登录时状态标黄写第几次，到上限或要人处理才标红（`view-models/connection-status.ts` 的 `ma2NetworkWaitStatus`），每次都记运行日志。别处不再自己重连控台（`ma2-network-relogin.test.ts` 和 `output-rules.test.ts` 规则 6 守着）

## 欠着的关灯

规则在 `packages/core/src/lighting-off-ledger.ts`（2026-11-11）：停止关这首歌的执行器，换歌只关上一首独有的，正在用的绝不关。全应用一张清单，主人是主进程 `apps/desktop/src/main/link/lighting-off-service.ts`：节目、试听（`link:lighting-off`）、退出时的询问和演出状态都经它；没发出去的留着，控台重新连上后补发 1 次（次数在 `output-recovery.ts`），再按停止全部重发；关灯不过授权。控台确认以后按轮读回灯关了没有（2026-11-11）：只在已经连着的网页遥控会话上读，1–90 只用“控台在不在跟”那条会话，Button 区只在按键选了网页遥控时用 Button 会话，不在推杆页自己的会话上读，不为读回登录；等几秒、读几次只写在 `output-recovery.ts` 的 `LIGHTING_OFF_READ_BACK`；还在运行的标黄不标红，再按停止才重发，没读的不写日志、界面照旧。同一条网页遥控会话上的请求排队轮流发（`ma2-live-playback.ts` 的 `turn`），借别人的会话读只用 `peek`、`peekButtons`：看不懂的回答不关会话。别处不再自己发 Off、不另记“还欠着”

## 整套 Cue 的首次放置

`packages/core/src/lighting-template-steps.ts` 统一展开整套序列，默认每步 1 拍；用户编辑后不再经过这个展开步骤。素材组合保留成员已编辑的相对时间。`apps/desktop/src/renderer/src/link/components/lighting-sequence-placement.test.ts` 检查完整展开、组合时间、逐步编辑和歌曲范围。

## 轨道是否参与灯光

`packages/core/src/lighting-track-state.ts` 统一判断轨道静音与独奏；新歌保留禁用的 Cue 内容，只取消触发，已有时间线使用同一判断。`packages/core/src/ma2-song-sequence.test.ts` 与 `apps/desktop/src/main/link/ma2-layout-service.test.ts` 检查禁用、恢复和读回。

## 新增轨道写到哪里

`packages/core/src/ma2-track-routing.ts` 决定已有绑定内新增轨道的去向，唯一目标登记待写入，歧义明确提示。`packages/core/src/ma2-track-routing.test.ts` 检查归属与未同步统计。

未关联轨道没有 Timecode 归属，不能伪造为第一条绑定的差异。`ma2PendingChanges` 只比较已绑定内容；`ma2TrackRoutingIssue` 在歌曲状态和同步前置检查中说明未关联轨道，仍阻止把遗漏的 Cue 确认为已同步。`ma2-pending-changes.test.ts`、`song-lighting-status.test.ts` 和 `runtime/ma2-bound-song-sync.test.ts` 守住计数不重复、问题可见、未关联内容不误确认。

## 灯光编号换新

`packages/core/src/lighting-ids.ts` 的 `withNewLightingIds`（2026-11-12）：复制歌曲、把灯光导入空白歌曲、追加导入都经同一张编号表换新，轨道、片段、点、组合、标记、段落、控台绑定和基线、控台点一起换，引用跟着换；素材库模板和素材引用不换。配对、待同步和 MTC 区间提示和换之前一样（`lighting-ids.test.ts` 守着）

## 控台连接插件任务的生命周期（2026-11-16）

网络桥空闲时不启动常驻 Lua 定时任务。只有按住 Flash、Temp、Swop 等需要断线自动松开的按键时，`tools/ma2/tblink_bridge.lua` 才启动单次看门任务；有按键仍按住才继续下一次，松开、租约过期、桥换代或停止时释放按键并退出。文件桥的请求轮询同样使用单次任务，停止或换代后不续行。正常的 Go/Goto、同步和读取不新增常驻任务。旧版无限任务的现场清理由诊断确认目标后单独处理，自动连接流程不发送全局 Off、Off Plugin 或 ReloadPlugins，不能影响其他插件。测试：`apps/desktop/src/main/link/ma2-bridge-timers.test.ts`。

## MIDI 选曲隔离

2026-11-17：用户要求播放继续使用 MIDI MTC，只运行当前歌曲，前后定位和共用执行器切歌不串灯。时间区间及原生选曲命令只在 `packages/core/src/ma2-mtc-selection.ts` 编译；辅助 Timecode/Sequence 的创建、备份、复用、读回只在 `apps/desktop/src/main/link/ma2-mtc-selection.ts`。明确连接编辑与两种歌曲同步共用这个服务，播放端不发送网络选曲或逐 Cue 命令。内部目录保留占用编号，但不参与配对、歌曲列表或素材试听。完整规则见 LIGHTING_WORKFLOW.md「2026-11-17 MIDI 播放只选择当前歌曲」。测试由 `packages/core/src/ma2-mtc-selection.test.ts`、`apps/desktop/src/main/link/ma2-mtc-selection.test.ts`、`apps/desktop/src/main/link/ma2-bridge-lua.test.ts` 守住。
