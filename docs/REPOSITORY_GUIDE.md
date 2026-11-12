# 仓库维护与开发说明

> 这份说明较早，只作记录。现在的结构和改代码的步骤见 [ARCHITECTURE.md](./ARCHITECTURE.md)，规范、检查命令和发版流程见 [AGENTS.md](../AGENTS.md)；不一致时以它们为准。

## 目录职责

| 目录 | 职责 |
|---|---|
| `apps/desktop/src/main` | Electron 主进程、OBS、进程生命周期、安全存储、文件适配器和最小 IPC |
| `apps/desktop/src/preload` | 类型化桥接 API；修改后重启开发进程 |
| `apps/desktop/src/renderer/src/link` | 工作区、属性界面、状态存储、播放与 Cue 协调器 |
| `apps/desktop/src/renderer/src/registry` | 内部音频输出和 MIDI（经主进程 `MidiPortBroker`，不用 Web MIDI）等界面侧适配器 |
| `packages/schema` | 工程格式、本机集成档案和 Zod 契约 |
| `packages/core` | Command、Cue、MTC、节拍跟踪和领域规则 |
| `tools` | MA2 Lua 桥接、OBS 原生预览相关源码和辅助工具 |
| `scripts` | 构建产物检查、安装验收与发布清单生成 |
| `docs` | 当前设计、操作说明、实施状态和历史验收记录 |
| `.agents/skills` | 仓库现有设计与开发技能说明 |

## 修改规则与注释

所有工程修改经 `LinkCommand` 和 `useDocumentStore.execute`，不得从组件直接改工程对象。遵循 Schema/Domain → Adapters → Store/Runtime → Components → 最小 IPC 的分层；IPC 仅传 DTO。外部失败应明确报告，不隐藏重试、不切换正式计时来源。

代码注释优先解释接口所有权、边界条件与启动顺序，而不是重复语法。例如：音频输出适配器保留共享监测源，返回给频谱和电平组件的是各自拥有的克隆音轨；组件卸载只关闭自己的音轨。播放器发布播放状态与 `audio.play()` 完成之间存在异步间隔，监测订阅必须在已准备的音频图上建立，不能仅因 HTMLAudioElement 仍处于 paused 而拒绝。

文档必须区分“已实现”“自动化验证”“本机联调”“实体控台验收”。不把测试通过写成现场设备全部通过，不把 UI 仿照写成第三方专有算法复刻。

## 验证命令

在 Windows PowerShell 执行：

```powershell
pnpm typecheck
pnpm test
pnpm lint
pnpm build
pnpm verify
pnpm --filter @tb/desktop test:e2e
```

`pnpm verify` 包含类型、单测、lint、构建及桌面产物检查；Electron e2e 和实体设备验收另行运行。涉及 OBS、MIDI 或 MA2 的现场测试前，应检查目标设备与节目，并使用隔离测试工程。

## Git 与发布

本仓库新建为私有源码仓库；旧安装版保留其历史更新地址，新源码已切换公司 HTTPS 更新源。默认不自动发布版本。`.github/workflows` 中现有发布流程仅在推送 `v*` 标签时触发；根包、桌面包和发布标签必须一致；当前流水线只生成候选草稿 Release，不自动同步腾讯云。完整关系见 [版本与部署链路](RELEASE_CHAIN.md)。

提交采用 Conventional Commits。依赖通过锁文件安装，不提交 node_modules、构建产物、历史安装包、验收 user-data、音视频测试缓存、密钥或环境变量。本地文件仍保留，排除规则见根目录 `.gitignore`。

用户工程与媒体应由使用者单独备份；仓库不能替代 `.tblink` 及其 assets 目录备份。文档中的历史本机路径和验收记录仅用于追溯，不表示新电脑存在同一路径或已经完成相同验收。
