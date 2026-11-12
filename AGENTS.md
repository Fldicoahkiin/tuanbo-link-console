# 团播联动台 · Agent 工作手册

本文是本仓库的最高项目规范，2026-11-06 按 0.5.7 的状态和之前与用户定下的约定整理。所有回复使用简体中文，专有名词保留英文。

灯光、MA2 同步、MTC 时间码和播放相关的规则以 [docs/LIGHTING_WORKFLOW.md](./docs/LIGHTING_WORKFLOW.md) 为准，和本文或其他文档冲突时以它为准。

## 1. 现在的阶段

- 目标：修 bug、做优化、提高稳定性。**稳定性第一。**
- 优先级：直播间的现场反馈最先处理；重要性低的已知问题先不管；官网先不动（2026-10-24）。
- 测试以用户在现场手动测试为主。不排耗时的自动化长测，代码改动用单测、类型检查、lint 和 CI 把关。
- 从根上修。问题反复出现时，先查是不是同一件事有好几份实现（见第 4 节），不在表面打补丁；同类问题一次查全。
- 线上版本和每版改了什么见 [CHANGELOG.md](./CHANGELOG.md)；还在等现场验证的事见 [docs/plan.md](./docs/plan.md) 开头。

## 2. 产品边界

团播联动台由两部分组成：

- **桌面端**（Windows 原生 Electron，`apps/desktop`）：节目单、联动台播放（内部主控）和 P1 跟随、MIDI 时间码和动作 MIDI、内容编辑器和 OBS 场景编排、OBS 实时画布、灯光工作台和 MA2 双向时间线同步、外部程序生命周期、开播前检查、运行日志、诊断包和问题反馈、授权激活和软件更新。
- **服务端**（`apps/licensing-server`，部署在腾讯云服务器）：授权和激活码、支付宝购买、官网、运营后台、问题反馈接口。更新源走腾讯云 CDN。

| 软件 | 负责 |
| --- | --- |
| 团播联动台 | 节目、播放或跟随 P1、时间线、Cue、设备联动和检查 |
| OBS Studio | 正式画面的解码与合成、场景、来源、滤镜、转场和最终音视频输出 |
| grandMA2 | Cue 内容、执行器和灯具；联动台不编辑 Cue 内部的灯具参数 |
| P1 | 可选的外部音乐主控和时间码源 |
| 抖音直播伴侣 | 登录、直播间和推流；联动台只检测进程和主窗口 |

不做的事：

- 不重新引入 Program 窗口、Electron 内置合成、摄像头/麦克风采集、RTMP、NDI、联动台自己的虚拟摄像头或 libobs helper。直播时 OBS 自带的虚拟摄像头要开着，那是 OBS 的功能，和这条无关。
- 不控制 OBS 推流/录像，不控制直播伴侣开播/关播，不自动点击第三方界面。
- 不提权启动 OBS。OBS 以管理员身份运行时照常支持（2026-10-25 用户要求），组件修复后用普通方式重开 OBS。
- OBS 里只在固定前缀的自有场景中创建、更新、移除联动台自己的场景项和媒体输入，再加上实时画布授权的“用户选中的来源”；不修改、不删除用户其他来源。视频解码与合成由 OBS 完成，联动台播放的音频经应用自有的 OBS 音频来源送入正式输出。
- 不迁移旧 ShowPackage。普通工程用 `.tblink` schema v1；带灯光数据的工程用 schema v2，让旧程序拒绝覆盖保存，而不是悄悄丢掉灯光数据。歌里存了节拍、或者歌的音乐后面留了空白的工程用 schema v3（2026-11-11，0.5.9 起；哪些东西要 v3 只在 `packages/schema/src/link-project.ts` 的 `schemaVersion3Reasons` 定，保存前那句话照它说）：0.5.8 和更早的版本打不开，所以第一次把旧文件存成 v3 前先问一次，并把原文件另存为工程旁边的「工程名（旧版本可打开的备份）.tblink」（`apps/desktop/src/main/link/link-project-service.ts`）；备份没存成就不保存。
- 不发任何免激活、免授权的包。测试用用户给的激活码。

### 用户授权和定下的事（新的在前，新的取代旧的）

