# 团播联动台 · 架构说明

2026-11-12 按 0.5.9 的代码整理。这是一张地图：软件由哪几部分组成，一首歌从按下播放到出声、出画面、出灯走哪条路，每件事归谁管，改代码时按什么步骤来。

规则本身不在这里：最高规范是 [AGENTS.md](../AGENTS.md)，灯光、MA2、时间码和播放以 [LIGHTING_WORKFLOW.md](./LIGHTING_WORKFLOW.md) 为准。这份文档和它们冲突时以它们为准，并把这里改对。

写给以后改这份代码的人和 AI 模型。动手之前先读第 1 节和第 11 节。

## 1. 先记住的六件事

1. **现场在用，稳定性第一。** 直播间每天拿它开播。一个改动宁可少做，不可让正在播的歌出问题。
2. **演出在主进程里跑，界面只发命令、照着状态显示。** 界面卡住、重新加载、崩溃，都不能影响正在播的歌。不要把计时、发时间码、切画面、发 MIDI 的逻辑放回界面。
3. **同一件事只有一处实现。** 哪件事在哪一处，列在 AGENTS.md 第 4 节的表里。新功能接到已有的那一处上，不另开一条路。历史上反复出现的问题，根因几乎都是同一件事有了第二份实现。
4. **外部设备出错要明说。** 返回、显示、记日志，三样都要。不悄悄重试，不悄悄换一条路，不把“命令发出去了”当成功。允许的自动恢复只有 `packages/core/src/output-recovery.ts` 里那几样，次数也只写在那里。
5. **等待不算失败。** 断线、播放中、编辑中都只是等，界面标黄、写明在等什么；到了上限或确实失败才标红。一首歌失败不挡别的歌。
6. **规则测试守着用户定下的规则。** 名字里带 `rules` 或 `scan` 的测试红了，是代码违反了规则，不能靠改测试过关。AGENTS.md 和 LIGHTING_WORKFLOW.md 里带日期的决定是用户定过的，不要悄悄改回去。

## 2. 由哪几部分组成

| 部分 | 在哪 | 做什么 |
| --- | --- | --- |
| 主进程 | `apps/desktop/src/main/link-main.ts`、`apps/desktop/src/main/link/` | 演出本身：节目会话、音频引擎、时间码、动作 MIDI、OBS 画面、MA2 连接和同步、关灯清单、演出状态、授权、更新、日志。`link-main.ts` 只做装配和登记 IPC，逻辑在 `link/` 下各自的文件里 |
| 预加载 | `apps/desktop/src/preload/index.ts` | 界面能调用的全部接口：`tbLink`（功能）和 `tbFile`（文件）。界面碰不到 Node 和 Electron |
| 界面 | `apps/desktop/src/renderer/src/` | 节目单、编辑器、灯光工作台、设置和状态显示。改工程、发命令、显示主进程送来的状态 |
| 播放引擎 | `tools/playback-engine/`（C，随软件发布的一个可执行文件） | 声卡出声（WASAPI）和发 MIDI 时间码；同一个文件换参数还负责动作 MIDI 输出、MIDI 输入和设备列表。主进程经 `native-playback-client.ts`、`native-midi-output.ts`、`native-midi-input.ts` 各起各的进程 |
| 领域规则 | `packages/core/src/` | 不依赖 Electron 和 Node 的纯规则：命令、时间线、Cue、时间码、画面该是什么、恢复次数、演出状态。主进程和界面都用它 |
| 契约 | `packages/schema/src/` | `.tblink` 工程格式、本机设置、IPC 传的每一种数据的 Zod 定义 |
| OBS 组件 | `tools/obs/` | 实时画布用的原生预览桥和美颜，装进 OBS |
| MA2 插件 | `tools/ma2/tblink_bridge.lua` | 装进控台的 Lua 插件，联动台经它读写时间线 |
| 服务端 | `apps/licensing-server/` | 授权、购买、官网、运营后台、问题反馈 |

依赖只能往一个方向走：

```text
packages/schema  ←  packages/core  ←  主进程（main/link）
                                   ←  预加载（只用类型）
                                   ←  界面（renderer）
```

