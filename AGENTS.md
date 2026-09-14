# 团播联动台 · Agent 工作手册

本文是本仓库的最高项目规范。所有回复使用简体中文。

## 1. 产品边界

团播联动台是 Windows 原生 Electron 桌面软件，只负责节目单、参考波形、Cue 编排、P1 MTC 跟随、OBS WebSocket/MIDI 动作、受管 OBS 媒体编排、外部程序生命周期、预检和日志。

- OBS 负责正式场景、来源、滤镜、转场、画面和音频。
- 2026-09-14 用户明确授权“允许，按实时双向同步重做”：允许新增随软件部署的 OBS 原生预览桥，并在联动台画布中编辑用户选中的 OBS 已有场景来源、双向同步编辑状态。此授权取代下文对于本功能的 libobs helper 和已有来源修改禁令；不授权删除未选中的来源或控制推流/录像。实施和验收见 `docs/OBS_REALTIME_CANVAS.md`。
- 2026-09-13 用户确定只使用 OBS 场景：每个机位一个场景，切换沿用已有显隐、拉腿、裁剪与滤镜。设置不再提供软件编排/场景切换选项；每个素材使用独立自有 OBS 场景，机位片段结束恢复下层素材对应位置，不修改其他来源。低功率必须可开关，不能删除原有预览功能。详见 `docs/OBS_SCENE_WORKFLOW.md`，该授权取代下文旧受管场景限制。
- 2026-09-10 用户要求保留当前 UI 并对齐其自研 IBC，新增完整场景模式。该模式不得强制进入受管画面或重设用户视觉项；为确保内部音乐跨场景持续输出，允许只在目标场景加入应用自有音频项，既有视觉来源和滤镜保持不变。进度及未完成项见 `docs/IBC_PARITY_20260910.md`。
- 用户于 2026-09-09 授权增加内部主控，正式音频可由联动台播放，实际媒体播放位置驱动时间线并输出 MIDI 时间码。保留 P1 跟随模式；两种模式显式选择，禁止在断线时偷偷切换计时来源或无音频空跑。
- 用户于 2026-09-10 授权实现独立 REAPER 式灯光编排及 MA2 实体控台双向时间线同步，允许 MIDI、局域网与配套 Lua 插件。范围为时间线、Cue 引用和执行器动作，不包括 Cue 内部灯具参数。控台暂未连接，当前实现与实机门槛见 `docs/LIGHTING_MA2_IMPLEMENTATION.md`；不得将离线测试视为完整实机验收。
- 抖音直播伴侣负责登录、直播间和推流；本软件只检测进程和主窗口。
- 联动台只可在固定前缀的 OBS 受管场景中创建、更新和移除自己拥有的场景项与媒体输入；不得修改或删除用户已有来源。视频解码与合成仍由 OBS 完成；内部主控正式音频由本软件播放，并用受管 OBS 应用音频来源送入正式输出。
- 禁止重新引入 Program 窗口、Electron 内置合成、摄像头/麦克风采集、RTMP、NDI、虚拟摄像头或 libobs helper。
- 禁止控制 OBS 推流/录像以及直播伴侣开播/关播。
- 不迁移旧 ShowPackage；普通工程保留 `.tblink` schema v1。用户授权的灯光工程使用 schema v2，确保旧程序拒绝覆盖保存而不会静默丢弃灯光数据。

## 2. 仓库布局

```text
apps/desktop/
  src/main/link-main.ts        Electron 主入口与最小 IPC
  src/main/link/               OBS、进程、安全存储、工程和日志适配器
  src/preload/index.ts         tbLink / tbFile 类型化桥
  src/renderer/src/link/       工作区、store 与运行协调器
  src/renderer/src/registry/   Web MIDI 适配器
packages/schema/               .tblink 与机器集成档案 Zod 契约
packages/core/                 Command、MTC、Cue 状态机、预检与 IPC DTO
docs/                          当前设计、实施和验收文档
```

## 3. 架构硬约束

1. 所有 LinkProject 修改必须封装为 `LinkCommand` 并经 `useDocumentStore.execute(command)`；组件禁止直接改工程对象。
2. 分层方向固定为 Schema/Domain → Registry/Adapters → Stores/Runtime → Components → 最小 IPC，不得倒流。
3. IPC 只传输已定义 DTO，不承载 Cue、时间码、预检等业务判断。
4. 外部边界错误必须明确返回、展示并记录；禁止静默 fallback、吞异常、自动重试或在主控/跟随模式间自动切换。
5. OBS 请求默认 2 秒超时；外部程序只能按精确路径、PID、启动时间和所有权管理。
6. 只关闭本次由联动台启动的进程；拒绝关闭时保留进程，绝不强杀。
7. 项目不保存密码、MIDI 端口名或外部程序绝对路径。OBS 密码只能使用 Electron `safeStorage`。
8. 排练首个失败动作阻断后续；直播失败标红但继续。两者都不自动重试。
9. MTC 丢失或异常跳变冻结自动 Cue。手动模式仍须明确重同步；用户授权的 P1 自动选歌模式允许从 P1 点击切歌/重播启动新会话，同位置继续则恢复并定位视频。未知区间或中途跳变不得猜测和补执行。
10. 禁止 `any`、`as any`、`eslint-disable`、空 `catch` 和补丁式兼容分支。

## 4. 代码与 UI

- TypeScript 使用严格模式，穷举 discriminated union，跨边界用 Zod 校验。
- UI 图标使用 `lucide-react`，禁止 Emoji 图标。
- 正式 UI 任务应加载 `frontend-design` skill；不可用时必须明确说明并遵循现有设计系统。
- TypeScript 任务应加载项目要求的 TypeScript skill；不可用时必须明确说明，不得假装加载。
- 不创建 `_v2`、`_new`、`_fixed`、`_enhanced`、`_refactored` 等后缀文件或符号。
- 修改 preload 后必须完整重启 `pnpm dev`。

## 5. 安全与 Git

- 禁止使用 `rm` 及其任何变体；删除源码使用补丁。
- 不读取用户凭证目录。
- 不使用 `git reset --hard`、强推、删分支或未经确认的破坏性操作。
- 不覆盖用户已有修改；脏工作区必须先报告。
- 未经明确要求不执行 commit 或 push。提交使用 Conventional Commits，不添加 AI 署名。

## 6. Windows 命令

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
| Windows 发布 | `pnpm verify:release` |

发布与真实联调必须在 Windows 原生 PowerShell 环境执行，不使用 WSL 替代。

## 7. 文档

- [README.md](./README.md)：安装、使用和产品边界。
- [docs/DESIGN_BASELINE.md](./docs/DESIGN_BASELINE.md)：不可变设计与执行规则。
- [docs/plan.md](./docs/plan.md)：阶段、完成状态和剩余现场前置条件。
- [docs/link-console-reference-study.md](./docs/link-console-reference-study.md)：S3/IBC 差距矩阵与吸收结论。
- [docs/WINDOWS_ACCEPTANCE.md](./docs/WINDOWS_ACCEPTANCE.md)：Windows 发布和真实联调验收记录模板。