- **2026-11-11 快捷键照剪映，停止加 Shift+Esc**：用户 11-10 定根因报告第 7 题按推荐做，编辑器和灯光工作台的键照剪映专业版默认（Ctrl+B 分割、Q/W 修剪到播放头、↑↓ 上一个/下一个剪辑点、N 吸附、编辑器的 M 加时间线标记）；首页的键不变，灯光工作台的 M 还是打点，用户改过的 6 个键照旧生效。停止键是 Claude 按 11-11 的授权定的：Esc 照旧停止；Shift+Esc 在哪儿都能停（对话框开着、拖动中、输入框里），是“对话框开着时按键不碰节目”的唯一例外；设置里可以关掉「单按 Esc 停止」，每台电脑记住。按住 Enter 在哪儿都只算一次。见 `docs/KEYBOARD_SHORTCUTS.md`。
- **2026-11-04 内容编辑器重写**：用户授权删掉旧代码，按最佳实现重写，不换剪映或 OpenCut。规则在 `packages/core/src/content-timeline.ts`：机位和素材都是有长度的片段，同一轨道不重叠；拖到被占的位置就在上方新建一条轨道；修剪碰到相邻片段就停住；`visualLayers[0]` 是最上层，上层盖住下层；音效不算画面。OBS 播放、定位和预载按现场实测调过，不重写，只接新规则。
- **2026-11-04 同步方式可选**：写入控台（合并/覆盖/直接写入）、控台上的改动（读回/以联动台为准）、实时同步开关都由用户选，每台电脑记住，见 LIGHTING_WORKFLOW.md「同步方式可选」。
- **2026-11-01 灯光播放只发时间码**：正式播放、编辑器和灯光工作台试听、P1 跟随都只发 MIDI 时间码，由控台按时间码跑灯；“直接发 MIDI”“网络发命令”两种播放方式已删除。“单独运行”和“埋步”不能再新加（2026-11-03 再次确认）。单击 Cue 试听仍直接发这一个 Cue。
- **2026-10-30 画面失败照常播**：要画面的歌先等画面准备好，准备失败也照常放音乐、发时间码，画面标红。控台断线重连后不自动重新读取。
- **2026-10-26 灯光工作流 10 条**：随时可以播放、只按 MTC 起始码配对、联动台和控台用同一条时间线双向同步、新歌放在按钮第 1000 页等，见 [docs/LIGHTING_WORKFLOW.md](./docs/LIGHTING_WORKFLOW.md)。
- **2026-10-24 MIDI 线插回自动恢复**（原话“要”，同日扩展到动作 MIDI，原话“一起恢复”）：联动台播放时，MTC 输出端口或动作 MIDI 输出端口断开后，同一端口重新出现就自动重新打开；时间码从当前播放位置恢复，动作 MIDI 从恢复后的下一个动作照常发送。不补发中断期间错过的动作，不换到别的端口。这是第 4 节第 4 条“不自动重试”的例外。
- **2026-09-14 OBS 实时画布**（原话“允许，按实时双向同步重做”）：允许随软件部署 OBS 原生预览桥，在联动台画布中编辑用户选中的 OBS 已有场景来源并双向同步。不授权删除没选中的来源，不控制推流/录像。见 `docs/OBS_REALTIME_CANVAS.md`。
- **2026-09-13 只用 OBS 场景**：每个机位一个场景，切换沿用已有的显隐、拉腿、裁剪和滤镜；每个素材用独立的自有 OBS 场景，机位片段结束时恢复下层素材；不改其他来源。低功率预览要能开关，不能删掉原有预览。设置里不再有“软件编排”选项。见 `docs/OBS_SCENE_WORKFLOW.md`。
- **2026-09-10 完整场景模式**（对齐用户自研 IBC）：不强制进入受管画面，不重设用户的视觉项；为了让联动台播放的音乐跨场景持续输出，只允许在目标场景加入应用自有的音频项。见 `docs/IBC_PARITY_20260910.md`。
- **2026-09-10 灯光编排和 MA2 双向同步**：允许 MIDI、局域网和配套 Lua 插件，范围是时间线、Cue 引用和执行器动作，不包括 Cue 内部的灯具参数。离线测试不等于实机验收，见 `docs/LIGHTING_MA2_IMPLEMENTATION.md`。
- **2026-09-09 联动台播放（内部主控）**：音频由联动台播放，实际播放位置驱动时间线并输出 MIDI 时间码。保留 P1 跟随。两种方式明确选择，断线时不偷偷切换计时来源，不无音频空跑。

## 3. 仓库布局

```text
apps/desktop/
  src/main/link-main.ts         Electron 主入口与最小 IPC
  src/main/link/                OBS、MA2、MIDI（MidiPortBroker）、播放引擎、授权、更新、日志和反馈等主进程适配器
  src/preload/index.ts          tbLink / tbFile 类型化桥
  src/renderer/src/link/        工作区、组件、stores、runtime 和 view-models
  src/renderer/src/link/ui/     公共组件（Button、Menu、Popover、Dialog 等）
  src/renderer/src/styles/      tokens.css 和 CSS 分层（layers.css）
  src/renderer/src/registry/    音频与 MIDI 适配器（MIDI 经主进程，不用 Web MIDI）
  test-e2e/                     Electron 端到端测试（CI 不跑）
apps/licensing-server/          授权、购买、官网（web/）、运营后台（console/）、部署工具（deploy/）
packages/schema/                .tblink、本机设备设置和授权的 Zod 契约
packages/core/                  Command、MTC、Cue、灯光与 MA2 规则、内容时间线等领域逻辑
tools/                          原生组件：播放引擎、OBS 预览桥和美颜、MA2 Lua 桥、IBT、进程识别等
scripts/                        发版、搬运、校验和更新日志脚本
release-notes/                  每个版本更新日志的唯一来源
docs/                           设计、实施、验收和服务器安装说明
.github/workflows/              CI、发版和官网同步
```

## 4. 架构硬约束

1. 所有 LinkProject 修改必须封装为 `LinkCommand` 并经 `useDocumentStore.execute(command)`；组件禁止直接改工程对象。
2. 分层方向固定为 Schema/Domain → Registry/Adapters → Stores/Runtime → Components → 最小 IPC，不得倒流。
3. IPC 只传已定义的 DTO，不承载 Cue、时间码、开播前检查等业务判断。
4. 外部边界错误必须明确返回、展示并记录；禁止静默 fallback、吞异常、自动重试，或在联动台播放和 P1 跟随之间自动切换。例外只有用户授权并写进文档的几处：第 2 节的 MIDI 端口恢复，LIGHTING_WORKFLOW.md「同步规则」里的重试，以及 2026-11-10 用户定的“有次数上限的自动恢复”（声卡、时间码、画面：画面按此刻该有的样子补一次、后面的素材再准备一次、素材和音乐对不上时校正；OBS 自己断了自动重连、连上后按当前位置恢复画面；控台页的网页遥控断了用保存的用户重新登录），次数和等多久只写在 `packages/core/src/output-recovery.ts`，每次都记运行日志并在界面上写明（输出出错标红；还在重连、重新登录时算等待，写第几次，到上限才标红），到上限就停下等人处理；点 Cue、按键和推杆值不重发。
5. OBS 请求默认 2 秒超时；外部程序只能按精确路径、PID、启动时间和所有权管理。
6. 只关闭本次由联动台启动的进程；对方拒绝关闭时保留进程，绝不强杀。
7. 工程不保存密码、MIDI 端口名或外部程序绝对路径，这些放本机设备设置。OBS 密码只用 Electron `safeStorage`，不可用时不降级存明文。
8. 排练时第一个失败的动作挡住后续动作，不自动补；直播时失败标红但继续，画面只按第 4 条的例外在 `output-recovery.ts` 的次数内自动补，其余不自动重试。
9. P1 跟随时 MTC 丢失或异常跳变冻结自动 Cue。手动模式要明确重同步；用户授权的 P1 自动选歌模式允许从 P1 点击切歌或重播启动新会话，同位置继续则恢复并定位视频。未知区间或中途跳变不猜、不补执行。
10. 禁止 `any`、`as any`、`eslint-disable`、空 `catch` 和补丁式兼容分支。