- `packages/schema` 只依赖 zod。
- `packages/core` 只依赖 `@tb/schema` 和几个纯计算的库，不碰 `node:`、Electron、React。
- 主进程和界面互相不引用对方的文件；它们之间只有预加载里登记的 IPC，传的都是 `packages/schema` 里定义好的数据。
- IPC 只在 `link-main.ts` 的 `handle` 里登记：它只认主窗口，并在这里过授权检查（哪些要授权只在 `apps/desktop/src/main/link/license-access.ts` 的 `needsProductLicense` 定）。IPC 不做业务判断，只转给 `link/` 下的服务。

界面内部（`apps/desktop/src/renderer/src/link/`）：

| 目录 | 放什么 |
| --- | --- |
| `ui/` | 公共控件（按钮、菜单、对话框）。不读仓库，不知道业务 |
| `components/` | 页面和部件。只管显示和把操作变成命令 |
| `view-models/` | 把状态算成要显示的东西（纯函数为主），比如 `view-models/status-center.ts` 定顶栏和各处的状态 |
| `stores/` | 界面的状态仓库。工程在 `stores/document-store.ts` |
| `runtime/` | 和主进程打交道的会话：把工程的新版本送过去、MA2 同步、演出状态的镜像 |
| `keys/` | 全部按键的路由和键位表 |
| `../registry/` | 界面这一侧的音频和 MIDI 适配器（MIDI 都经主进程） |

`stores/`、`view-models/`、`runtime/`、`keys/`、`ui/` 不引用 `components/` 里的东西。`ui/` 也不读 `stores/`、`runtime/` 和 `../registry/`；`../registry/` 不引用上面任何一层。

这一节的方向都有自动检查：规则写在根目录 `eslint.config.mjs` 的 `LAYER_RULES`，`pnpm lint` 会拦越界的引用；`apps/desktop/src/main/link/layer-rules.test.ts` 在 `pnpm test` 里用同一份规则把源码扫一遍，并且一条一条证明规则真的会报。要改方向先问用户，不要为了让引用通过去放宽规则。

## 3. 一首歌从按下播放到各路输出（联动台播放）

```text
界面：点播放
  → tbLink（预加载）→ link-main.ts 的 IPC
  → NativeProgramService   一个窗口页面一个长期的节目会话，拿着工程的各个版本
  → NativeProgramHost      这个节目的全部输出在这里接到一起
  → NativeProgramPlayer    （packages/core）开歌、暂停、定位、换歌、播完后做什么
        │
        ├─ 音频 + 时间码   NativePlayerService → 播放引擎进程（声卡位置就是节目时间，时间码由它发）
        ├─ 动作 MIDI       NativeMidiHost → MidiProgramSession（packages/core）→ MIDI 输出进程
        ├─ 画面            NativeObsHost → ObsProgramSession（packages/core）→ OBS（obs-websocket）
        └─ 灯光            控台自己按时间码跑灯；联动台只在停止和换歌时关执行器（LightingOffService）
```

要点：

- **节目时间只有一个来源：声卡实际播到哪。** 播放引擎报位置，主进程把它变成 `ProgramClock`（`packages/core/src/program-clock.ts`），分给动作 MIDI 和画面。下游只读 `ProgramClock`，不自己计时，不读界面的任何时钟。
- **开一首歌做什么**只在 `packages/core/src/program-start.ts` 定：没有音频的歌放不了，其余都只是某一路输出参不参加。画面准备失败也照常放音乐、发时间码，画面标红。
- **时间码**只有播放引擎一条发送路径，从这首歌的 MTC 起始码发。灯光永远靠时间码驱动，没有“直接发 MIDI 跑灯”的路。
- **每一路输出自己报告自己的状态**，汇到播放器状态里，界面照着显示。一路出错不拖另一路。
- **MIDI 端口**都由主进程的 `midi-port-broker.ts` 开关。界面不用 Web MIDI。
- **停止**时：音频和时间码停；画面留在最后一帧（`ObsProgramSession` 的 `stop`，下一首的画面上了再撤）；这首歌用过的执行器关掉，没发出去的关灯记在清单里。

每一路输出谁做主：

