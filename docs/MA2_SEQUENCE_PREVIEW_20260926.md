# MA2 同序列多步 Cue 预览 · 0.4.35

> 用户后续明确否定该版本的 UI 对齐结果。下文布局 Approve 仅指所测窗口的可访问性，不代表 MA2 操作形式验收。0.4.35 自制的左右列表不是 MA2 Sequence Pool / Mini Executor 的等价呈现。重新检索的官方界面依据见 [MA2 UI 对照](MA2_UI_REFERENCE_20260926.md)。

用户明确选择：MA2 同一序列里多个 Cue，按控台原有方式继续、自动跟随或循环；不是把不同序列拼成本地延迟列表。

## 使用

灯光工作台 → **序列预览 · 多步 Cue**。左侧按原始序列名称分组，右侧显示缓存中的完整 Cue 编号和名称；可以从首 Cue 开始、调用任意 Cue、Go 继续或 Off 关闭。选中 Cue 可返回编排使用。

目录优先来自已经读取并保存在歌曲绑定中的原生 Cue 索引；新导入素材时也将整个序列目录、Show 和读取时间保存在 lighting.ma2Library。未读到完整目录时，只显示已保存的素材并明确标注，不宣称完整。

## 播放语义

- Go 直接发送给 MA2，不根据本地缓存推算下一 Cue；Follow、Time、循环均由控台执行，没有新增本地定时器。
- 同序列有唯一已知原执行器时默认使用它，保留该执行器的播放选项。有多个候选执行器时不猜测，列表提供明确选择，也可使用 Sequence Pool。
- 序列池与执行器可能使用不同播放选项；界面明确播放目标，不自动重设控台选项。原始执行器地址是缓存引用，现场更改分配后应重新读取核对。
- Go/Off 序列命令走原有类型化 IPC 与网络调用；边界仍校验数字目标与对象是否存在。Goto 必须含合法 Cue 编号。
- 没有读取当前活动 Cue、Follow 参数或循环状态，因此只显示“已发送”及“当前播放步未回读”，表中选中行不冒充控台实际正在运行的步骤。切换列表不会发送 Off；关闭只作用于明确选中的播放目标。
- 原生 XML、歌曲时间码和 Cue 编排不因试听改写，原生保留时间线的整体写回限制继续生效。

参考：[MA2 Follow 教程](https://help2.malighting.com/grandMA2/en/help/grandma2_quick_start_guide/key_08_edit_a_sequence.html)、[执行器选项](https://help2.malighting.com/Page/grandMA2/adv_exec_options/en/3.9)、[Sequence Pool Playback](https://help2.malighting.com/grandMA2/en/help/release_notes/key_rn_v2_3.html)。官方资料说明 Follow 可由控台继续触发，执行器选项会影响自动触发；因此本次保留原生运行，不伪造本地执行结果。

## 验证范围

命令测试检查 `Go Sequence 36`、`Off Sequence 36` 的目标存在检查不包含虚构 Cue；Goto 缺少编号会拒绝。试听测试检查只有用户点击才发送 Go/Off，不按目录自动补发。Electron 流程测试打开截图重建的 Sequence 36，显示 11 个 Cue，默认 Executor 51.101，逐次验证首 Cue、Go、Off 对应的三个指令。

这是软件交互和命令路由验证。真实 3.7.0.5 的 Follow、Time、循环运行、现场出灯、实时活动步回读尚未验收。本版没有实现完整 MA2 界面与状态镜像，不能称为与控台完全等价的预览。

## 发布与布局复核

最终 `pnpm verify:release` 与 0.4.35 打包程序定向 Electron 流程通过；界面验证记录原执行器的 Goto、Go、Off 三个明确调用，并保留既有素材单击试听、缓存及重开检查。

| 严重度 | 位置 | 修改前 | 修改后 | 原因 |
| --- | --- | --- | --- | --- |
| HIGH（已修复） | Ma2SequencePreview / ma2-sequence-preview.css | 200% 放大时两栏挤压目标选择，文字裁切 | 窄空间改上下排列，可滚动访问控制与 Cue 表 | 保留阅读顺序与可访问操作 |

已检查 1540×960、1100×760，以及 200% 放大后的滚动访问；RTL、其他分辨率与真实硬件状态：Not verified。上述已检查范围的布局结论：Approve，不包含完整 MA2 功能等价性。

- [标准窗口截图](acceptance/ma2-0.4.35/sequence-preview.png)、[窄窗截图](acceptance/ma2-0.4.35/sequence-preview-1100.png)、[200% 放大截图](acceptance/ma2-0.4.35/sequence-preview-zoom.png)
- [发布日志](acceptance/ma2-0.4.35/release.log)、[打包界面日志](acceptance/ma2-0.4.35/packaged-e2e.log)、[发布清单](acceptance/ma2-0.4.35/release-manifest.json)
- 安装包：`apps/desktop/dist/Tuanbo-Link-Console-0.4.35-x64.exe`，NotSigned。
- SHA256：`C833B7A316FF5C3B5A10A4C07BD3CAD30C8867754C0EC38166DF0B514DAE5560`
