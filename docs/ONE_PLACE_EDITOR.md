# 只有一处实现 · 界面、时间线和按键

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 顶栏和各处显示的状态

`view-models/status-center.ts`

## 内容时间线的放置、移动、修剪

`packages/core/src/content-timeline.ts`

## 拖动、修剪时落在哪

`apps/desktop/src/renderer/src/link/components/drag-preview.ts`（2026-11-11）：按下时拍一份快照（时间线在屏幕上的位置、每条轨道的位置、吸附点），之后每帧用 `dragTarget`、`trimTarget` 算一次，直接写到页面上，松手才发一条命令；放置和修剪的规则仍只在 `content-timeline.ts`。音频片段、灯光点的拖动和框选用 `useFramedDrag` 每帧算一次。拖着的时候给人看的提示也在这里每帧算、直接写到页面上：吸附线和它的颜色（`snapGuideAt`）、修剪时的时长和碰到边界（`trimFrame`）、要不要提示「放到新轨道」（`showsNewTrackAbove`）、拖到左右边上自己滚（`EdgeScroll`，经 `useTimelineViewport` 的 `scrollLeftTo` 滚）。按住 Alt 不吸附从指针事件的 `altKey` 读，不听按键；播放中不吸播放头；吸附关着或按住 Alt 时仍落在整帧上。编辑器的吸附开关记在这台电脑（`stores/timeline-view-store.ts`），以后时间线的界面偏好也放这里。不再用 `elementFromPoint` 找轨道，不在每次鼠标移动时更新 React 状态（`drag-preview.test.ts` 和 `editor-rules.test.ts` 规则 10 守着）

## 时间线滚动到哪

`apps/desktop/src/renderer/src/link/components/timeline-scroll.ts`（2026-11-11）：滚动位置在 React 外（`TimelineScroll`），只由 `useTimelineViewport` 写；React 只在滚过 512 px 时知道，按那一格的窗口（`view`）决定画哪些。要精确跟着滚动的东西（播放头上的时间、贴在左边的名字、拖着的片段）用 `useScrollPaint` 直接写到页面上；页面上的部件都按 `timeline-geometry.ts` 的 `timeToX` 定位，节拍小旗只画窗口里的、相邻至少 8 px（`beatMarksInView`）。不再把滚动位置放进 React 状态

## 按键谁来处理

`apps/desktop/src/renderer/src/link/keys/`（2026-11-11）：窗口上只有 `key-router.ts` 一个按键监听，一次按键归谁由 `key-route.ts` 的 `routeKey` 按“输入框、弹窗、拖动、页面、全局”的顺序定，键位在 `keymap.ts` 一张表。组件自己用的键用 `ownKeys` 声明；Esc 能关的面板、菜单和列表用 `useKeyOverlay` 登记，由路由关最上面那一个，自己不听 Esc；拖动用 `useDragSession`（Esc 能取消）或 `useCapturedDrag`（边拖边写、取消不了）登记，拖动中的 Esc 和会改工程的键由路由拦，拖动自己不听按键（都由 `key-routing-scan.test.ts` 守着）。键位和规则见 `docs/KEYBOARD_SHORTCUTS.md`：Esc 照旧停止，Shift+Esc 在哪儿都能停，按住 Enter 只算一次，编辑器和灯光工作台照剪映（`key-routing-rules.test.ts` 守着这几条）。不再往 window 或 document 上新加 keydown 监听：`eslint.config.mjs` 的 `KEY_LISTENER_RESTRICTIONS` 在 `link/keys/` 以外拦 `addEventListener('keydown'|'keyup')`、`onkeydown =` 和 `onKeyDownCapture`，`key-routing-scan.test.ts` 用同一份规则扫源码，并要求有 `onKeyDown`、`onKeyUp` 的文件用 `ownKeys` 声明自己的键；组件的按键处理里不用 `stopPropagation`，只有祖先元素也处理同一个键时才留（比如菜单经 portal 冒泡）。时间线的按键也在路由上（2026-11-11）：编辑器和灯光工作台的时间线键用 `useKeyCommands` 登记到各自的范围；编辑键作用在哪一样东西、剪辑点和修剪到播放头在 `components/timeline-commands.ts`；用户改的键见下一行

## 用户改的键

`apps/desktop/src/renderer/src/link/keys/key-settings.ts`（2026-11-11）：哪些键能改、撞键怎么算、随时停止的键能是什么、歌曲快捷键的检查都在这里。只存改过的，在这台电脑 `localStorage` 的 `tblink.key-overrides`；0.5.8 的 `tblink.timeline-shortcuts` 只读一次来搬，不再写，退回 0.5.8 时它还在。状态在 `stores/shortcut-store.ts`，由 `keymap.ts` 的 `resolveKeymap` 放进键位表，路由和界面上的键名都读 `currentKeymap`。新加一个能改的操作只要在键位表里标 `rebindable: true`；剪映没有键的操作（上一个 / 下一个节拍）不给默认键（`keys: []`），由用户自己设
