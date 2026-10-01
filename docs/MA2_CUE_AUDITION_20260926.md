# 素材 Cue 点击试听 · 0.4.34

用户要求：选择灯光素材必须能立即调用控台出灯，以便判断选用哪个 Cue。0.4.33 的原生保留限制错误地阻止了单 Cue 试听；素材卡片点击本身也只调用 addIngredient，未触发输出。

## 修改

- 素材卡片单击继续加入当前编辑组合，同时调用该素材明确的序列和 Cue。未插入歌曲时间线的素材同样可以试听，无需播放音频或调整时间码。默认开启，沿用“选中 Cue 实时播放”开关。
- 素材试听走已连接的 MA2 网络，例如 Sequence 36 / Cue 1.100 发出 `Goto Cue 1.100 Sequence 36`。调用前仍使用已有边界校验与控台对象存在检查，回执只确认命令已发送。
- 原生保留时间线上的已知 Cue 也可以点选试听。只构造用户明确选择的 Goto Cue 调用，不带旁边的 Master、Learn、释放事件，不重建整条时间线；整条播放及写回限制保持。
- 原始 XML、绑定、节目输出模式、歌曲事件均不因试听改变。组合素材调用其成员 Cue，不额外加入时间线卡点。
- 发送状态在素材列表上方显示；连接失败、对象不存在等显示具体错误，不自动重试，不偷偷改走 MIDI。快速切换或离开节目取消尚未发送的旧调用。

MA2 Goto 的基本命令语义参见 [官方 Goto 文档](https://help2.malighting.com/grandMA2/en/help/key_keyword_goto.html)。试听会改变控台当前播放状态，但不会改写 Cue 内容或 Timecode 编排；实际可见效果还受当前控台输出状态影响。本次不自动调整主推杆、Blackout 或灯具参数。

## 验证边界

`lighting-cue-audition.test.ts` 验证原生保留文件中只发送选中的明确 Cue，素材不在时间线上仍可发送，原始工程不变、完整原生时间线仍禁止网络部分重放；网络失败不重发或回退 MIDI。已有单 Cue MIDI、快速改选与取消测试保留。

`ma2-cache-workflow.spec.ts` 新增真实界面点击导入素材 Cue 1.100，检查调用参数为 Sequence 36 / Cue 1.100，且歌曲仍只有原来的 11 个卡点。网络接口模拟，不能据此宣称现场灯具已经实际出灯。已有主进程命令测试检查数字参数、控台对象存在检查及失败回执。

现场仍需核实：连接实际 MA2 3.7.0.5，点击已读取素材，确认调用序列/Cue 与实际灯光一致。若收到命令但灯光不变，需要依据实际控台状态核查，不能用“已发送”冒充“已出灯”。

## 交付证据

最终 `pnpm verify:release` 通过。以 0.4.34 打包程序运行的定向 Electron 用例通过，包含素材卡片点击后只发送 Sequence 36 / Cue 1.100，并继续验证修改、缓存和重开。

- [发布日志](acceptance/ma2-0.4.34/release.log)、[打包界面验证日志](acceptance/ma2-0.4.34/packaged-e2e.log)、[发布清单](acceptance/ma2-0.4.34/release-manifest.json)
- 安装包：`apps/desktop/dist/Tuanbo-Link-Console-0.4.34-x64.exe`，NotSigned。
- SHA256：`B64FF6DAA496E70DF8E8FA8A13179E60172204DB38A9474DD0F9A7D8B9F42BFB`