### 同一件事只有一处实现（2026-10-29 架构复盘）

问题反复出现的根因是同一件事有好几份实现：灯光同步两套、时间码三条发送路径、能不能播放五处判断。下面每件事只在一处决定，新功能复用它们，不另开一条路：

| 事情 | 唯一的地方 |
| --- | --- |
| 开一首歌做什么 | `packages/core/src/program-start.ts`。只有没有音频的歌放不了，其余都只是某一路输出参不参加 |
| 时间码怎么发 | 原生播放引擎一条路径，从歌曲的 MTC 起始码发（`packages/core/src/native-program-snapshot.ts`） |
| 怎么认控台 | 只按编号认，不看 Show 名和 IP（`packages/core/src/ma2-console-identity.ts`） |
| 歌和控台时间线怎么配对 | 只看时间码节目编号和 MTC 起始码（`packages/core/src/ma2-pairing-state.ts`） |
| MA2 同步 | 方式 1、方式 2 和改名走同一个逐首同步、同一份状态（`runtime/ma2-song-sync.ts`、`stores/ma2-sync-store.ts`） |
| 执行器按键和推杆走哪条通道 | `apps/desktop/src/main/link/ma2-executor-channel.ts`（2026-11-11）：推杆和推杆页的按键走网页遥控；执行器页 Button 区（101–190）的按键默认走控台插件，和 0.5.8 一样，这时对控台不多连、不多读。操作员在 Button 栏的小菜单里选了网页遥控（每台电脑记住，`runtime/ma2-realtime-preference.ts`）才去试读 Button 区，读回的格号和请求的一致才走网页遥控，否则照旧走插件并写明原因；1–90 和 191 以后的按键一直走插件。通道只因为操作员改选择或重新连接而变，出错不换，演出中也一样（`ma2-channel-rules.test.ts` 守着）。两条通道上松开都会取消还在路上的按下。别处不再自己判断按键走哪条 |
| 控台页显示什么、能做什么 | `apps/desktop/src/renderer/src/link/view-models/ma2-console-page.ts`（2026-11-11）：页结构、网页遥控读回、节目状态和时间码在用的执行器合起来，定每一格显示什么、能不能操作。能不能操作一律问 `showGate`：按键任何时候都能按，改执行器、刷新页面在时间码走的时候等；节目不在停着时横幅一直在。在跑和当前 Cue 只信读回，3 秒没读到新的就算旧的。Button 区的实时状态只在按键走网页遥控时经 `Ma2LiveService.buttonLive` 读（`buttonRead` 的 1 秒缓存、`peek`，只读有执行器的行，窗口在后台不读，不为它登录）；推杆区只在这次运行里点过「连接网页遥控」以后读，没点就对控台什么都不多连。按键先显示按下，失败只红这一格、不重发（`stores/ma2-key-feedback-store.ts`）；推杆 1.5 秒没读回只标黄、照常发。等节目的请求在运行日志里记成等待，不记错误（`link-main.ts` 的 `recordMa2Failure`） |
| 网页遥控断了自动重新登录 | `apps/desktop/src/main/link/ma2-web-remote-relogin.ts`（2026-11-12）：控台页推杆区和 Button 区两条网页遥控连接，这次运行里连上过、又自己断了的才重新登录，只用存过的用户；等多久和上限只在 `output-recovery.ts`（`MA2_RELOGIN_DELAYS_MS`、`ma2.webRemote.relogin`）。控台拒绝登录、没存用户、安全存储打不开、Show 变了马上停并写明原因；手动连接让路并清零，换控台或 Show、按键改回控台插件就停；不重发按键和推杆值、不改按键通道、不重新试读 Button 区，“控台在不在跟”那条连接不碰。重新登录期间页脚和格子标黄写第几次，到上限或要人处理才标红；界面只每秒问主进程 `link:ma2-web-remote-state`，自己不重试、不登录（`ma2-web-remote-relogin.test.ts` 守着） |
| 顶栏和各处显示的状态 | `view-models/status-center.ts` |
| 内容时间线的放置、移动、修剪 | `packages/core/src/content-timeline.ts` |
| 拖动、修剪时落在哪 | `apps/desktop/src/renderer/src/link/components/drag-preview.ts`（2026-11-11）：按下时拍一份快照（时间线在屏幕上的位置、每条轨道的位置、吸附点），之后每帧用 `dragTarget`、`trimTarget` 算一次，直接写到页面上，松手才发一条命令；放置和修剪的规则仍只在 `content-timeline.ts`。音频片段、灯光点的拖动和框选用 `useFramedDrag` 每帧算一次。拖着的时候给人看的提示也在这里每帧算、直接写到页面上：吸附线和它的颜色（`snapGuideAt`）、修剪时的时长和碰到边界（`trimFrame`）、要不要提示「放到新轨道」（`showsNewTrackAbove`）、拖到左右边上自己滚（`EdgeScroll`，经 `useTimelineViewport` 的 `scrollLeftTo` 滚）。按住 Alt 不吸附从指针事件的 `altKey` 读，不听按键；播放中不吸播放头；吸附关着或按住 Alt 时仍落在整帧上。编辑器的吸附开关记在这台电脑（`stores/timeline-view-store.ts`），以后时间线的界面偏好也放这里。不再用 `elementFromPoint` 找轨道，不在每次鼠标移动时更新 React 状态（`drag-preview.test.ts` 和 `editor-rules.test.ts` 规则 10 守着） |
| 时间线滚动到哪 | `apps/desktop/src/renderer/src/link/components/timeline-scroll.ts`（2026-11-11）：滚动位置在 React 外（`TimelineScroll`），只由 `useTimelineViewport` 写；React 只在滚过 512 px 时知道，按那一格的窗口（`view`）决定画哪些。要精确跟着滚动的东西（播放头上的时间、贴在左边的名字、拖着的片段）用 `useScrollPaint` 直接写到页面上；页面上的部件都按 `timeline-geometry.ts` 的 `timeToX` 定位，节拍小旗只画窗口里的、相邻至少 8 px（`beatMarksInView`）。不再把滚动位置放进 React 状态 |
| 实时画布多久取一帧 | `apps/desktop/src/renderer/src/link/components/obs-live-frames.ts`（2026-11-11）：平时每秒 30 帧，时间线上在拖动、修剪、滚动、缩放时约 10 帧，停手 300 ms 后恢复，在画布上拖来源时不设上限；一次只有一个请求在路上，失败不自己重试。时间线在不在动只由 `timeline-motion.ts` 记，别处要让画布降帧就向它报告，不另做一套节流 |
| 某一帧该显示什么 | `packages/core/src/scene-output-timeline.ts` 的 `pictureAt`（2026-11-11）：上层盖住下层，机位是整个画面，音效不算画面，没有画面时留着最后结束的机位；显示来源按自己的区间开着。正式播出（`at`）、离线预览（`picture`）、时间线变暗（`airtime`）、预载和编辑器舞台（`TimelineStateIndex`）都从它读，类型在 `on-air-picture.ts`。别处不再自己判断哪段素材在画面里（`output-rules.test.ts` 规则 1 守着）。输出放不了的片段（没分轨道、素材不存在）由 `collectManagedMediaTimeline` 列出原因：编辑器照常打开，开播前检查和正式播放照旧挡住 |
| MIDI 端口的开关 | 主进程 `midi-port-broker.ts`。界面不用 Web MIDI：`navigator.requestMIDIAccess` 会占住电脑上全部 MIDI 端口，Windows 报错误 7 或 4 |
| 动作 MIDI 晚到怎么办 | `packages/core/src/midi-late-rule.ts`（2026-11-10）：Program Change、Control Change 照发并标红，Note On、MSC Go 晚 100 ms 以上只跳过这一条，Note Off、MSC Stop 总是发；一条失败不停整路 |
| OBS 请求谁先发 | `apps/desktop/src/main/link/obs-request-scheduler.ts` 的档位和 `pump`：切画面的请求单独一档，始终有位置；截图等画面发完再发 |
| 自己恢复几次算到头 | `packages/core/src/output-recovery.ts` 一张表（2026-11-11）：声卡 1 分钟断流 5 次停这首歌，时间码一首歌失败 3 次这首歌不再发，等等。别处不写重试次数；每次恢复都标红、记日志 |
| 画面失败怎么分级、补不补 | 分级只在 `packages/core/src/obs-program-session.ts` 的 `verdictOf`（2026-11-11）：做到了、撤回了、OBS 拒绝了、不确定（没回应，或发出去以后失败）。补不补只由 `packages/core/src/picture-reconcile.ts` 的 `judge` 定：失败的和不确定的都按此刻该有的画面补一次，排练时不补，OBS 断着时不补、不花次数；次数照上一行那张表，发出去那一刻才计数。每一项的状态列在 `NativeObsStatus.items`，状态面板「这首歌的画面」照着显示（`view-models/status-center.ts` 的 `pictureStatus`）。别处不自己重发画面动作（`output-rules.test.ts` 规则 2–4 守着） |
| OBS 断了怎么重连、回来以后怎么恢复画面 | 重连只在 `apps/desktop/src/main/link/obs-reconnector.ts`（2026-11-12）：操作员手动连上过、又不是自己断开的才重连（从联动台关 OBS、修复组件、退出都算自己断开），等多久和几次照 `output-recovery.ts` 的 `obs.reconnect`，到上限标红等人点连接；手动连接和自动重连共用 `link-main.ts` 的同一个连接函数（`connectWith`，密码只读 `safeStorage`），操作员的连接和断开优先，不启动 OBS、不提权。恢复画面只在 `native-obs-host.ts` 的 `reconnected()`：先补回自有场景，再按当前位置重建（暂停时素材对好位置、保持暂停），断线时没准备好的歌不取消、照常开播，OBS 回来后重新准备再接上，一首歌最多 `obs.restore` 5 次；OBS 断着时画面算等待（`obs.connection`），不补、不花次数。别处不再自己重连 OBS，也不因为重连去定位节目（`output-rules.test.ts` 规则 5 守着） |
| 欠着的关灯 | 规则在 `packages/core/src/lighting-off-ledger.ts`（2026-11-11）：停止关这首歌的执行器，换歌只关上一首独有的，正在用的绝不关。全应用一张清单，主人是主进程 `apps/desktop/src/main/link/lighting-off-service.ts`：节目、试听（`link:lighting-off`）、退出时的询问和演出状态都经它；没发出去的留着，控台重新连上后补发 1 次（次数在 `output-recovery.ts`），再按停止全部重发；关灯不过授权。控台确认以后按轮读回灯关了没有（2026-11-11）：只在已经连着的网页遥控会话上读，1–90 只用“控台在不在跟”那条会话，Button 区只在按键选了网页遥控时用 Button 会话，不在推杆页自己的会话上读，不为读回登录；等几秒、读几次只写在 `output-recovery.ts` 的 `LIGHTING_OFF_READ_BACK`；还在运行的标黄不标红，再按停止才重发，没读的不写日志、界面照旧。同一条网页遥控会话上的请求排队轮流发（`ma2-live-playback.ts` 的 `turn`），借别人的会话读只用 `peek`、`peekButtons`：看不懂的回答不关会话。别处不再自己发 Off、不另记“还欠着” |
| 节目现在在哪一步、这时能做什么 | 规则在 `packages/core/src/show-state.ts` 的 `showGate`，状态由主进程 `apps/desktop/src/main/link/show-state-service.ts` 算（2026-11-11），界面只照着显示（`stores/show-state-store.ts`）。新的“播放时不能做”都问它，不再各处自己判断“在不在播放” |
| 后台节目会话和工程版本 | 主进程 `apps/desktop/src/main/link/native-program-service.ts`（2026-11-11）：一个窗口页面一个长期的节目，页面第一次打开时检查授权，之后每一路输出照旧各自过授权。修改只经 `link:native-program-document` 送新的一版（界面 `runtime/program-document-feed.ts`）：一次只有一个在路上；开歌前先送最新一版，上一次没送进去的也在这时再送一次，别的时候不自己重送。一版只带改过的歌、删掉的歌、顺序和工程自己的字段（`packages/core/src/project-version-change.ts`，按是不是同一个对象来比），主进程只拼在它手里最新的那一版上，对不上就答复重送、界面整份送一次；增量和整份过同一套检查（每首歌和工程字段的 schema、整个工程的关系、和打开节目一样的文件检查）。整份在自己的 worker 里编码（`stores/project-codec.ts` 的 `programDocumentCodec`），不和保存排队。会开歌的控制等它前面的版本，停止和复位不等、并让还在等的开歌作废（主进程 `entry.turn`、界面 `turn`；哪些算开歌只在 `packages/schema/src/native-program.ts` 的 `nativeProgramStartsSong`）。拿着歌时新的一版当场用上，哪些马上生效见下一行。版本按 (sessionId, revision) 认，节目事件带着最新的版本和画面在播的版本（`pictureVersion`），窗口靠它知道在播哪一版（`program-attachment.ts`）；事件序号由服务统一往上数，同一页换了节目也接得上。播放器上的选择不随修改变；声卡按一轮播放固定（`packages/core/src/native-program-player.ts` 的 `runOutput`）。只有换工程或路径、上次打开失败、退出取消以后才重新打开节目，别处不再因为工程变了就关掉重开（`program-session-rules.test.ts` 守着） |
| 拿着歌时改工程 | `packages/core/src/live-revision-effect.ts` 的 `liveRevisionEffect`（2026-11-12）：联动台播放拿着的歌（准备中、在播、暂停、播完停住）照开始那一版放，音频、时间码、画面和动作 MIDI 都按那一版，定位和循环回来也是。新的一版里只有三样当场生效：它保存的音量、它自己的「播完后」、它的灯光会用到的执行器（只增不减，停止时关所有版本用过的，`lighting-off-ledger.ts` 的 `litAlso`、`widen`）。下一首按最新一版找、按最新一版放；提前准备按内容认、不按版本号（`native-audio-preload.ts` 的 `audioIdentity`、`native-obs-preload.ts` 的 `resourceKey`），改别的歌不会让下一首重新准备。台上那首歌的音频本身（`songAudioStructureKey`：音频文件和片段、总长、播放范围、MTC 起始码）、删除和停用要等它停下：界面的仓库在提交前问 `showGate`（`stores/document-store.ts` 的 `stageWait`，撤销和重做也问），只在联动台播放时拦，P1 跟随照旧；就算送到主进程也不碰音频和起始码，只写日志。要播的歌在最新一版里已经删掉或停用就不播，在播的照常（`NativeProgramPlayer.play`）。别处不再因为工程变了去停歌、重开，或者自己判断哪些改动能当场生效（`live-edit-rules.test.ts` 守着） |
| 按键谁来处理 | `apps/desktop/src/renderer/src/link/keys/`（2026-11-11）：窗口上只有 `key-router.ts` 一个按键监听，一次按键归谁由 `key-route.ts` 的 `routeKey` 按“输入框、弹窗、拖动、页面、全局”的顺序定，键位在 `keymap.ts` 一张表。组件自己用的键用 `ownKeys` 声明；Esc 能关的面板、菜单和列表用 `useKeyOverlay` 登记，由路由关最上面那一个，自己不听 Esc；拖动用 `useDragSession`（Esc 能取消）或 `useCapturedDrag`（边拖边写、取消不了）登记，拖动中的 Esc 和会改工程的键由路由拦，拖动自己不听按键（都由 `key-routing-scan.test.ts` 守着）。键位和规则见 `docs/KEYBOARD_SHORTCUTS.md`：Esc 照旧停止，Shift+Esc 在哪儿都能停，按住 Enter 只算一次，编辑器和灯光工作台照剪映（`key-routing-rules.test.ts` 守着这几条）。不再往 window 或 document 上新加 keydown 监听：`eslint.config.mjs` 的 `KEY_LISTENER_RESTRICTIONS` 在 `link/keys/` 以外拦 `addEventListener('keydown'|'keyup')`、`onkeydown =` 和 `onKeyDownCapture`，`key-routing-scan.test.ts` 用同一份规则扫源码，并要求有 `onKeyDown`、`onKeyUp` 的文件用 `ownKeys` 声明自己的键；组件的按键处理里不用 `stopPropagation`，只有祖先元素也处理同一个键时才留（比如菜单经 portal 冒泡）。时间线的按键也在路由上（2026-11-11）：编辑器和灯光工作台的时间线键用 `useKeyCommands` 登记到各自的范围；编辑键作用在哪一样东西、剪辑点和修剪到播放头在 `components/timeline-commands.ts`；用户改的键见下一行 |
| 用户改的键 | `apps/desktop/src/renderer/src/link/keys/key-settings.ts`（2026-11-11）：哪些键能改、撞键怎么算、随时停止的键能是什么、歌曲快捷键的检查都在这里。只存改过的，在这台电脑 `localStorage` 的 `tblink.key-overrides`；0.5.8 的 `tblink.timeline-shortcuts` 只读一次来搬，不再写，退回 0.5.8 时它还在。状态在 `stores/shortcut-store.ts`，由 `keymap.ts` 的 `resolveKeymap` 放进键位表，路由和界面上的键名都读 `currentKeymap`。新加一个能改的操作只要在键位表里标 `rebindable: true` |
| 一首歌的节拍 | `packages/core/src/song-beats.ts` 的 `songBeats`（2026-11-11）：每首歌一份，按音乐的源文件存在 `rundownItem.music`，编辑器和灯光工作台都从它读，经音频片段换算到歌曲时间，剪切、移动音频不用重新识别。只用 `setSongMusicCommand` 改；旧工程的两种节拍只在 `document-store.setProject` 打开时搬一次（`song-music-migration.ts`）。显示疏密只在显示时定，不存进工程；包络分析（“分析音乐”）不出节拍。识别是编辑器和灯光工作台共用的一次（`components/useMusicBeatSegments.ts`，按歌记着，哪一页看到结果就写一次）；节拍的写入在播放中或运行时在忙时都等停了再写。没装识别组件的电脑才给“简易检测”（IBT），点了才跑，写入守同一条规矩；编辑器不再有自己的检测。编辑器吸附的节拍只在 `components/timeline-snap-points.ts` 的 `songBeatSnapPoints` 算：当前疏密下显示出来的节拍加段落的边，看得见的才吸，按下时放进拖动和修剪的快照；灯光工作台照旧吸全部节拍（`editor-rules.test.ts` 规则 7、8、9 守着） |
| 波形 | 主进程 `apps/desktop/src/main/link/waveform-service.ts`（2026-11-11）：一次解码出多级峰值、45–180 Hz 节奏波形和频谱（`waveform-levels.ts`），按 sha256 存在工程的 `cache/waveforms/<sha>.levels.bin`；`<sha>.json` 照旧写成 0.5.8 能读的纯数组，不改它的格式。界面只用 `useSongWaveform` 拿、`WaveformCanvas`（`view-models/waveform-draw.ts`）画，不解码整首音频，不引入波形库（`editor-rules.test.ts` 规则 5 守着） |
| 一首歌多长 | `packages/core/src/audio-edit.ts` 的 `songDurationMs`（2026-11-11）：存了总长（`referenceAudio.timeline.durationMs`，音乐后面留了空白）就用它，否则到最后一段音频的结尾。前后空白读 `songLeadBlankMs`、`songTailBlankMs`，改片段以后的总长用 `editedSongDurationMs`（空白不会被改片段吃掉，片段拖过总长歌就变长），加空白用 `padAudioTimeline`（按工程帧率取整到帧）。音频只由主进程 `audio-edit-service.ts` 的 `mix` 渲染到这个长度，尾空白是真的静音采样；`referenceAudio.durationMs` 等于歌曲总长，schema 守着。没存总长的歌，缓存名和渲染结果和 0.5.8 逐字节一样。别处不再自己取“最晚片段的结尾”当歌的长度 |
| 一首歌前后的空白 | `packages/core/src/song-padding.ts` 的 `padSongCommand`（2026-11-11）：一条命令、一步撤销。音频先渲染好（`padSongRender` 给主进程渲染的参数）再交进来，对不上就不写。内容按整帧挪（`content-timeline.ts` 的 `shiftContent`），音频和灯光按同样帧数的毫秒挪（`lighting-shift.ts` 的 `shiftLightingDocument`：节拍锁定的片段换成时间锁定、带节拍锚点）；MTC 起始码、控台时间线的起点和 MA2 基线不动，差异按普通改动改写控台一次。能去掉多少空白只由 `songPaddingRoom` 算，碰到最早或最晚的内容就停。P1 跟随的工程不能用。别处不自己整首平移（`song-padding-rules.test.ts` 守着） |

