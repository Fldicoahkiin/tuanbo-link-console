# 只有一处实现 · 播放、节目和工程的版本

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 开一首歌做什么

2026-11-17 本机 OBS 连接返回的状态统一在 `packages/schema/src/obs-address.ts` 的 `linkObsSnapshotSchema` 定义，桌面契约复用推断类型，包含连接编号和自动重连状态。避免 OBS 实际已连上却被旧返回校验拒绝、界面地址和保存结果不更新。回归：`packages/schema/src/obs-address.test.ts`、`view-models/connect-devices.test.ts`。

`packages/core/src/program-start.ts`。只有没有音频的歌放不了，其余都只是某一路输出参不参加

2026-11-17 用户再次确认：只需要音乐和灯光的电脑不要求安装、运行或连接 OBS。`view-models/connect-devices.ts` 的 OBS 控制、场景清单、预览失败只阻断依赖它的画面检查，音频、MIDI MTC、P1 和 MA2 继续检查；自动连接时无画面需求且未发现 OBS 则跳过画面步骤。设置页启动沿用同一个连接流程。P1 开播前检查通过 `link-preflight.ts` 的 `pictureRequirement: 'optional'` 将画面问题明确记为提示，读取场景或准备素材失败同样记录，不取消时间码监听；OBS 自身准备仍使用默认严格检查，不能把坏画面冒充就绪。音频、MIDI、P1 和工程本身的故障仍按原规则处理。回归：`connect-devices.test.ts`、`link-preflight-view-model.test.ts`、`packages/core/src/link-preflight.test.ts`；播放器输出隔离仍由 `native-program-player.test.ts` 守着。

2026-11-14 修复编辑器入口：只用音乐和灯光的歌，停着时定位不检查 OBS（`runtime/editor-scene-preview.ts` 复用 `itemNeedsObs`）；有画面的歌定位失败仍显示、记录原因，但不能取消定位期间操作员按下的播放（`components/useEditorTransport.ts`）。暂停和停止照旧取消待执行的播放。节目单、编辑器和灯光工作台仍使用同一个后台播放器，不需要 OBS 才能放音乐、发时间码。回归：`apps/desktop/src/renderer/src/link/runtime/link-runtime-coordinator.test.ts`、`apps/desktop/test-e2e/editor-transport.browser.spec.ts`；后台画面失败继续播放由 `apps/desktop/src/renderer/src/link/runtime/native-program-player.test.ts` 守着。

## 时间码怎么发

2026-11-23，操作员须修正两首时码首尾过近的安排。正常播放按钮从现有工程和最近一次控台核对结果判断，本曲已知间隔不足时停用本次灯光 MTC 并明确提示，音频与画面仍可播放。间隔按 `packages/core/src/ma2-mtc-selection.ts` 的规则计算，由 `packages/core/src/program-start.test.ts` 核对。

2026-11-17 用户要求：歌曲及控台时间线的 MTC 起始码输入、显示只保留 `时:分:秒`，解析/格式化统一用 `mtc-timecode.ts` 的 `parseMtcStart` / `formatMtcStart`，允许中文冒号和六位数字。实际 MIDI MTC 和 Cue 定位继续保留工程帧率；29.97 DF 的整分钟使用该秒首个有效帧。既有精确起点不因显示或只改时间线名称而重写。输入草稿复用 `useFieldDraft`，外部起点更新不重建输入框、不丢焦点，换歌才重置；是否可改仍由 `showGate('song.audio.edit')` 决定并显示等待原因。回归：`mtc-timecode.test.ts`、`apps/desktop/test-e2e/mtc-start.browser.spec.ts`。

同日修复 M4A 起始时间偏移：`native-audio-decode.ts` 使用 `audio-source-time.ts` 保留源文件时间戳、按绝对时间定位，`aresample` 从所请求的样本位置对齐 PCM。非零开始时间不再被省略，完整解码和中途定位使用同一个时间零点；不放宽 `native-audio-cache.ts` 的长度及源文件校验。预填充和完整校验使用同一个 1 ms 取整容差。新解码缓存身份带 `pts1`，旧缓存不再用于播放，但仍纳入容量回收。真实截短仍报实际/记录时长及重新导入位置。回归：`native-audio-cache.test.ts` 的 AAC 非零起始时间、取整与缓存升级用例。