| 输出 | 做主的地方 | 出错时 |
| --- | --- | --- |
| 音频 | `native-player-service.ts` 和播放引擎 | 断流自己恢复，到上限停这首歌 |
| 时间码 | 同上（引擎从声卡位置算出来发） | 端口插回自动恢复；发送失败到上限这首歌不再发 |
| 动作 MIDI | `native-midi-host.ts`，规则在 `packages/core/src/midi-program.ts`、`midi-late-rule.ts` | 晚到的按规则发或跳过，端口插回从下一个动作接着发，不补发 |
| 画面 | `native-obs-host.ts`，规则在 `packages/core/src/obs-program-session.ts` | 标红，音乐和时间码照常；按此刻该有的样子补一次 |
| 灯光 | 控台自己（按时间码）；关灯在 `lighting-off-service.ts` | 没发出去的关灯留在清单里，控台连上后补发一次 |

次数和等多久都不写在这些文件里，只在 `packages/core/src/output-recovery.ts`（第 9 节）。

相关文件都在 `apps/desktop/src/main/link/`：`native-program-service.ts`、`native-program-host.ts`、`native-player-service.ts`、`native-midi-host.ts`、`native-obs-host.ts`、`native-obs-outputs.ts`、`lighting-off-service.ts`。

## 4. 工程和它的版本

- 工程（`LinkProject`，`.tblink`）的格式只在 `packages/schema/src/link-project.ts`。
- **改工程只有一条路**：做成一个 `LinkCommand`（`packages/core/src/link-command.ts` 等），交给界面的 `useDocumentStore.execute(command)`（`apps/desktop/src/renderer/src/link/stores/document-store.ts`）。组件不直接改工程对象。撤销、重做、未保存标记、版本号都在这里。
- 每执行一条命令，版本号加一。界面把新版本送给主进程的节目（`runtime/program-document-feed.ts`，`link:native-program-document`）：一次只有一个在路上，只带改过的歌；主进程用同一套检查收下。
- **正在播的那首歌照开始那一版放**。新的一版里哪些当场生效、哪些等它停下，只在 `packages/core/src/live-revision-effect.ts` 的 `liveRevisionEffect` 定，见 AGENTS.md 表里「拿着歌时改工程」一行。下一首总是按最新一版放。
- 播放中哪些修改要等，界面在提交前问演出状态（下一节），不是各处自己判断“在不在播放”。
- 保存、另存、恢复副本在主进程 `link-project-service.ts`、`project-document-service.ts`。工程里不存密码、MIDI 端口名、外部程序路径，这些在本机设置里。

## 5. 状态从哪来

- **演出现在在哪一步、这时能做什么**：规则在 `packages/core/src/show-state.ts`（`deriveShowState`、`showGate`），由主进程 `show-state-service.ts` 每次重新算，界面只镜像（`stores/show-state-store.ts`）。新的“播放时不能做”都问 `showGate`。主进程在收到请求时再问一次，说了算的是主进程。
- **顶栏和各处显示的状态**：`view-models/status-center.ts` 一处算。
- **能算出来的不存。** 配对、待同步、控台在不在跟、画面在不在跟，每次从事实重新算，不写进工程。
- **要有读回才写“已经好了”。** “已连接”“在跟”“已关灯”都要有读回的依据；读不到就写“无法确认”和原因。

## 6. 画面（OBS）

- 联动台不合成画面。解码、合成、转场都是 OBS 的事；联动台只经 obs-websocket 切场景、放素材、设联动台自己场景项的样子。
- **只碰自己的东西**：固定前缀的自有场景、里面的场景项和媒体输入，加上用户在实时画布里选中的来源，再加上目标场景里那一个联动台的音频项。不改、不删用户别的来源。
- **某一帧该显示什么**只由 `packages/core/src/scene-output-timeline.ts` 的 `pictureAt` 定。正式播出、预览、时间线变暗、预载都从它读。
- **画面会话** `packages/core/src/obs-program-session.ts`：拿着 `ProgramClock`，把“此刻该有的画面”和账本（`obs-picture-ledger.ts`，OBS 里现在实际是什么）对一遍，只发差别。
- **失败怎么算、补不补**：分级只在 `obs-program-session.ts` 的 `verdictOf`，补不补只在 `packages/core/src/picture-reconcile.ts`，次数在 `output-recovery.ts`。
- **请求的先后**：`apps/desktop/src/main/link/obs-request-scheduler.ts`。切画面的请求单独一档；每个请求默认 2 秒超时。
- **素材提前准备**：`obs-media-preload.ts`（哪个解码器给谁用）和 `obs-media-scenes.ts`（素材场景和样子）。这两处按现场实测调过，改之前先读 [OBS_SCENE_WORKFLOW.md](./OBS_SCENE_WORKFLOW.md)。
- **OBS 断了**：只有 `obs-reconnector.ts` 重连，回来以后只有 `native-obs-host.ts` 的 `reconnected()` 恢复画面。
- **画面在不在跟**：`packages/core/src/picture-follow.ts`，每秒读回一次，认得操作员在 OBS 里手动切走。