同一次复盘定下的另外几条：

- 能算出来的状态（配对、待同步、控台在不在跟）每次重新算，不存进工程，工程里存的旧配对不参与判断。
- 状态要闭环。显示“已连接”“已发出”“在跟”要有读回的依据；读不到就写“无法确认”和原因，不把“命令发出去了”当成功（`packages/core/src/console-follow.ts`）。
- 等待不算失败。断线、播放中、编辑中都只是等待；一首歌失败就停在这首歌上并写明原因，不挡其他歌，不锁死整个同步，也不一直转圈。

## 5. 代码与界面

- TypeScript 严格模式，穷举 discriminated union，跨边界用 Zod 校验。
- 图标用 `lucide-react`，16px、线宽 1.5，禁止 Emoji 图标。
- 用户能看到的文案按 [docs/UI_COPY_GUIDE.md](./docs/UI_COPY_GUIDE.md) 写：先说发生了什么，再说怎么办，用日常说法，不出现代码里的概念。代码里会比较的字符串改之前先搜一遍。
- 样式按 `@layer base, legacy, components, pages` 分层（`styles/layers.css`），不靠导入顺序覆盖，不新加 `!important`。颜色、字号、间距、圆角只用 `styles/tokens.css` 里的变量（`--color-*`、`--type-*`、`--space-*`、`--radius-*` 等），不写死。`legacy` 层只删不加。
- 新组件和改过的页面用 `link/ui/` 的公共组件。菜单和浮层经 portal 挂到页面根上：`.app-workspace` 有 `contain`，不 portal 会错位。
- 视觉规则（2026-11-03 用户选“精修”，规则来自 heydamir/unslop，作者 Damir Sokolovsky，CC BY 4.0）：4px 间距网格；三种文字层级；一个强调色（蓝）；字重 400 和 500，时间码读数保留 600；圆角 4、8、12；一条缓动曲线；不用光晕、渐变和毛玻璃。保持深色底和系统字体。
- 现场密度：1280×720 要能正常用。编辑器时间线工具栏一行放得下，首页节目单五首不用滚动，灯光工作台时间线至少留 260px。
- 正式界面任务应加载 `frontend-design` skill（仓库 `.agents/skills/` 里另有设计类 skill）；TypeScript 任务应加载项目要求的 TypeScript skill。不可用时明确说明并遵循现有设计系统，不得假装加载。
- 不创建 `_v2`、`_new`、`_fixed`、`_enhanced`、`_refactored` 等后缀的文件或符号。
- 修改 preload 或主进程后必须完整重启 `pnpm dev`，不能只刷新页面。

