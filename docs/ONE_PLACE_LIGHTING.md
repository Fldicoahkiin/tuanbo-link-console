# 只有一处实现 · 灯光和 MA2

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 怎么认控台

只按编号认，不看 Show 名和 IP（`packages/core/src/ma2-console-identity.ts`）

## 歌和控台时间线怎么配对

只看时间码节目编号和 MTC 起始码（`packages/core/src/ma2-pairing-state.ts`）

## MA2 同步

方式 1、方式 2 和改名走同一个逐首同步、同一份状态（`runtime/ma2-song-sync.ts`、`stores/ma2-sync-store.ts`）

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

## 灯光编号换新

`packages/core/src/lighting-ids.ts` 的 `withNewLightingIds`（2026-11-12）：复制歌曲、把灯光导入空白歌曲、追加导入都经同一张编号表换新，轨道、片段、点、组合、标记、段落、控台绑定和基线、控台点一起换，引用跟着换；素材库模板和素材引用不换。配对、待同步和 MTC 区间提示和换之前一样（`lighting-ids.test.ts` 守着）
