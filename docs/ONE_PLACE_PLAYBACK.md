# 只有一处实现 · 播放、节目和工程的版本

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 开一首歌做什么

`packages/core/src/program-start.ts`。只有没有音频的歌放不了，其余都只是某一路输出参不参加

## 时间码怎么发

原生播放引擎一条路径，从歌曲的 MTC 起始码发（`packages/core/src/native-program-snapshot.ts`）

## MIDI 端口的开关

主进程 `midi-port-broker.ts`。界面不用 Web MIDI：`navigator.requestMIDIAccess` 会占住电脑上全部 MIDI 端口，Windows 报错误 7 或 4

## 动作 MIDI 晚到怎么办

`packages/core/src/midi-late-rule.ts`（2026-11-10）：Program Change、Control Change 照发并标红，Note On、MSC Go 晚 100 ms 以上只跳过这一条，Note Off、MSC Stop 总是发；一条失败不停整路

## 自己恢复几次算到头

`packages/core/src/output-recovery.ts` 一张表（2026-11-11）：声卡 1 分钟断流 5 次停这首歌，时间码一首歌失败 3 次这首歌不再发，等等。别处不写重试次数；每次恢复都标红、记日志

## 节目现在在哪一步、这时能做什么

规则在 `packages/core/src/show-state.ts` 的 `showGate`，状态由主进程 `apps/desktop/src/main/link/show-state-service.ts` 算（2026-11-11），界面只照着显示（`stores/show-state-store.ts`）。新的“播放时不能做”都问它，不再各处自己判断“在不在播放”

## 后台节目会话和工程版本

主进程 `apps/desktop/src/main/link/native-program-service.ts`（2026-11-11）：一个窗口页面一个长期的节目，页面第一次打开时检查授权，之后每一路输出照旧各自过授权。修改只经 `link:native-program-document` 送新的一版（界面 `runtime/program-document-feed.ts`）：一次只有一个在路上；开歌前先送最新一版，上一次没送进去的也在这时再送一次，别的时候不自己重送。一版只带改过的歌、删掉的歌、顺序和工程自己的字段（`packages/core/src/project-version-change.ts`，按是不是同一个对象来比），主进程只拼在它手里最新的那一版上，对不上就答复重送、界面整份送一次；增量和整份过同一套检查（每首歌和工程字段的 schema、整个工程的关系、和打开节目一样的文件检查）。整份在自己的 worker 里编码（`stores/project-codec.ts` 的 `programDocumentCodec`），不和保存排队。会开歌的控制等它前面的版本，停止和复位不等、并让还在等的开歌作废（主进程 `entry.turn`、界面 `turn`；哪些算开歌只在 `packages/schema/src/native-program.ts` 的 `nativeProgramStartsSong`）。拿着歌时新的一版当场用上，哪些马上生效见下一行。版本按 (sessionId, revision) 认，节目事件带着最新的版本和画面在播的版本（`pictureVersion`），窗口靠它知道在播哪一版（`program-attachment.ts`）；事件序号由服务统一往上数，同一页换了节目也接得上。播放器上的选择不随修改变；声卡按一轮播放固定（`packages/core/src/native-program-player.ts` 的 `runOutput`）。只有换工程或路径、上次打开失败、退出取消以后才重新打开节目，别处不再因为工程变了就关掉重开（`program-session-rules.test.ts` 守着）

## 拿着歌时改工程