实时画布（在联动台里直接编辑 OBS 已有场景的来源）是另一条线，见 [OBS_REALTIME_CANVAS.md](./OBS_REALTIME_CANVAS.md)。

## 7. 灯光和 MA2

规则全在 [LIGHTING_WORKFLOW.md](./LIGHTING_WORKFLOW.md)，里面有每一条在代码里的落点。动之前必读。这里只说结构：

- 联动台和控台之间有四条线，各有各的用途，互不代替：
  - **MIDI 时间码**：播放时驱动控台跑灯。
  - **Telnet + 控台插件**：读写时间线、同步、走插件的按键（`ma2-network-manager.ts`、`ma2-telnet.ts`）。
  - **网页遥控**：推杆、读回执行器在不在运行（`ma2-live-service.ts`、`ma2-live-playback.ts`）。
  - **动作 MIDI / MSC**：时间线上的单个动作。
- **怎么认控台、怎么配对**：只按编号、时间码节目编号和 MTC 起始码（`packages/core/src/ma2-console-identity.ts`、`ma2-pairing-state.ts`）。不看名字和 IP。
- **同步**只有一个逐首同步（界面 `runtime/ma2-song-sync.ts`、`stores/ma2-sync-store.ts`），节目在走的时候不写控台。
- **关灯**只有一张清单（`packages/core/src/lighting-off-ledger.ts`，主人是主进程 `lighting-off-service.ts`）。别处不自己发 Off。
- **按键和推杆走哪条线**只在 `ma2-executor-channel.ts` 定；点 Cue、按键、推杆值出错不重发。

## 8. 界面里几件容易写歪的事

- **按键**：整个窗口只有 `keys/key-router.ts` 一个监听，归谁由 `keys/key-route.ts` 定，键位在 `keys/keymap.ts` 一张表。不要往 `window` 或 `document` 上加 `keydown`（lint 会拦）。
- **拖动和修剪**：按下时拍快照，每帧算一次、直接写到页面上，松手才发一条命令（`components/drag-preview.ts`）。不在每次鼠标移动时更新 React 状态。放置和修剪的规则只在 `packages/core/src/content-timeline.ts`。
- **时间线滚动**：滚动位置在 React 之外（`components/timeline-scroll.ts`）。
- **波形**：主进程解码、存多级峰值（`waveform-service.ts`），界面只画。界面不解码整首音频。
- **节拍**：每首歌一份（`packages/core/src/song-beats.ts`），编辑器和灯光工作台共用。
- **文案**：按 [UI_COPY_GUIDE.md](./UI_COPY_GUIDE.md)。给人看的文字里不出现代码里的词，`user-copy-scan.test.ts` 扫着。
- **样式**：只用 `styles/tokens.css` 的变量和 `link/ui/` 的公共控件；浮层要经 portal。

## 9. 自动恢复的范围

默认不自动重试。用户授权过的例外都有次数上限，上限和等多久只写在 `packages/core/src/output-recovery.ts`：声卡断流、时间码发送被拒、画面补一次和对不上时校正、OBS 重连和恢复画面、MIDI 端口插回、控台和网页遥控的重新登录、关灯补发。每一次都记运行日志并在界面上写明；到上限就停下等人处理。

要加一种新的自动恢复，是“会改变现场行为的事”，先问用户。

## 10. 测试怎么把关

