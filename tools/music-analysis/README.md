# 离线音乐识别验证工具

当前是可复核的本机推理与评估链路，**不是已经通过曲库精度验收的引擎**。2026-10-08 更新后，桌面工作台自动分析并通过 LinkCommand 保存节拍与分段，保留纠错、清除和撤销。Python 分析器本身不写 `.tblink`，不创建灯光 Cue、不调用 MA2、MIDI、OBS；自动应用和人工纠错都不会把模型的 `not-validated` 状态改成通过精度验收。

## 含模型的免激活测试安装包

`node scripts/build-portable-test.mjs <新的输出目录>` 会调用 `package-runtime.mjs`，将预先准备好的 `output/music-analysis/cpu-env`、Python 3.11.9 和全部本地模型复制成自包含运行时，并以 `python311._pth` 隔离系统 Python 与用户包。模型文件和运行时随同 NSIS 安装，用户不需要额外安装或在线下载。测试版明确提供 CPU 模式，正式发布脚本不因此自动加入测试模型包。

打包时校验依赖版本、模型摘要和所有 Python 导入路径，生成逐文件 SHA-256 清单。安装后用 `node scripts/verify-installed-music.mjs <安装后的EXE> <真实WAV> <时长毫秒> <新的证据目录>` 校验安装文件，并通过真实 Electron IPC 执行首轮模型推理与缓存复测；没有替换分析 IPC 或使用开发环境 Python。

许可信息和用途说明见 [DISTRIBUTION_NOTICE.md](DISTRIBUTION_NOTICE.md)。运行成功不等于原计划精度、CUDA 性能或商业再分发条件已经通过。

## 已实现

- 固定 Beat This! `final0/1/2`、All-In-One `harmonix-all`、Demucs 与依赖版本。
- FFmpeg 统一为 48 kHz 双声道 PCM；Demucs 从同一 PCM 重采样为 44.1 kHz。
- 源文件 SHA256、PCM SHA256、采样数、模型摘要、代码／依赖／解码器版本构成结果身份与缓存键。
- 三模型顺序加载、释放；CUDA 不可用时报错，不暗中改用 CPU。CPU 必须显式选择。
- 推理禁止 Python 网络连接，解码器仅允许本地文件协议；模型必须提前准备并通过摘要校验。
- 协作取消、源文件变化检查、缓存损坏拒绝、纯静音拦截。每次使用新输出目录，保留历史证据。
- 一对一节拍匹配、三模型一致候选、节奏密度冲突诊断。模型一致性不作为真实正确率。
- 严格曲库契约：同曲不同版本不跨分组，拒绝重复音源，盲测参考须双人复核。
- 离线波形核对页、原声／点击试听、模型切换、段落与逐拍定位。试听前再次核对 PCM 身份。

## 本机复现

发布包不能运行联网准备脚本。以下是开发阶段的显式准备和验证命令；模型、音频与虚拟环境位于忽略目录，不提交进仓库。

```powershell
# 模型准备会联网；仅在开发阶段运行。
python tools/music-analysis/prepare.py --help

# 本次 Windows 验证环境，已在 RTX 4070 执行 CPU/CUDA；曲库性能仍未验收。
$musicPython = 'output/music-analysis/env/Scripts/python.exe'
$musicFfmpeg = 'node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg.exe'
& $musicPython tools/music-analysis/analyze.py `
  --audio '音乐文件的完整路径' `
  --bundle output/music-analysis/models --ffmpeg $musicFfmpeg `
  --device cpu --engines full `
  --output output/music-analysis/独立运行目录 --cache output/music-analysis/cache

& $musicPython tools/music-analysis/review.py `
  --run output/music-analysis/独立运行目录 `
  --output artifacts/music-analysis-独立核对目录
```

`--cancel-file` 指定协作取消文件。运行期间创建该文件，当前模型阶段结束后取消；这不是模型运算中的即时暂停。取消不会交付结果。退出码 `130` 为取消，`1` 为失败。直接运行 `analyze.py` 的 stdout 仍可能包含第三方日志；桌面程序使用 `worker.py`，从 stdin 接受单个严格请求，stdout 仅输出版本化 JSON 行，模型日志独立写 stderr。

