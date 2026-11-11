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
- 不迁移旧 ShowPackage。普通工程用 `.tblink` schema v1；带灯光数据的工程用 schema v2，让旧程序拒绝覆盖保存，而不是悄悄丢掉灯光数据。
- 不发任何免激活、免授权的包。测试用用户给的激活码。

### 用户授权和定下的事（新的在前，新的取代旧的）

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
4. 外部边界错误必须明确返回、展示并记录；禁止静默 fallback、吞异常、自动重试，或在联动台播放和 P1 跟随之间自动切换。例外只有用户授权并写进文档的几处：第 2 节的 MIDI 端口恢复，LIGHTING_WORKFLOW.md「同步规则」里的重试。
5. OBS 请求默认 2 秒超时；外部程序只能按精确路径、PID、启动时间和所有权管理。
6. 只关闭本次由联动台启动的进程；对方拒绝关闭时保留进程，绝不强杀。
7. 工程不保存密码、MIDI 端口名或外部程序绝对路径，这些放本机设备设置。OBS 密码只用 Electron `safeStorage`，不可用时不降级存明文。
8. 排练时第一个失败的动作挡住后续动作；直播时失败标红但继续。两者都不自动重试。
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
| 顶栏和各处显示的状态 | `view-models/status-center.ts` |
| 内容时间线的放置、移动、修剪 | `packages/core/src/content-timeline.ts` |
| MIDI 端口的开关 | 主进程 `midi-port-broker.ts`。界面不用 Web MIDI：`navigator.requestMIDIAccess` 会占住电脑上全部 MIDI 端口，Windows 报错误 7 或 4 |
| 动作 MIDI 晚到怎么办 | `packages/core/src/midi-late-rule.ts`（2026-11-10）：Program Change、Control Change 照发并标红，Note On、MSC Go 晚 100 ms 以上只跳过这一条，Note Off、MSC Stop 总是发；一条失败不停整路 |
| OBS 请求谁先发 | `apps/desktop/src/main/link/obs-request-scheduler.ts` 的档位和 `pump`：切画面的请求单独一档，始终有位置；截图等画面发完再发 |

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

- 推 master 前跑 `pnpm typecheck`、`pnpm test`、`pnpm lint`。
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
- [docs/RELEASE_CHAIN.md](./docs/RELEASE_CHAIN.md)：发版标准流程；[release-notes/README.md](./release-notes/README.md)：更新日志写法。
- `docs/SERVER_INSTALL_*.md`：每次服务器改动的安装说明和安装结果。
- [docs/OBS_SCENE_WORKFLOW.md](./docs/OBS_SCENE_WORKFLOW.md)、[docs/OBS_REALTIME_CANVAS.md](./docs/OBS_REALTIME_CANVAS.md)：OBS 画面规则。
- [docs/DESIGN_BASELINE.md](./docs/DESIGN_BASELINE.md)：早期设计与执行规则，和后来的授权冲突时以本文第 2 节为准。
- [docs/plan.md](./docs/plan.md)：阶段、完成状态和还在等现场验证的事。
- [docs/link-console-reference-study.md](./docs/link-console-reference-study.md)：S3/IBC 差距矩阵与吸收结论。
- [docs/WINDOWS_ACCEPTANCE.md](./docs/WINDOWS_ACCEPTANCE.md)：Windows 发布和真实联调验收记录模板。