`packages/core/src/live-revision-effect.ts` 的 `liveRevisionEffect`（2026-11-12）：联动台播放拿着的歌（准备中、在播、暂停、播完停住）照开始那一版放，音频和时间码都按那一版，定位和循环回来也是。新的一版里当场生效的有五样：它的画面（见下一段）、它保存的音量、它自己的「播完后」、它的灯光会用到的执行器（只增不减，停止时关所有版本用过的，`lighting-off-ledger.ts` 的 `litAlso`、`widen`）、动作 MIDI 在播放头之后的那部分（2026-11-12，`MidiProgramSession.retarget`：过去的不补发、不撤回，已发的 Note On 一定有松开；暂停时改的等继续再用；排不了的一版当场拒绝并写明，照原来的发）。发过的动作只在同一遍里记着：暂停再继续不重发，定位、拖动、循环是新的一遍、照常再发（`NativeProgramPlayer.actionPass`，主进程 `native-midi-host.ts` 只在同一首歌同一遍里带着）。下一首按最新一版找、按最新一版放；提前准备按内容认、不按版本号（`packages/core/src/next-song-identity.ts`），改别的歌不会让下一首重新准备；下一首自己改了，或者换了哪首是下一首（删除、停用、改「播完后」、换播放列表），就在旁边重新准备（`NativeProgramPlayer.followNext`，经 `prepareNextNativePlayback`、`prepareNextNativeObs`，不经台上那首的播放控制，一次只有一个在路上、只要最新的）。台上那首歌的音频本身（`songAudioStructureKey`：音频文件和片段、总长、播放范围、MTC 起始码）、删除和停用要等它停下：界面的仓库在提交前问 `showGate`（`stores/document-store.ts` 的 `stageWait`，撤销和重做也问），只在联动台播放时拦，P1 跟随照旧；就算送到主进程也不碰音频和起始码，只写日志。要播的歌在最新一版里已经删掉或停用就不播，在播的照常（`NativeProgramPlayer.play`）。别处不再因为工程变了去停歌、重开，或者自己判断哪些改动能当场生效（`live-edit-rules.test.ts` 守着）

**画面这一遍就用上**（2026-11-12，0.5.9 R9；用户 2026-11-10 定根因报告第 1 题“这一遍立即生效”）：改的是这首歌的画面（机位、素材、轨道上下、显示的来源、素材的样子）时，播放器把新的一版交给这首歌的画面（`NativeProgramPlayer.retargetPicture`，经 `ProgramPictureOutput.retarget`；同一时间最多一个在路上，只送最新的），主进程 `apps/desktop/src/main/link/native-obs-host.ts` 的 `retarget` 交给画面会话（`packages/core/src/obs-program-session.ts` 的 `retarget`）：在会话自己的队列里一步换成新的一版，按当前位置对账一次，只发和 OBS 现在不一样的；过去的机位切换和点 Cue 不重放；暂停时、定好位置还没开始放时也对，这时新素材不等走时间、马上准备（`prepareHeld`）。每一版都有回音：用上了看状态里的 `appliedRevision`，没用上当场写明原因，播放器不再等它。**画面这时跟不跟修改只由播放器的 `pictureTakesEdits` 说**（`takesPictureEdits`：没有画面、画面失败或停了、OBS 恢复到了上限、上一版被拒绝时为否），编辑器照它标「正在送到 OBS」或「停下重播才生效」（`apps/desktop/src/renderer/src/link/view-models/picture-on-air.ts`），别处不自己判断。接不了的一版让这首歌的画面标红停下，音乐和时间码照常（2026-10-30）。音频本身和 MTC 起始码照旧等停下；P1 跟随不变。细节见 `docs/OBS_SCENE_WORKFLOW.md` 2026-11-12 R9 那一条（`packages/core/src/output-rules.test.ts` 规则 11、`live-edit-rules.test.ts`「S8b 第二部分」、`picture-on-air-rules.test.ts`、`obs-program-session-retarget.test.ts`、`native-obs-host-retarget.test.ts` 守着）

## 一首歌的音量

`packages/core/src/link-command.ts` 的 `setItemVolumeCommand`、`savedSongVolume`（2026-11-12）：每首歌自己的音量存在工程里，播放条的滑块就是它，松手保存，一次拖动一步撤销。保存的音量只随工程的版本到节目：拿着的歌由 `liveRevisionEffect.volume` 当场生效，别的歌开始时读最新一版，别处不单独发音量。拖动时的试听走 `previewVolume(itemId, volume)`，只有台上那首听得到，不保存；MIDI CC7 是这一遍的临时音量（`overrideVolume`），不写工程，换歌或停止就清掉，拖播放条会接过去。输出音量只在 `NativeProgramPlayer.outputVolume` 算：有 CC7 用 CC7，否则用最新一版保存的。P1 跟随时音量由 P1 管。见 `docs/SONG_VOLUME.md`（`song-volume-rules.test.ts` 守着）

## 一首歌的节拍