解码失败后明确停止：`native-player-service.ts` 只有停止及音频清理成功才清掉旧 `audioError`；接收停止命令时不把旧故障包装为新操作的结果发布。`native-program-player.ts` 完成停止后清除旧播放错误，恢复节目编辑；新的停止/清理失败照常报告。回归：`native-player-service.test.ts` 的真实 WASAPI 解码失败停止用例、`apps/desktop/src/renderer/src/link/runtime/native-program-player.test.ts`。

同日本机定位发现：44.1 kHz 音频只能停在整采样上，请求的小数毫秒与引擎读回会差不到一个采样。`native-program-player.ts` 准备动作 MIDI 时使用这次准备确认的 `result.positionMs`，不再使用未取整的请求值；`native-program-host.ts` 的精确身份和位置校验保留。回归：`native-program-host.test.ts` 的真实 44.1 kHz 任意位置播放、拖动和恢复用例。

原生播放引擎一条路径，从歌曲的 MTC 起始码发（`packages/core/src/native-program-snapshot.ts`）

歌曲起始帧在工程中以整数毫秒保存。原生播放器还原能以该毫秒数表示的时码帧，其余起点保留原毫秒值；再加上音频播放位置。Full Frame 定位与 Quarter Frame 使用同一帧位置。恰好在整帧的起点和离整帧还差一个音频采样的起点分别验证，见 `tools/playback-engine/signal-test.c`。

