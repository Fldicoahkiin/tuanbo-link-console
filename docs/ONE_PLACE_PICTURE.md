# 只有一处实现 · 画面（OBS）

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 实时画布多久取一帧

`apps/desktop/src/renderer/src/link/components/obs-live-frames.ts`（2026-11-11）：平时每秒 30 帧，时间线上在拖动、修剪、滚动、缩放时约 10 帧，停手 300 ms 后恢复，在画布上拖来源时不设上限；一次只有一个请求在路上，失败不自己重试。时间线在不在动只由 `timeline-motion.ts` 记，别处要让画布降帧就向它报告，不另做一套节流

## 某一帧该显示什么

`packages/core/src/scene-output-timeline.ts` 的 `pictureAt`（2026-11-11）：上层盖住下层，机位是整个画面，音效不算画面，没有画面时留着最后结束的机位；显示来源按自己的区间开着。正式播出（`at`）、离线预览（`picture`）、时间线变暗（`airtime`）、预载和编辑器舞台（`TimelineStateIndex`）都从它读，类型在 `on-air-picture.ts`。别处不再自己判断哪段素材在画面里（`output-rules.test.ts` 规则 1 守着）。输出放不了的片段（没分轨道、素材不存在）由 `collectManagedMediaTimeline` 列出原因：编辑器照常打开，开播前检查和正式播放照旧挡住

## 素材在 OBS 里的样子

换算只在 `packages/core/src/media-obs-transform.ts` 的 `obsMaterialPresentation`（2026-11-12）：编辑器舞台、开播前检查的放大提醒和主进程准备素材都用它。只有带 `obsTransform: 'project'` 的片段才把工程里的位置、大小和旋转送到 OBS：在编辑器里改样子就带上，要 schema 3；旧工程里调过、没送过的片段不自动改，检查面板一段一段问「送到 OBS」还是「用 OBS 里的样子」。没设的片段显示联动台第一次改这个素材之前它在 OBS 里的样子，记在这台电脑（`apps/desktop/src/main/link/obs-material-own-looks.ts`）：第一次写变换之前读一次，存好了才写，素材场景由联动台新建时作废。样子在素材准备时设好，来不及的和显示放在同一批（`obs-media-scenes.ts` 的 `prime`、`lookFor`）。样子设不成不挡画面：片段照常显示，开始那一步标红写明原因，定位时记一行运行日志（`native-obs-outputs.ts` 的 `pictureSeekStep`）；本机记录读写出错时，这个素材这次运行不再写联动台的样子。实时画布上拖联动台自己的素材先认是哪一段（`managed-media-timeline.ts` 的 `clipOfMaterialSource`），轨道锁着不让拖，松手记成一条工程命令。只写联动台自己素材场景里的那一个场景项，别处不自己给素材发 `SetSceneItemTransform`。镜像、转 90°、裁剪和不透明度（2026-11-12）也在 `obsMaterialPresentation` 换算：镜像是缩放取负，转 90° 用原来的旋转，裁剪按素材原始像素写进同一个场景项，不透明度是解码器自己来源上的联动台滤镜「联动台·画面调节」（`color_filter_v2`），用到才建、不用就关、从不删。这个滤镜现在什么样只问 OBS，不记在本机：每次连接每个解码器准备时读一次（`obs-media-scenes.ts` 的 `readFilter`），联动台的写入失败以后下一次算样子时再读一次，只发要的；同名但不是联动台建的滤镜从不改、不删，片段要不透明度时标红。滤镜单独一批、在显示前发，设不成照常显示、开始那一步标红；没设不透明度的片段不为读滤镜等；不碰用户的来源和滤镜，不写停着上一首画面的解码器。播放中改样子：在画面上的那一段按同一条路再写一次，见 `docs/ONE_PLACE_PLAYBACK.md`「拿着歌时改工程」（0.5.9 R9）。见 `docs/OBS_SCENE_WORKFLOW.md`（`media-obs-transform.test.ts` 和 `obs-media-preload.test.ts` 的「E16 规则」「E17 规则」守着）

## OBS 请求谁先发

`apps/desktop/src/main/link/obs-request-scheduler.ts` 的档位和 `pump`：切画面的请求单独一档，始终有位置；截图等画面发完再发

