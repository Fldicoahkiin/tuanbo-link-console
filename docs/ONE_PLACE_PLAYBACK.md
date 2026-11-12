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

`packages/core/src/live-revision-effect.ts` 的 `liveRevisionEffect`（2026-11-12）：联动台播放拿着的歌（准备中、在播、暂停、播完停住）照开始那一版放，音频、时间码和画面都按那一版，定位和循环回来也是。新的一版里当场生效的有四样：它保存的音量、它自己的「播完后」、它的灯光会用到的执行器（只增不减，停止时关所有版本用过的，`lighting-off-ledger.ts` 的 `litAlso`、`widen`）、动作 MIDI 在播放头之后的那部分（2026-11-12，`MidiProgramSession.retarget`：过去的不补发、不撤回，已发的 Note On 一定有松开；暂停时改的等继续再用；排不了的一版当场拒绝并写明，照原来的发）。发过的动作只在同一遍里记着：暂停再继续不重发，定位、拖动、循环是新的一遍、照常再发（`NativeProgramPlayer.actionPass`，主进程 `native-midi-host.ts` 只在同一首歌同一遍里带着）。下一首按最新一版找、按最新一版放；提前准备按内容认、不按版本号（`packages/core/src/next-song-identity.ts`），改别的歌不会让下一首重新准备；下一首自己改了，或者换了哪首是下一首（删除、停用、改「播完后」、换播放列表），就在旁边重新准备（`NativeProgramPlayer.followNext`，经 `prepareNextNativePlayback`、`prepareNextNativeObs`，不经台上那首的播放控制，一次只有一个在路上、只要最新的）。台上那首歌的音频本身（`songAudioStructureKey`：音频文件和片段、总长、播放范围、MTC 起始码）、删除和停用要等它停下：界面的仓库在提交前问 `showGate`（`stores/document-store.ts` 的 `stageWait`，撤销和重做也问），只在联动台播放时拦，P1 跟随照旧；就算送到主进程也不碰音频和起始码，只写日志。要播的歌在最新一版里已经删掉或停用就不播，在播的照常（`NativeProgramPlayer.play`）。别处不再因为工程变了去停歌、重开，或者自己判断哪些改动能当场生效（`live-edit-rules.test.ts` 守着）

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