- 测试以用户在现场手动测试为主；自动化只用单测、类型检查、lint 和正式模式构建检查。推 master 之前在本地全跑一遍（命令见 AGENTS.md 第 6 节），不靠推上去让 CI 试。
- **规则测试**（`*-rules.test.ts`）一条对应用户定的一条规则；**源码扫描**（`*-scan.test.ts` 和规则测试里的扫描）守着“别处不许再写一份”。AGENTS.md 表里的行写着哪个测试守着它。
- **分层**（第 2 节）由 `eslint.config.mjs` 的 `LAYER_RULES` 和 `layer-rules.test.ts` 守着。
- 没在现场 Windows 和实体 MA2 上试过的东西，文档和回复里都写明“未实机验证”，待验证的列在 [plan.md](./plan.md) 开头。

## 11. 改代码的步骤

1. **先找这件事归谁管。** 查 AGENTS.md 第 4 节的表。表里有，就改那一处；表里没有，先搜有没有已有的实现，再决定放哪。不要在调用的地方绕过去另写。
2. **读它引用的文档和守着它的测试。** 动灯光、MA2、时间码、播放之前读 LIGHTING_WORKFLOW.md；动画面之前读 OBS_SCENE_WORKFLOW.md。
3. **分清层。** 纯规则放 `packages/core`（能直接单测）；碰设备、文件、进程的放主进程 `link/`；界面只显示和发命令。跨进程的数据先在 `packages/schema` 里定义。
4. **改工程数据走命令。** 新的修改做成 `LinkCommand`。动了工程格式，看 `packages/schema/src/link-project.ts` 里的版本规则（旧版本打不开的改动要升版本，见 AGENTS.md 第 2 节）。
5. **和演出有关的操作问 `showGate`。** 不自己判断“在不在播放”。
6. **出错的路径和成功的路径一样要写。** 对外的每一步：失败返回什么、界面显示什么、日志记什么。不写空的 `catch`，不加静默的退路。
7. **补测试。** 新规则加规则测试；修 bug 先写一个会失败的测试。不改已有规则测试里的断言；确实是用户改了规则，在同一次提交里写明哪天定的。
8. **本地检查全过再提交。** `pnpm typecheck`、`pnpm test`、`pnpm lint` 和正式模式构建检查。lint 报内存不够（exit 134）是内存上限的问题，不是删规则的理由。
9. **写下来。** 用户能感觉到的改动在 `release-notes/` 下一版的文件里加一条；新定的长期规则写进 AGENTS.md 或对应文档；这份文档里说的结构变了，同一次提交里改这里。

不要做的事（完整清单在 AGENTS.md 第 2、4 节）：

- 不用 `any`、`as any`、`eslint-disable`，不写空 `catch`，不留 `_v2`、`_new` 这类后缀的文件或符号。
- 不为了让测试通过去删、跳过或改弱测试和 lint 规则。
- 不把演出逻辑放进界面，不在联动台播放和 P1 跟随之间自动切换。
- 不动用户在 OBS 里的来源，不强杀进程，不提权，不把密码存进工程或明文文件。
- 不自己决定发版、加功能、砍功能、动服务器；这些由用户定。

## 12. 哪些文档现在还算数

`docs/` 下有一百多份文档，大部分是当时的设计、实施和验收记录，带着日期，**记录的是那一天的情况**。它们和代码或下面这些现行文档不一致时，以代码和现行文档为准，不要照旧文档把代码改回去。

现行的：

- [AGENTS.md](../AGENTS.md)、[CLAUDE.md](../CLAUDE.md)：规范。
- 本文：结构。
- [LIGHTING_WORKFLOW.md](./LIGHTING_WORKFLOW.md)：灯光、MA2、时间码、播放。
- [OBS_SCENE_WORKFLOW.md](./OBS_SCENE_WORKFLOW.md)、[OBS_REALTIME_CANVAS.md](./OBS_REALTIME_CANVAS.md)：画面。
- [KEYBOARD_SHORTCUTS.md](./KEYBOARD_SHORTCUTS.md)、[SONG_VOLUME.md](./SONG_VOLUME.md)、[UI_COPY_GUIDE.md](./UI_COPY_GUIDE.md)。
- [LICENSE_IMPLEMENTATION.md](./LICENSE_IMPLEMENTATION.md)：授权规则。
- [RELEASE_CHAIN.md](./RELEASE_CHAIN.md)、[../release-notes/README.md](../release-notes/README.md)：发版和更新日志。
- [plan.md](./plan.md)：还在等现场验证的事。