主进程通过 `AutomaticMusicProcess` 校验每行协议、任务／音源／设备身份和完整退出；`AutomaticMusicService` 管理顺序队列、去重、演出暂停和显式恢复。关闭程序等待自有任务正常结束，不强杀进程。`host-probe.mjs` 可独立复核实际 TypeScript → Python 链路，参数为音源路径与新的输出目录；本次证据位于 `output/music-analysis/host-verified/host-report.json`。

核对页可以直接在浏览器中打开 `index.html`。通过 HTTP 查看时，服务器须支持音频 Range 请求；Python 默认 `http.server` 不适合精确拖动试听。本次使用现有 Vite 提供回环地址预览。

## 输出与评估

- `result.json`：严格校验的原始模型结果、音源身份与耗时。
- `consensus.json`：三模型一致候选和差异，`ground_truth_accuracy` 保持 `null`。
- `analysis.wav`：唯一 48 kHz 时间基准。
- `stems/`、`spec/`、`all-in-one/`：结构分析可复查中间结果。
- 评估入口：`evaluate.py --corpus corpus.json --runs runs.json --engine beat-this-final0 --output report.json`。`runs.json` 使用 `{ "runs": { "曲目ID": "相对于清单的result.json路径" } }`。

评估器支持节拍／小节第一拍／结构边界时间匹配、各类事件的一对一匹配、区间 IoU≥0.7，以及先按区域对应再核对结构标签，另报命名时间覆盖率和参考段落覆盖率。重复命中会计入误检，缺失预测计入漏检，空参考不会虚构 100% 分数；中性“段落 1”不计为结构命名。按歌曲、音乐类型输出结果，盲测每类事件不足 100 例会阻止通过。

评估器**始终不发放发布资格**。独立曲库、类别分类器、校准、绝对误差尾部、真实播放器对齐、模型原版一致性和曲库性能验收仍未完成。评分代码通过不能作为真实识别精度。

## 尚未完成的发布条件

### 独立的算子与安装文件检查

`verify_attention.py` 检查实际安装包的 30 个生产文件以及维护者保存的 NATTEN 0.17.5 参考张量，
并为 CPU／CUDA 分别保存 24 项字段误差。Windows 文件名使用 POSIX 相对路径比较，避免上游
`installed_smoke.py` 将反斜杠文件名与斜杠基线比较造成误报；没有忽略字节差异或放宽 `1e-5` 容差。

```powershell
& output/music-analysis/env/Scripts/python.exe tools/music-analysis/verify_attention.py `
  --source output/music-analysis/downloads/all-in-one-infer-8414233b743d6ccec46e36ab4cfeddb4605ff3bf `
  --device cuda --output output/music-analysis/新的算子检查报告.json
```

输入源码与参考文件须预先存在，运行禁止联网；报告路径必须为新文件。检查未在本机运行原始
NATTEN，也没有覆盖整曲解码、分离、频谱、模型和后处理链路，因此**不能作为整曲原版一致性或精度验收**。

### 仍需完成

1. 20 首可行性筛选及至少 150 首真实曲库（80 开发／30 校准／40 盲测）、双人真值复核。
2. 结构标签、Drop、滚奏、渐强、重击、停顿和最后一击各类别独立验收；不能把音量峰值改名为这些事件。
3. All-In-One 原版与社区版输出核对、权重许可元数据冲突的澄清；未纳入商业分发包。
4. CUDA 已在 RTX 4070 跑通用户提供视频；尚缺 5 分钟音乐端到端 P95 与离线安装验收。`host-probe.mjs` 第三个参数可显式传 `cuda`，不指定时为 `cpu`，不会自动切换。
5. 分析服务、任务队列、暂停恢复、Zod DTO、候选预览、人工选择应用、保存撤销和段落纠错已接入。实际拍点监听接口、曲库质量门槛及无人确认的自动编排未验收。

一个 51 秒片段的模型一致性与 CPU／GPU 耗时不能证明上述门槛通过。UI 显示实际候选数量，并明确标注为建议；候选可由用户核对后保存为普通音乐标记，不能冒充已经达到确定正确率的识别结果。
