# 每首歌自己的音量

2026-11-09 用户原话：“然后加一个功能，就是每一个节目我可以给他一个单独的音量，可以保存，而不是统一所有节目都是一个音量”。

状态：已实现，自动化验证通过，**未实机验证**（没在现场 Windows 上拖过滑块、没用实体调音台推子试过 CC7）。

## 规则

1. **播放条的滑块就是这首歌自己的音量。** 联动台播放拿着歌（准备中、播放中、暂停）时是拿着的那首，否则是选中的那首；都没有就不能用。提示写“这首歌的音量，松手后保存进工程”。
2. **拖动时只试听，松手才保存。** 拖动中声音马上跟着变，工程不改；松手时保存一次，一次拖动是一步撤销。用键盘时每按一次保存一次，同一次聚焦里连按算一步撤销。松手以后声音就是保存的值，不会弹回拖动前的音量：拖动最后的值就是保存的值，节目按收到的先后照着做，最后不是这个值就是保存的值（下面“代码在哪”里说为什么）。
3. **拖的不是台上那首就不出声。** 停着时拖选中的歌，只保存，不出声；拖着拖着台上换了歌（播完接下一首、按了下一首），还没到节目的那几下对新的歌不起作用，新的歌照它自己保存的音量放，拖的那首下次照新保存的音量开始。
4. **节目属性里的“歌曲音量”** 和滑块是同一个修改、同一个值。拿着歌时也能改，其余播放属性仍然要停下才能改。
5. **播放中改了音量当场生效。** 保存的音量一变（松手、属性里改、撤销、重做），工程的新一版送到节目，正在播的这首马上照新音量放（`liveRevisionEffect` 的 `volume`）。之后暂停再继续、定位、循环回来、淡入，都回到“MIDI 临时音量，没有就用保存的音量”。连播到的下一首也照它现在保存的音量开始。保存的音量只走工程的版本这一条路，没有另外单独发音量的路。
6. **MIDI CC7（调音台推子）只管这一遍。** 不存进工程，也不进撤销；换歌或停止以后就清掉。播放条旁边显示“MIDI 临时 N%”。CC7 在的时候保存的音量变了，只记下来、不动声音，CC7 清掉以后就是它。之后再拖播放条，播放条接过来，CC7 的临时音量让给滑块。
7. **P1 跟随时音量归 P1。** 联动台不出正式的声音，所以首页没有这个滑块，节目单卡片上的“音量 N%”和首页属性里的“歌曲音量”也不显示。编辑器“常用”里的“歌曲音量”还在，旁边写着“只用于联动台播放；P1 跟随时由 P1 控制音量”：改了会存进工程，等换回联动台播放时才用得上。
8. **编辑器和灯光工作台。** 用联动台播放试听时走的是同一个节目，所以照这首歌保存的音量放，改了马上生效；它们自己页面里的本地预览照旧按原始音量放。编辑器“常用”里的属性（音量也在里面）还是停下以后才能改。

## 代码在哪

| 事情 | 位置 |
| --- | --- |
| 保存音量的修改、默认播放设置、读保存的音量 | `packages/core/src/link-command.ts`：`setItemVolumeCommand`（撤销分组 `song-volume:${itemId}:${gestureId}`）、`defaultItemPlayback`（第一次设音量时补上的播放设置，MTC 起始码沿用 `programTimeOrigin`）、`savedSongVolume` |
| 滑块的拖动和按键怎么变成试听或保存 | `packages/core/src/song-volume-gesture.ts` |
| 节目里的输出 | `packages/core/src/native-program-player.ts`：`previewVolume(itemId, volume)`（只对台上那首起作用）、`overrideVolume`（CC7）、`outputVolume`（CC7 临时音量，没有就是最新一版里保存的音量） |
| 保存的音量送到节目 | 只经工程的版本（`runtime/program-document-feed.ts` → 主进程 `native-program-service.ts` → `NativeProgramPlayer.updateProject`）。拿着的歌照 `packages/core/src/live-revision-effect.ts` 的 `volume` 当场生效，别的歌开始时读最新一版。原来单独发音量的 `songVolume` 控制和 `runtime/song-volume-sync.ts` 已删掉（S10） |
| 播放条滑块、节目属性音量 | `components/ProjectPlayerControls.tsx`（`SongVolumeSlider`）、`view-models/song-volume.ts`、`components/SongPlaybackProperties.tsx`（`SongVolumeField`）、`components/ProjectLibrary.tsx` |
| IPC | `packages/schema/src/native-program.ts`：`volume`（带 `itemId` 和 `preview: true`，只给拖动试听）；状态里的 `volumeOverride` |

为什么松手以后不会弹回：试听和别的播放控制在主进程里排同一个队（`native-program-service.ts` 的 `entry.turn`），按发出的先后到节目；新的一版走另一条路，可能比拖动的最后一下先到，也可能后到。拖动最后一下的值就是保存的值，所以不管哪个最后到，声音都是保存的值。

规则测试：`packages/core/src/song-volume-rules.test.ts`（一次拖动一步撤销、第一次设音量不改 MTC 起始码、播放中改了当场生效、试听和新的一版谁先到都一样、拖的不是台上那首、CC7 不改工程且记着保存的值、CC7 以后拖播放条、换歌清掉 CC7），拿着歌时改工程的部分在 `packages/core/src/live-edit-rules.test.ts`。