`packages/core/src/song-beats.ts` 的 `songBeats`（2026-11-11）：每首歌一份，按音乐的源文件存在 `rundownItem.music`，编辑器和灯光工作台都从它读，经音频片段换算到歌曲时间，剪切、移动音频不用重新识别。只用 `setSongMusicCommand` 改；旧工程的两种节拍只在 `document-store.setProject` 打开时搬一次（`song-music-migration.ts`）。显示疏密只在显示时定，不存进工程；包络分析（“分析音乐”）不出节拍。识别是编辑器和灯光工作台共用的一次（`components/useMusicBeatSegments.ts`，按歌记着，哪一页看到结果就写一次）；节拍的写入在播放中或运行时在忙时都等停了再写。没装识别组件的电脑才给“简易检测”（IBT），点了才跑，写入守同一条规矩；编辑器不再有自己的检测。手动踩点（Ctrl+J，2026-11-12）也写进这一份：只经 `addSongBeats`（`editMusicStructure` 的 `add-beats`，50 ms 以内已经有拍点就不重复加），播放中踩的先记在 `useMusicBeatSegments.ts`，停了一起写、算一步。编辑器吸附的节拍只在 `components/timeline-snap-points.ts` 的 `songBeatSnapPoints` 算：当前疏密下显示出来的节拍加段落的边，看得见的才吸，按下时放进拖动和修剪的快照；灯光工作台照旧吸全部节拍（`editor-rules.test.ts` 规则 7、8、9 守着）

## 波形

主进程 `apps/desktop/src/main/link/waveform-service.ts`（2026-11-11）：一次解码出多级峰值、45–180 Hz 节奏波形和频谱（`waveform-levels.ts`），按 sha256 存在工程的 `cache/waveforms/<sha>.levels.bin`；`<sha>.json` 照旧写成 0.5.8 能读的纯数组，不改它的格式。界面只用 `useSongWaveform` 拿、`WaveformCanvas`（`view-models/waveform-draw.ts`）画，不解码整首音频，不引入波形库（`editor-rules.test.ts` 规则 5 守着）

## 一首歌多长

`packages/core/src/audio-edit.ts` 的 `songDurationMs`（2026-11-11）：存了总长（`referenceAudio.timeline.durationMs`，音乐后面留了空白）就用它，否则到最后一段音频的结尾。前后空白读 `songLeadBlankMs`、`songTailBlankMs`，改片段以后的总长用 `editedSongDurationMs`（空白不会被改片段吃掉，片段拖过总长歌就变长），加空白用 `padAudioTimeline`（按工程帧率取整到帧）。音频只由主进程 `audio-edit-service.ts` 的 `mix` 渲染到这个长度，尾空白是真的静音采样；`referenceAudio.durationMs` 等于歌曲总长，schema 守着。没存总长的歌，缓存名和渲染结果和 0.5.8 逐字节一样。别处不再自己取“最晚片段的结尾”当歌的长度

## 一首歌前后的空白

`packages/core/src/song-padding.ts` 的 `padSongCommand`（2026-11-11）：一条命令、一步撤销。音频先渲染好（`padSongRender` 给主进程渲染的参数）再交进来，对不上就不写。内容按整帧挪（`content-timeline.ts` 的 `shiftContent`），音频和灯光按同样帧数的毫秒挪（`lighting-shift.ts` 的 `shiftLightingDocument`：节拍锁定的片段换成时间锁定、带节拍锚点）；MTC 起始码、控台时间线的起点和 MA2 基线不动，差异按普通改动改写控台一次。能去掉多少空白、被什么挡住只由 `songPaddingLimits` 算（`songPaddingRoom` 是不带原因的那一份），碰到最早或最晚的内容就停。P1 跟随的工程不能用；演出没停止时也加不了：界面问 `showGate` 的 `audio.render`，主进程在播放时不生成音频。编辑器的入口是音频轨两端的空白手柄和音频属性的「前空白」「后空白」（2026-11-12），都经 `components/song-padding-flow.ts` 的 `padSongSteps`（先生成音频、同一组数字写命令）；整首挪过的歌到控台确认之前按以联动台为准写，记下和忘掉只在 `ma2-edit-times.ts` 的 `noteMa2LocalEdits`（`runtime/ma2-song-shift.ts`）。别处不自己整首平移（`song-padding-rules.test.ts` 守着）

## P1 跟随

跟随 P1 整个在主进程里做（0.5.9，2026-11-12）：界面卡住、重新加载都不影响正在跟的歌。和联动台播放是明确选的两种方式，互相不自动切换。