## 6. 测试与验证

- 推 master 前跑 `pnpm typecheck`、`pnpm test`、`pnpm lint`。`pnpm lint` 自己带 4 GB 的内存上限（根目录 `package.json`）：整个仓库一起做带类型的检查要 2 GB 以上，Node 默认的上限在 GitHub 的 runner 和云端容器里不够。lint 报 exit 134、日志开头是 `Last few GCs` 就是内存用完了，不是代码问题，调大这个数，不删 lint 规则。
- 规则测试守着用户定下的规则，例如 `packages/core/src/lighting-workflow-rules.test.ts` 对应灯光 10 条。改代码让它们失败就是违反了规则，不能靠改测试过关。
- CI：推 master 后 Verify Desktop 跑类型、lint、正式模式构建和 Windows 单测（约 25 分钟）；Verify Licensing Server 跑服务端测试并自动部署授权服务、官网和后台。只改文档不触发。
- Electron e2e 不在 CI 里，按需在本机跑；依赖真实设备的用例被跳过，不代表硬件通过。
- 云端 Linux 容器里：Node 用 25.8.2（和 CI 一致）；`pnpm test` 里的 `node tools/ibt/build.mjs` 只能在 Windows 跑，改用 `pnpm test:release` 加 `pnpm exec vitest run`；`ibt-beat-service`、`obs-live-install`、`obs-plugin-deployment`、`windows-powershell` 四个测试文件在 Linux 上固定失败约 10 个，没碰它们时以 Windows CI 为准。
- 文档和回复要分清“已实现”“自动化验证通过”“本机联调”和“现场实机验证”。没在现场 Windows 和实体 MA2 上试过的，写明“未实机验证”。