## 画面失败怎么分级、补不补

分级只在 `packages/core/src/obs-program-session.ts` 的 `verdictOf`（2026-11-11）：做到了、撤回了、OBS 拒绝了、不确定（没回应，或发出去以后失败）。补不补只由 `packages/core/src/picture-reconcile.ts` 的 `judge` 定：失败的和不确定的都按此刻该有的画面补一次，排练时不补，OBS 断着时不补、不花次数；次数照上一行那张表，发出去那一刻才计数。每一项的状态列在 `NativeObsStatus.items`，状态面板「这首歌的画面」照着显示（`view-models/status-center.ts` 的 `pictureStatus`）。别处不自己重发画面动作（`output-rules.test.ts` 规则 2–4 守着）

## OBS 断了怎么重连、回来以后怎么恢复画面

重连只在 `apps/desktop/src/main/link/obs-reconnector.ts`（2026-11-12）：操作员手动连上过、又不是自己断开的才重连（从联动台关 OBS、修复组件、退出都算自己断开），等多久和几次照 `output-recovery.ts` 的 `obs.reconnect`，到上限标红等人点连接；手动连接和自动重连共用 `link-main.ts` 的同一个连接函数（`connectWith`，密码只读 `safeStorage`），操作员的连接和断开优先，不启动 OBS、不提权。恢复画面只在 `native-obs-host.ts` 的 `reconnected()`：先补回自有场景，再按当前位置重建（暂停时素材对好位置、保持暂停），断线时没准备好的歌不取消、照常开播，OBS 回来后重新准备再接上，一首歌最多 `obs.restore` 5 次；OBS 断着时画面算等待（`obs.connection`），不补、不花次数。别处不再自己重连 OBS，也不因为重连去定位节目（`output-rules.test.ts` 规则 5 守着）

## 停歌以后画面留在哪

`packages/core/src/obs-program-session.ts` 的 `stop`（2026-11-12）：在画面上的素材原地暂停、照常显示，节目场景不动，只隐藏这首歌显示的来源；`release` 才停掉、隐藏留下的那一帧。什么时候撤只在 `apps/desktop/src/main/link/native-obs-host.ts` 的 `holds`：下一首的画面上了以后（先上后撤，中间不黑），下一首没有自己的画面（只有音乐、画面准备被放弃或失败）时音乐一开始，关闭节目，停着时 OBS 断了又连上（不恢复，只清掉）。下一首用哪个解码器、要不要让出只在 `obs-media-preload.ts` 的 `free`、`claim`；留着的那一帧占着的解码器不写下一首的样子（样子按解码器写，见「素材在 OBS 里的样子」）。播放器的停止不等画面清理。别处不在停止时自己停素材、藏机位（`output-rules.test.ts` 规则 8 守着）

## 画面在不在跟

`packages/core/src/picture-follow.ts`（2026-11-12，用户 2026-11-10 定根因报告第 5 题按推荐做）：联动台播放、音乐在走时，画面会话（`obs-program-session.ts` 的 `readBack`）每秒读回一次节目场景和在画面上的素材（适配器 `readPicture`，走 `control` 档，只发读请求，不排在切画面前面）。漂移检查是它的一部分，校正仍在 `picture.drift` 的次数内。连续 2 次对不上才算没在跟；刚切完和素材开始后 1 秒内不比；转场中不判；工作室模式只看正式输出；暂停时不读；读不到是“无法确认”加原因；OBS 断着不读、不花次数；停了的歌不读回。手动接管只在 `programSceneChanged` 认：OBS 报的节目场景既不是时间线要的、也不是联动台刚切的，就不切回去，标黄，素材和显示的来源照常对齐，到下一段画面照常切，切了就结束；操作员自己切回去也结束；别的插件切的也算。节目场景里没有联动台的音频项时标红并写明怎么办，只检查、不往场景里加东西。显示用 `view-models/status-center.ts` 的 `pictureFollowStatus`，写法照“控台在不在跟”。别处不自己判断手动切换，也不另起读回循环（`picture-follow.test.ts` 和 `output-rules.test.ts` 规则 10 守着）