- **规则只在 `packages/core/src/p1-follow-session.ts`**（`P1FollowSession`）：P1 的时间码在走、停了还是换了一首由 `packages/core/src/p1-clock.ts` 说，这里定各路输出这时被告知什么、操作员这时能做什么。别处不自己解读 P1 的时间码。
- **主进程 `apps/desktop/src/main/link/p1-follow-host.ts`** 拿着 P1 的时间码输入口（向 `apps/desktop/src/main/link/midi-port-broker.ts` 以「P1 时间码」的名义占用，不经过界面），跑一个 `P1FollowSession`，把状态推给界面（`link:p1-follow-state`，格式在 `packages/schema/src/p1-follow.ts`）。接线只在 `apps/desktop/src/main/link/p1-follow-wiring.ts`，`link-main.ts` 只建一次。
- **界面只经 `apps/desktop/src/renderer/src/link/runtime/p1-follow-client.ts` 发命令**（`link:p1-follow`），状态只落在 `apps/desktop/src/renderer/src/link/stores/p1-follow-store.ts`，显示走 `apps/desktop/src/renderer/src/link/view-models/status-center.ts` 的 `p1FollowStatus`。界面不解时间码、不订阅 MTC 输入、不驱动任何输出。
- **输出用联动台播放的那一套，不另写一份。** 动作 MIDI 经 `apps/desktop/src/main/link/p1-midi-output.ts` 接到同一个 `NativeMidiHost` 和 `MidiProgramSession`（晚到规则、端口恢复都一样）。输出列表在 `apps/desktop/src/main/link/p1-follow-outputs.ts`：一路出错不连累别的；输出出错走它自己的状态和运行日志，不往跟随里抛。
- **画面是这个列表里的又一项**（0.5.9，2026-11-12）：`apps/desktop/src/main/link/p1-picture-output.ts` 把 P1 的时钟交给 `link-main.ts` 里唯一的那个 `NativeObsHost`（同一个 `ObsProgramSession`、停歌留最后一帧、OBS 重连、读回“画面在不在跟”），宿主不分两份：跟随给它一个“这首歌在哪”的来源（`native-obs-host.ts` 的 `PictureClockSource`），就像动作 MIDI 的 `MidiClockSource`。播放器的时钟和控制碰不到跟随的画面，P1 的时钟也碰不到节目的。P1 放的音乐不经联动台的音乐项进 OBS，读回也不找它。界面不为 P1 驱动画面。
  - **同一时间只归一家**：另一家（另一个工程的节目，或跟随）的歌在台上或正在准备画面时，后来的那一家被拒绝并写明原因，这一路标红，音乐、时间码、动作 MIDI 和灯光照常（2026-10-30）；正在用的画面不被抢走。停下的歌不占着画面（它的最后一帧等下一首的画面上了再撤）。
  - **开始跟一首歌不等画面**：画面在后台准备，准备好了按 P1 那一刻的位置接上（宿主的“音乐先开始、画面晚到”），之前的不补；对 P1 这是常态，不标红，只有没接上的部分标红。准备不了就这一路标红写原因，别的照跟。没有画面的歌不准备。
  - **冻结**：点动作和机位停在原地，不补；手动模式素材照放（时间码丢了或跳变，P1 还在放），自动选歌素材暂停（P1 停了）。
  - **接着跟**：自动选歌从同一位置继续，素材接着放、对到真实位置，这一遍发过的不重发；手动「重新同步」按这个位置对一次，此刻的机位和素材出现在 OBS，过去的点动作不补。冻结前在放的那一遍留在最后一帧，新的一遍上了再撤。
  - **停下**：P1 换歌、在联动台按停止，画面留在最后一帧，和联动台播放同一条规矩（`ObsProgramSession.stop`、宿主的 `holds`）；跟随关掉、被同一界面的新一版换掉、退出软件时放开，和关掉节目一样。界面没了不碰在跟歌的跟随的画面（`closeEngine` 的 `nativeObs.close()` 只关播放器的歌）。这首歌的画面还在准备（上一首还在收拾、输出还没做好）时停下或关掉跟随，准备当场作废，这首的画面一点不发、做出来的输出放开（`native-obs-host.ts` 的 `stopSource`、`closeSource`）；上一首迟到的停止不会把正在准备的这首作废。
  - **视频自己的声音**：和 0.5.8 一样只看片段自己的开关（`compileManagedMediaTimeline`）。画面快照记着谁放音乐（`obsProgramSnapshotSchema` 的 `playbackSource`：P1 的歌写 `p1`，联动台播放的歌不写这一项，快照和以前一样），画面工程照它还原；画面会话里只有 Cue 的时钟（`CueRuntime`）拿到按联动台播放走的那一份（`obs-program-session.ts` 的 `cueClockProject`），因为它只跟着会话给的位置走。
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