现场排查先想到这些：

- MIDI 打不开、报错误 7 或 4：接口被占用（别的程序，或联动台把同一接口设成了两种用途），不是驱动坏。
- 一键连接认不出 OBS、画面读取报 EPERM：先看 OBS 是不是以管理员身份运行，组件有没有修复到新版。
- 显示已连接却不出灯：先看“控台没在跟”的提示，再核对控台的时间码读数和 TC Slot。
- 先要日志和诊断包，按证据定位；诊断包里按 `device=资源` 能看到各进程的内存和句柄采样。

## 7. Git、更新日志与发版

- 代码以 GitHub master 为准。改完、检查通过就提交并直接推 master，不开 PR。推之前先合并最新 master（Website Release 会以 github-actions[bot] 往 master 提交 `release.json`），推完盯到 CI 全绿。
- 提交用 Conventional Commits，不加任何 AI 署名，不写 Co-Authored-By。Claude 的提交作者用 `Claude <noreply@anthropic.com>`，不要沿用上一条提交的 github-actions[bot]。
- 不覆盖用户已有的修改，脏工作区先报告。不强推，不用 `git reset --hard`，不删分支。
- 删除文件用 `trash`，禁止 `rm` 及其任何变体；删源码用补丁。
- 更新日志只手写 `release-notes/X.Y.Z.md`（写法见 [release-notes/README.md](./release-notes/README.md)）；GitHub Release、CHANGELOG.md、官网下载页和软件内的更新日志都从它生成。用户能感觉到的改动，在同一个提交里给下一版的文件加一条，再运行 `pnpm changelog`。
- 发版由 Claude 自己做完，不让用户动手（2026-10-27）：
  1. 确认 `release-notes/X.Y.Z.md` 写全；改根目录和 `apps/desktop` 两个 `package.json` 的版本号，运行 `pnpm changelog`，提交 `chore(release): X.Y.Z` 推 master。
  2. CI 通过后用 GitHub API 触发 Release Windows（`workflow_dispatch`，ref 选 master 或 `release/X.Y.Z`，`commit` 填 40 位提交号），tag 由工作流自己打（`scripts/tag-release.mjs`）。推 `vX.Y.Z` 标签也能发。
  3. 之后自动：GitHub 云端打包签名 → 草稿 Release → 工位电脑计划任务 `tblink-relay` 搬运（只传变化的部分）→ 服务器校验后上线 → 草稿转正式 → Website Release 更新官网。
  4. 工位电脑不在线时，在 Mac 上跑 `pnpm release:relay`，重复运行是安全的。