暂停时由 `tools/playback-engine/audio.c` 先停声卡，再读取冻结的设备位置。播放和暂停共用从设备读数到歌曲位置的换算。已经停住或只做了定位时保留当前位置。44.1 和 48 kHz 的实测见[暂停位置核对](./LIGHTING_LIVE_AUDIT_20261119.md#11-月-22-日核对声卡实际暂停位置)。

## MIDI 端口的开关

主进程 `midi-port-broker.ts`。界面不用 Web MIDI：`navigator.requestMIDIAccess` 会占住电脑上全部 MIDI 端口，Windows 报错误 7 或 4

## 动作 MIDI 晚到怎么办

`packages/core/src/midi-late-rule.ts`（2026-11-10）：Program Change、Control Change 照发并标红，Note On、MSC Go 晚 100 ms 以上只跳过这一条，Note Off、MSC Stop 总是发；一条失败不停整路

## 自己恢复几次算到头

`packages/core/src/output-recovery.ts` 一张表（2026-11-11）：声卡 1 分钟断流 5 次提醒检查声卡并继续播放（2026-11-25 更新），时间码一首歌失败 3 次这首歌不再发，等等。别处不写重试次数；每次恢复都标红、记日志

## 节目现在在哪一步、这时能做什么

规则在 `packages/core/src/show-state.ts` 的 `showGate`，状态由主进程 `apps/desktop/src/main/link/show-state-service.ts` 算（2026-11-11），界面只照着显示（`stores/show-state-store.ts`）。新的“播放时不能做”都问它，不再各处自己判断“在不在播放”

## 后台节目会话和工程版本

主进程 `apps/desktop/src/main/link/native-program-service.ts`（2026-11-11）：一个窗口页面一个长期的节目，页面第一次打开时检查授权，之后每一路输出照旧各自过授权。修改只经 `link:native-program-document` 送新的一版（界面 `runtime/program-document-feed.ts`）：一次只有一个在路上；开歌前先送最新一版，上一次没送进去的也在这时再送一次，别的时候不自己重送。一版只带改过的歌、删掉的歌、顺序和工程自己的字段（`packages/core/src/project-version-change.ts`，按是不是同一个对象来比），主进程只拼在它手里最新的那一版上，对不上就答复重送、界面整份送一次；增量和整份过同一套检查（每首歌和工程字段的 schema、整个工程的关系、和打开节目一样的文件检查）。整份在自己的 worker 里编码（`stores/project-codec.ts` 的 `programDocumentCodec`），不和保存排队。会开歌的控制等它前面的版本，停止和复位不等、并让还在等的开歌作废（主进程 `entry.turn`、界面 `turn`；哪些算开歌只在 `packages/schema/src/native-program.ts` 的 `nativeProgramStartsSong`）。拿着歌时新的一版当场用上，哪些马上生效见下一行。版本按 (sessionId, revision) 认，节目事件带着最新的版本和画面在播的版本（`pictureVersion`），窗口靠它知道在播哪一版（`program-attachment.ts`）；事件序号由服务统一往上数，同一页换了节目也接得上。播放器上的选择不随修改变；声卡按一轮播放固定（`packages/core/src/native-program-player.ts` 的 `runOutput`）。只有换工程或路径、上次打开失败、退出取消以后才重新打开节目，别处不再因为工程变了就关掉重开（`program-session-rules.test.ts` 守着）

## 拿着歌时改工程

2026-11-16 用户要求去掉截图中的黄色常驻提示：编辑器不再显示「这首歌的画面现在没有联动，播放中改的画面这一遍用不上」提示条。实际画面状态仍在状态面板展示，待生效片段的标记和 `pictureTakesEdits` 判断保持不变，`picture-on-air-rules.test.ts` 守着。

`packages/core/src/live-revision-effect.ts` 的 `liveRevisionEffect`（2026-11-12）：联动台播放拿着的歌（准备中、在播、暂停、播完停住）照开始那一版放，音频和时间码都按那一版，定位和循环回来也是。新的一版里当场生效的有五样：它的画面（见下一段）、它保存的音量、它自己的「播完后」、它的灯光会用到的执行器（只增不减，停止时关所有版本用过的，`lighting-off-ledger.ts` 的 `litAlso`、`widen`）、动作 MIDI 在播放头之后的那部分（2026-11-12，`MidiProgramSession.retarget`：过去的不补发、不撤回，已发的 Note On 一定有松开；暂停时改的等继续再用；排不了的一版当场拒绝并写明，照原来的发）。发过的动作只在同一遍里记着：暂停再继续不重发，定位、拖动、循环是新的一遍、照常再发（`NativeProgramPlayer.actionPass`，主进程 `native-midi-host.ts` 只在同一首歌同一遍里带着）。下一首按最新一版找、按最新一版放；提前准备按内容认、不按版本号（`packages/core/src/next-song-identity.ts`），改别的歌不会让下一首重新准备；下一首自己改了，或者换了哪首是下一首（删除、停用、改「播完后」、换播放列表），就在旁边重新准备（`NativeProgramPlayer.followNext`，经 `prepareNextNativePlayback`、`prepareNextNativeObs`，不经台上那首的播放控制，一次只有一个在路上、只要最新的）。台上那首歌的音频本身（`songAudioStructureKey`：音频文件和片段、总长、播放范围、MTC 起始码）、删除和停用要等它停下：界面的仓库在提交前问 `showGate`（`stores/document-store.ts` 的 `stageWait`，撤销和重做也问），只在联动台播放时拦，P1 跟随照旧；就算送到主进程也不碰音频和起始码，只写日志。要播的歌在最新一版里已经删掉或停用就不播，在播的照常（`NativeProgramPlayer.play`）。别处不再因为工程变了去停歌、重开，或者自己判断哪些改动能当场生效（`live-edit-rules.test.ts` 守着）

**画面这一遍就用上**（2026-11-12，0.5.9 R9；用户 2026-11-10 定根因报告第 1 题“这一遍立即生效”）：改的是这首歌的画面（机位、素材、轨道上下、显示的来源、素材的样子）时，播放器把新的一版交给这首歌的画面（`NativeProgramPlayer.retargetPicture`，经 `ProgramPictureOutput.retarget`；同一时间最多一个在路上，只送最新的），主进程 `apps/desktop/src/main/link/native-obs-host.ts` 的 `retarget` 交给画面会话（`packages/core/src/obs-program-session.ts` 的 `retarget`）：在会话自己的队列里一步换成新的一版，按当前位置对账一次，只发和 OBS 现在不一样的；过去的机位切换和点 Cue 不重放；暂停时、定好位置还没开始放时也对，这时新素材不等走时间、马上准备（`prepareHeld`）。每一版都有回音：用上了看状态里的 `appliedRevision`，没用上当场写明原因，播放器不再等它。**画面这时跟不跟修改只由播放器的 `pictureTakesEdits` 说**（`takesPictureEdits`：没有画面、画面失败或停了、OBS 恢复到了上限、上一版被拒绝时为否），编辑器照它标「正在送到 OBS」或「停下重播才生效」（`apps/desktop/src/renderer/src/link/view-models/picture-on-air.ts`），别处不自己判断。接不了的一版让这首歌的画面标红停下，音乐和时间码照常（2026-10-30）。音频本身和 MTC 起始码照旧等停下；P1 跟随不变。细节见 `docs/OBS_SCENE_WORKFLOW.md` 2026-11-12 R9 那一条（`packages/core/src/output-rules.test.ts` 规则 11、`live-edit-rules.test.ts`「S8b 第二部分」、`picture-on-air-rules.test.ts`、`obs-program-session-retarget.test.ts`、`native-obs-host-retarget.test.ts` 守着）

2026-11-14：按用户截图要求去掉「播放中改画面，这一遍就用上」常驻说明。没有待送出的画面修改时不显示提示条；正在送到 OBS 的进度与实际异常提示继续显示，播放中改画面的生效规则不变。

## 一首歌的音量

`packages/core/src/link-command.ts` 的 `setItemVolumeCommand`、`savedSongVolume`（2026-11-12）：每首歌自己的音量存在工程里，播放条的滑块就是它，松手保存，一次拖动一步撤销。保存的音量只随工程的版本到节目：拿着的歌由 `liveRevisionEffect.volume` 当场生效，别的歌开始时读最新一版，别处不单独发音量。拖动时的试听走 `previewVolume(itemId, volume)`，只有台上那首听得到，不保存；MIDI CC7 是这一遍的临时音量（`overrideVolume`），不写工程，换歌或停止就清掉，拖播放条会接过去。输出音量只在 `NativeProgramPlayer.outputVolume` 算：有 CC7 用 CC7，否则用最新一版保存的。P1 跟随时音量由 P1 管。见 `docs/SONG_VOLUME.md`（`song-volume-rules.test.ts` 守着）

## 一首歌的节拍

`packages/core/src/song-beats.ts` 的 `songBeats`（2026-11-11）：每首歌一份，按音乐的源文件存在 `rundownItem.music`，编辑器和灯光工作台都从它读，经音频片段换算到歌曲时间，剪切、移动音频不用重新识别。只用 `setSongMusicCommand` 改；旧工程的两种节拍只在 `document-store.setProject` 打开时搬一次（`song-music-migration.ts`）。显示疏密只在显示时定，不存进工程；包络分析（“分析音乐”）不出节拍。识别是编辑器和灯光工作台共用的一次（`components/useMusicBeatSegments.ts`，按歌记着，哪一页看到结果就写一次）；节拍的写入在播放中或运行时在忙时都等停了再写。没装识别组件的电脑才给“简易检测”（IBT），点了才跑，写入守同一条规矩；编辑器不再有自己的检测。手动踩点（Ctrl+J，2026-11-12）也写进这一份：只经 `addSongBeats`（`editMusicStructure` 的 `add-beats`，50 ms 以内已经有拍点就不重复加），播放中踩的先记在 `useMusicBeatSegments.ts`，停了一起写、算一步。编辑器吸附的节拍只在 `components/timeline-snap-points.ts` 的 `songBeatSnapPoints` 算：当前疏密下显示出来的节拍加段落的边，看得见的才吸，按下时放进拖动和修剪的快照；灯光工作台照旧吸全部节拍（`editor-rules.test.ts` 规则 7、8、9 守着）

## 波形

2026-11-17：波形与原生播放使用 `apps/desktop/src/main/link/audio-source-time.ts` 中相同的文件时间起点，保留 AAC 开头偏移。波形文件格式升为 2，旧波形沿既有流程重新生成一次，避免新播放器和旧波形错位；`waveform-service.test.ts` 覆盖真实 AAC 解码和旧缓存重建。

主进程 `apps/desktop/src/main/link/waveform-service.ts`（2026-11-11）：一次解码出多级峰值、45–180 Hz 节奏波形和频谱（`waveform-levels.ts`），按 sha256 存在工程的 `cache/waveforms/<sha>.levels.bin`；`<sha>.json` 照旧写成 0.5.8 能读的纯数组，不改它的格式。界面只用 `useSongWaveform` 拿、`WaveformCanvas`（`view-models/waveform-draw.ts`）画，不解码整首音频，不引入波形库（`editor-rules.test.ts` 规则 5 守着）

## 一首歌多长

2026-11-25，正式播放和定位在开声前等本次音源解码、校验完成。冷启动长音源可能需要更久，下一首仍可提前准备。声卡反复断流、暂时拿不到准确时钟、播放状态报告积压时继续向声卡送样。使用最后一帧音频在设备中排空来确认正常曲尾。真实设备失效或没有可播放的音频时报告实际故障。回归见 `apps/desktop/src/main/link/native-playback-client.test.ts`、`apps/desktop/src/main/link/native-playback-liveness.test.ts` 和 `apps/desktop/src/main/link/native-player-device-change.test.ts`。

2026-11-25，工程或容器记录的时长和实际解码的音频有差异时，正式播放、预热和定位均使用实际可播放的采样。已经开始播放的音乐继续到实际曲尾或操作员指定的裁剪终点。缓存只公布实际完整解码的音频。Windows 原生播放器区分边解码时的短读和正常解码结束。回归见 `apps/desktop/src/main/link/native-audio-cache.test.ts` 和 `apps/desktop/src/main/link/native-player-service.test.ts`。

`packages/core/src/audio-edit.ts` 的 `songDurationMs`（2026-11-11）：存了总长（`referenceAudio.timeline.durationMs`，音乐后面留了空白）就用它，否则到最后一段音频的结尾。前后空白读 `songLeadBlankMs`、`songTailBlankMs`，改片段以后的总长用 `editedSongDurationMs`（空白不会被改片段吃掉，片段拖过总长歌就变长），加空白用 `padAudioTimeline`（按工程帧率取整到帧）。音频只由主进程 `audio-edit-service.ts` 的 `mix` 渲染到这个长度，尾空白是真的静音采样；`referenceAudio.durationMs` 等于歌曲总长，schema 守着。没存总长的歌，缓存名和渲染结果和 0.5.8 逐字节一样。别处不再自己取“最晚片段的结尾”当歌的长度

## 一首歌前后的空白

`packages/core/src/song-padding.ts` 的 `padSongCommand`（2026-11-11）：一条命令、一步撤销。音频先渲染好（`padSongRender` 给主进程渲染的参数）再交进来，对不上就不写。内容按整帧挪（`content-timeline.ts` 的 `shiftContent`），音频和灯光按同样帧数的毫秒挪（`lighting-shift.ts` 的 `shiftLightingDocument`：节拍锁定的片段换成时间锁定、带节拍锚点）；MTC 起始码、控台时间线的起点和 MA2 基线不动，差异按普通改动改写控台一次。能去掉多少空白、被什么挡住只由 `songPaddingLimits` 算（`songPaddingRoom` 是不带原因的那一份），碰到最早或最晚的内容就停。P1 跟随的工程不能用；演出没停止时也加不了：界面问 `showGate` 的 `audio.render`，主进程在播放时不生成音频。编辑器的入口是音频轨两端的空白手柄和音频属性的「前空白」「后空白」（2026-11-12），都经 `components/song-padding-flow.ts` 的 `padSongSteps`（先生成音频、同一组数字写命令）；整首挪过的歌到控台确认之前按以联动台为准写，记下和忘掉只在 `ma2-edit-times.ts` 的 `noteMa2LocalEdits`（`runtime/ma2-song-shift.ts`）。别处不自己整首平移（`song-padding-rules.test.ts` 守着）

## P1 跟随

刚打开 MIDI 输入、接入时码流中途时，正向和反向都要收到一组完整的八条四分之一帧才显示位置。`packages/core/src/mtc-timecode.test.ts` 覆盖从组内每个位置接入。

相邻两条四分之一帧在 MIDI 接口上的间隔超过断码阈值时，之前留下的半组作废。其他 MIDI 消息或心跳不能把两段时码拼成一个位置。待命时也遵守这项规则，见 `packages/core/src/p1-clock.test.ts`。

2026-11-22，已启用 P1 自动选歌时，在设置中点击「写回 P1」也会按当前节目重新计算起点。绑定 MA2 或已有写入目标的节目保留当前灯光起点，控台离线时同样生效。跟随前校验已保存的自动选歌区间是否仍与节目的灯光起点一致。回归见 `packages/core/src/p1-auto-follow.test.ts`。 本地节目已有灯光目标时，导入相同音频、不同起点的 P1 歌曲会保留两首。同名提示也使用这条保护规则。回归见 `packages/core/src/link-command.test.ts`、`packages/core/src/p1-import-report.test.ts`。

2026-11-21，手动待命的歌曲沿用工程中这首歌的 MTC 起始码。接收监视器显示 P1 的绝对时间，判断从头播放、定位、重新同步和驱动输出时都使用歌曲内的位置。时间码早于起点时继续等待，中途开始仍需操作员重同步。用 P1 1.14.2 在 00:20:00:00 起播并交叉核对了联动台的跟随位置与 onPC 执行器。回归见 `packages/core/src/p1-clock.test.ts`。

跟随 P1 整个在主进程里做（0.5.9，2026-11-12）：界面卡住、重新加载都不影响正在跟的歌。和联动台播放是明确选的两种方式，互相不自动切换。

- **规则只在 `packages/core/src/p1-follow-session.ts`**（`P1FollowSession`）：P1 的时间码在走、停了还是换了一首由 `packages/core/src/p1-clock.ts` 说，这里定各路输出这时被告知什么、操作员这时能做什么。别处不自己解读 P1 的时间码。
- **主进程 `apps/desktop/src/main/link/p1-follow-host.ts`** 拿着 P1 的时间码输入口（向 `apps/desktop/src/main/link/midi-port-broker.ts` 以「P1 时间码」的名义占用，不经过界面），跑一个 `P1FollowSession`，把状态推给界面（`link:p1-follow-state`，格式在 `packages/schema/src/p1-follow.ts`）。接线只在 `apps/desktop/src/main/link/p1-follow-wiring.ts`，`link-main.ts` 只建一次。
- **界面只经 `apps/desktop/src/renderer/src/link/runtime/p1-follow-client.ts` 发命令**（`link:p1-follow`），状态只落在 `apps/desktop/src/renderer/src/link/stores/p1-follow-store.ts`，显示走 `apps/desktop/src/renderer/src/link/view-models/status-center.ts` 的 `p1FollowStatus`。界面不解时间码、不订阅 MTC 输入、不驱动任何输出。
- **输出用联动台播放的那一套，不另写一份。** 动作 MIDI 经 `apps/desktop/src/main/link/p1-midi-output.ts` 接到同一个 `NativeMidiHost` 和 `MidiProgramSession`（晚到规则、端口恢复都一样）。输出列表在 `apps/desktop/src/main/link/p1-follow-outputs.ts`：一路出错不连累别的；输出出错走它自己的状态和运行日志，不往跟随里抛。
- **画面是这个列表里的又一项**（0.5.9，2026-11-12）：`apps/desktop/src/main/link/p1-picture-output.ts` 把 P1 的时钟交给 `link-main.ts` 里唯一的那个 `NativeObsHost`（同一个 `ObsProgramSession`、停歌留最后一帧、OBS 重连、读回“画面在不在跟”），宿主不分两份：跟随给它一个“这首歌在哪”的来源（`native-obs-host.ts` 的 `PictureClockSource`），就像动作 MIDI 的 `MidiClockSource`。播放器的时钟和控制碰不到跟随的画面，P1 的时钟也碰不到节目的。P1 放的音乐不经联动台的音乐项进 OBS，读回也不找它。界面不为 P1 驱动画面。
  - **同一时间只归一家**：另一家（另一个工程的节目，或跟随）的歌在台上或正在准备画面时，后来的那一家被拒绝并写明原因，这一路标红，音乐、时间码、动作 MIDI 和灯光照常（2026-10-30）；正在用的画面不被抢走。停下的歌不占着画面（它的最后一帧等下一首的画面上了再撤）。
  - **能提前知道的歌，画面不比音乐晚**（2026-11-12，用户原话“我记得是完全实时同步吧，还是晚了”）：跟随告诉各路输出接下来 P1 要从头放哪首（`P1FollowOutputs.expect`）：手动是待命的那首；自动选歌一开始是节目单里 P1 能开始的第一首，每首开始以后是节目单里它后面 P1 能开始的下一首，最后一首之后没有（不绕回去）；停止说没有了。“P1 能开始”只在 `packages/core/src/p1-auto-follow.ts` 判断一次（`nextP1Song` 和认歌用同一个判断）。画面把这首歌提前准备好，OBS 上正在显示的一点不动：跟随这时没有歌在台上（手动待命、自动还在等第一首），走提前准备那一处的“选中的歌”（`NativeObsPreloadPool.preload`，和联动台播放预选同一个池子、同一个准入）；跟随有歌在台上，作为它的下一首（`nextFiles`）。都不加联动台的音乐（池子记着有没有音乐，只交给同样的那一首）。P1 放到这首歌时，它自己的准备从歌的开头准备（准备期间报的位置是这一遍开始的位置），用的就是提前准备好的那一份，再按 P1 当时的位置接上。猜错了不要紧：放了别的歌就放开准备好的那份，那首照旧开始时准备。提前准备不是一种状态：不标红、不等它，被拒绝（别家的画面在用）记一行信息，失败记一行警告，准备好了记一行信息和用了多久（`apps/desktop/src/main/link/p1-picture-output.ts`）。跟随整场一个画面会话、每一遍和每次接着放各一个编号，停哪一遍按编号认，早一遍迟到的停止不停后一遍。
  - **不提前准备的**：冻结后「从头重新待命」（冻住的那首的画面还拿着，重放时照旧开始时准备）、不按节目单顺序点的歌、和台上这首共用素材来源或场景的下一首（只准备文件）、别家（另一个工程的节目）的画面在用时。这些歌开始跟时不等画面：画面在后台准备，准备好了按 P1 那一刻的位置接上（宿主的“音乐先开始、画面晚到”），之前的不补；对 P1 这是常态，不标红，只有没接上的部分标红。准备不了就这一路标红写原因，别的照跟。没有画面的歌不准备。自动化验证通过，未实机验证。
  - **冻结**：点动作和机位停在原地，不补；手动模式素材照放（时间码丢了或跳变，P1 还在放），自动选歌素材暂停（P1 停了）。
  - **接着跟**：自动选歌从同一位置继续，素材接着放、对到真实位置，这一遍发过的不重发；手动「重新同步」按这个位置对一次，此刻的机位和素材出现在 OBS，过去的点动作不补。冻结前在放的那一遍留在最后一帧，新的一遍上了再撤。
  - **停下**：P1 换歌、在联动台按停止，画面留在最后一帧，和联动台播放同一条规矩（`ObsProgramSession.stop`、宿主的 `holds`）；跟随关掉、被同一界面的新一版换掉、退出软件时放开，和关掉节目一样。界面没了不碰在跟歌的跟随的画面（`closeEngine` 的 `nativeObs.close()` 只关播放器的歌）。这首歌的画面还在准备（上一首还在收拾、输出还没做好）时停下或关掉跟随，准备当场作废，这首的画面一点不发、做出来的输出放开（`native-obs-host.ts` 的 `stopSource`、`closeSource`）；上一首迟到的停止不会把正在准备的这首作废。
  - **视频自己的声音**：和 0.5.8 一样只看片段自己的开关（`compileManagedMediaTimeline`）。画面快照记着谁放音乐（`obsProgramSnapshotSchema` 的 `playbackSource`：P1 的歌写 `p1`，联动台播放的歌不写这一项，快照和以前一样），画面工程照它还原；画面会话里 Cue 的时钟（`CueRuntime`）只跟着会话给的位置走，不看谁放音乐（2026-11-12 删掉了它自己读 P1 时间码的旧路径）。
  - **状态**：跟随的状态里有 `outputs.picture`（`packages/schema/src/p1-follow.ts`），首页的跟随状态和「这首歌的画面」照它显示，和联动台播放时一样（`status-center.ts` 的 `p1PictureStatus`）；读回怎么判断只在 `packages/core/src/picture-follow.ts`。画面显示的东西变了才通知（宿主每走一步都报），原因和出错写到 8192 个字为止（`p1-picture-output.ts`）。
  - 跟随中改工程，画面这一遍不跟（R9 的 `retarget` 在 P1 下不接）；P1 跟随只按直播跑。
- **灯光**：控台按 P1 的时间码自己跑。关灯照 `docs/LIGHTING_WORKFLOW.md`（2026-11-11）：在联动台按停止关这首歌的执行器、P1 不停；P1 换歌只关上一首独有的；P1 自己停、断码、等下一首都不关。走同一张关灯清单（`apps/desktop/src/main/link/lighting-off-service.ts` 的 `followChange`、`followStop`）。
- **界面没了（重新加载）**：在跟一首歌的跟随照跟，不发 Off；新页面打开的是同一个工程就接回（`adopt`），不是同一个工程就提示这个工程还在跟随、只能停止它。什么都没在跟的（手动待命、自动选歌还在等第一首）随界面关掉、放开输入口：自动选歌由新页面自己重新开始，手动的由操作员再点。退出软件结束跟随。
- **授权**：跟随开始跟歌时主进程自己检查一次，通过就拿着到跟随停下（`apps/desktop/src/main/link/license-access.ts` 的 `setFollowRunning`），界面在不在都一样，和节目那一条分开。见 `docs/LICENSE_IMPLEMENTATION.md`。
- **演出状态**：`apps/desktop/src/main/link/show-state-service.ts` 看得到跟随（等歌、准备、时间码丢了、接管、失败）；主进程里“演出在不在走”只问 `link-main.ts` 的 `showRunning()`，退出、诊断包和问题反馈都用它。
- **自动选歌**时每首歌不先跑界面的开播前检查：主进程照联动台播放开歌那样准备各路输出，哪一路不行就标红不参加，其余照跟。
- **断码和继续**（AGENTS.md 第 4 节第 9 条不变）：时间码丢了或异常跳变就冻结，不猜、不补。手动模式在首页点「重新同步」接着跟，过去的动作不补；自动选歌从同一位置继续算同一遍，发过的不重发。开始跟一首歌时，歌的开头到第一个跟上的位置之间的动作发一次，不算晚到、不标红，记一行运行日志；之后照共用的晚到规则。
- **时间码有一段读不出来**（P1 在一圈时间码中间换了位置，两个位置的碎片拼到一起）：这一段略过，输入口照开，接下来的照原来的规矩判断：没声超过 500 毫秒算断码，下一个位置跳了算跳变。运行日志里记一条提醒（连着几段只记第一段，读对一段以后再有才再记），不标红。规矩在 `packages/core/src/p1-clock.ts`，主进程只记日志；别的处理失败照旧停下输入口。
- **时间码是什么时候到的**按 MIDI 接口自己记的时刻算。接口的时刻偶尔比联动台自己的钟早零点几毫秒，这时按收到的那一刻算，不会因此让这首歌的动作 MIDI 或画面出错（`apps/desktop/src/main/link/midi-port-broker.ts` 的 `deliver`，只在这一处）。
- P1 的输入口拔掉以后不自己重新打开（2026-10-24 的恢复只管输出）：正在跑的冻结，由操作员重新开始：停止、插好线，再点「启动并待命」（或一键连接）就重新打开输入口。没在跟歌时换了 P1 的输入口、改了连接设置，再点一次也按新的开始；什么都没变就不重来。正在跟一首歌时改设置不影响这首，停止以后再开始才用新的（`apps/desktop/src/renderer/src/link/runtime/p1-follow-client.ts` 的 `start`）。

守着它的测试：`packages/core/src/p1-follow-rules.test.ts`（规则 ⑦ 到 ⑩，含画面；“只在主进程跟随”和画面的源码扫描）、`packages/core/src/p1-follow-session.test.ts`、`packages/core/src/p1-mtc-decode-rules.test.ts`（读不出来的一段）、`apps/desktop/src/main/link/p1-follow-host.test.ts`、`apps/desktop/src/main/link/p1-follow-timestamp.test.ts`（接口的时刻早一点）、`apps/desktop/src/main/link/p1-picture-output.test.ts`、`apps/desktop/src/main/link/license-rules.test.ts` 里 P1 跟随那一组。
