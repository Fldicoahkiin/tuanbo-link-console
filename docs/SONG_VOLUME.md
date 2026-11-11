# 每首歌自己的音量

2026-11-09 用户原话：“然后加一个功能，就是每一个节目我可以给他一个单独的音量，可以保存，而不是统一所有节目都是一个音量”。

状态：已实现，自动化验证通过，**未实机验证**（没在现场 Windows 上拖过滑块、没用实体调音台推子试过 CC7）。

## 规则

1. 播放条的音量滑块就是“这首歌”自己保存的音量：挂着歌（准备中、播放中、暂停）时是挂着的那首，否则是选中的那首；都没有就不能用。提示写“这首歌的音量，松手后保存进工程”。
2. 拖动中声音立刻跟着变，工程不改；松手时只保存一次，一次拖动是一步撤销。用键盘时每按一次就保存，同一次聚焦里连按算一步撤销。
3. 没有播放设置的歌第一次设音量时，补上的默认播放设置不改它的 MTC 起始码（沿用它原来播放用的起始码）。
4. 播放中保存的音量一变（松手、撤销、重做、节目属性里的“歌曲音量”），正在播的这首立刻按新音量放；暂停后继续、定位、淡入都回到“MIDI 临时音量，没有就用保存的音量”，不弹回旧值。之后连播到的歌也按它现在保存的音量开始。
5. MIDI CC7（调音台推子）只是这一遍的临时音量：不存工程、不进撤销；换歌或停止后清掉。播放条旁边显示“MIDI 临时 N%”。动播放条滑块时临时音量让给滑块。
6. 节目属性里的“歌曲音量”挂着歌时也能改，和滑块是同一个修改、同一个值；其余播放属性仍然停下后才能改。
7. P1 跟随时音量归 P1：播放条没有这个滑块，节目属性的音量旁写明“只用于联动台播放；P1 跟随时由 P1 控制音量”。
8. 编辑器和灯光工作台没有改：用联动台播放试听时走同一个节目，所以按这首歌保存的音量放、改了立刻生效；它们自己的本地预览（页面里的音频）照旧按原始音量放。编辑器“常用”属性里的音量仍然停下后才能改。

## 代码在哪

| 事情 | 位置 |
| --- | --- |
| 保存音量的修改、默认播放设置、读保存的音量 | `packages/core/src/link-command.ts`：`setItemVolumeCommand`（撤销分组 `song-volume:${itemId}:${gestureId}`）、`defaultItemPlayback`、`savedSongVolume` |
| 滑块的拖动和按键怎么变成试听或保存 | `packages/core/src/song-volume-gesture.ts` |
| 节目里的保存音量、临时音量和输出 | `packages/core/src/native-program-player.ts`：`setSongVolume`、`previewVolume`、`overrideVolume`、`outputVolume` |
| 保存的音量送到正在播的节目 | `apps/desktop/src/renderer/src/link/runtime/song-volume-sync.ts`，在 `useInternalPlayer.ts` 里挂到工程修改上。这是版本流（设计 059 §3.3）之前的音量专用替代，版本流做好后删掉它 |
| 播放条滑块、节目属性音量 | `components/ProjectPlayerControls.tsx`（`SongVolumeSlider`）、`view-models/song-volume.ts`、`components/SongPlaybackProperties.tsx`（`SongVolumeField`）、`components/ProjectLibrary.tsx` |
| IPC | `packages/schema/src/native-program.ts`：`volume`（带 `preview: true`，只给拖动试听）、`songVolume`；状态里的 `volumeOverride` |

规则测试：`packages/core/src/song-volume-rules.test.ts`。