- **版本里放什么、什么时候发由用户定**（2026-11-10）：不自己分版本排计划；用户说哪些要完成就做哪些，做完报告，用户说发才发。
- **版本号不跳号**（2026-10-26）：tag 打了但打包失败、没发布出去的版本，修好后在修复提交上重新触发，tag 自动挪过去，版本号不变。
- 完整流程图和排查表见 README「发布与部署链路」和 [docs/RELEASE_CHAIN.md](./docs/RELEASE_CHAIN.md)。

## 8. 机器、凭据和生产环境

| 机器 | 用途 |
| --- | --- |
| Mac（用户本机） | 主力开发机，检出在 `/Users/mac/WorkSpace/Electron_Project/tuanbo-link-console`，凭据在 `~/.config/tblink-remote/` |
| 服务器 `tblink-server`（腾讯云 Ubuntu） | 授权服务、官网、运营后台和更新源 |
| 工位电脑 `win`（DESKTOP-2C8JIC2） | 只做开发辅助和发版搬运 |
| 直播间电脑 | 真实环境，接实体 MA2；只能 ToDesk 远程，不配 SSH 和 Tailscale，测试由用户手动做 |

- 凭据只通过 `ssh -F ~/.config/tblink-remote/ssh_config <host>` 和 `gh` 使用；不读取、不打印、不复制密钥内容，不把凭据带到其他机器。不加 `-F` 的 `win` 是另一台电脑，不要碰。
- 生产服务器的任何改动先写 `docs/SERVER_INSTALL_*.md`（备份、验证、回退），用户确认后再装，装完补「安装结果」。部署工具或 Nginx 有改动时，先装到服务器再推 master，否则部署以摘要不一致被拒绝。
- 资金操作、账号密码和系统设置由用户本人做。激活码、后台账号密码不存文件。
- 工位电脑上通过 SSH “移到回收站”会直接永久删除，要删的东西挪到 `D:\待删除-…\`，由用户来删。
- 不用 Cloudflare 做 CDN 或代理（只做 DNS 解析，怕超额账单）。下载走腾讯云 CDN，已设用量封顶。

## 9. 和用户协作

- 先说结论，再说要用户做什么。用白话，不堆术语。
- 能自己做完的流程（发版、搬运、盯 CI、查日志）自己做，不把步骤丢给用户。
- **只把总的决策交给用户**（2026-11-11，原话“需要我确定的只是那种总的那种决策上，一切以最后的效果为主，有些你可以自己做决定”）：发不发版和什么时候发、加或砍一个功能、会改变现场操作习惯的事、要动服务器或花钱的事，交给用户定。其余细节按最后的效果自己定，定了什么写下来让用户能看到，不为它停下来等回复；用户说不对就改。
- 需要用户决定的事：给出建议和理由，一次问清楚。
- 改工作流、大重构或现场问题的大修，先给根因和计划，用户确认后再动代码；明确的 bug 直接修。
- 本文和 LIGHTING_WORKFLOW.md 里带日期的决定是用户已经定过的，不要再问一遍，也不要悄悄改回去。用户定了新的长期规则，就把它写进这里或对应文档。

## 10. Windows 命令

| 目的 | 命令 |
|---|---|
| 安装 | `pnpm install --frozen-lockfile` |
| 开发 | `pnpm dev` |
| 类型检查 | `pnpm typecheck` |
| 单测 | `pnpm test` |
| Lint | `pnpm lint` |
| 构建 | `pnpm build` |
| Electron e2e | `pnpm --filter @tb/desktop test:e2e` |
| 完整校验 | `pnpm verify` |
| Windows 发布校验 | `pnpm verify:release` |
| 更新日志 | `pnpm changelog` |
| 发版搬运 | `pnpm release:relay` |

发布与真实联调必须在 Windows 原生 PowerShell 环境执行，不使用 WSL 替代。

## 11. 文档

- [README.md](./README.md)：安装、使用、产品边界和「发布与部署链路」。
- [docs/LIGHTING_WORKFLOW.md](./docs/LIGHTING_WORKFLOW.md)：灯光工作流 10 条、同步规则和在代码里的落点，灯光相关改动以此为准。
- [docs/UI_COPY_GUIDE.md](./docs/UI_COPY_GUIDE.md)：界面文案规范。
- [docs/KEYBOARD_SHORTCUTS.md](./docs/KEYBOARD_SHORTCUTS.md)：键位表、停止键和按住 Enter 的规则、和剪映不一样的地方。
- [docs/RELEASE_CHAIN.md](./docs/RELEASE_CHAIN.md)：发版标准流程；[release-notes/README.md](./release-notes/README.md)：更新日志写法。
- `docs/SERVER_INSTALL_*.md`：每次服务器改动的安装说明和安装结果。
- [docs/OBS_SCENE_WORKFLOW.md](./docs/OBS_SCENE_WORKFLOW.md)、[docs/OBS_REALTIME_CANVAS.md](./docs/OBS_REALTIME_CANVAS.md)：OBS 画面规则。
- [docs/DESIGN_BASELINE.md](./docs/DESIGN_BASELINE.md)：早期设计与执行规则，和后来的授权冲突时以本文第 2 节为准。
- [docs/plan.md](./docs/plan.md)：阶段、完成状态和还在等现场验证的事。
- [docs/link-console-reference-study.md](./docs/link-console-reference-study.md)：S3/IBC 差距矩阵与吸收结论。
- [docs/WINDOWS_ACCEPTANCE.md](./docs/WINDOWS_ACCEPTANCE.md)：Windows 发布和真实联调验收记录模板。
