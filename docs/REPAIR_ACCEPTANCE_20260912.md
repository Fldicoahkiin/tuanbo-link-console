# 2026-09-12 修复与复测记录

本记录接续 `FULL_CHAIN_ACCEPTANCE_20260911.md`，不覆盖此前失败证据。代码修复和软件回归完成；MA2 实际演出闭环仍未放行。

## 已修复

- 内部主控下，编辑器和节目单共用 `InternalPlaybackController`，使用同一个音频元素、OBS 会话和灯光调度。编辑器不再启动第二个音频或 MTC 输出，参考画布音频静音，正式媒体音频交由既有输出链路执行。
- 播放时保留编辑器和主菜单导航。运行会话使用开始播放时的工程快照，打点、录制、自动保存不再重建播放器；停止后载入编辑结果。播放中的修改下次启动会话生效，不回补已经过去的 GO。
- 暂停保持实际音乐位置；拖动定位取消旧队列，下次播放按新位置准备 OBS；增加明确的停止按钮。编辑器跟随当前播放节目，默认播放尊重歌曲裁剪起点。
- 快捷键打点读取实际音频时间，避免使用 UI 刷新前的旧播放位置。
- 灯光循环统一重新定位音乐、OBS 和 MTC，释放旧音符。录制可以先准备再播放，切换音频实例时保存收到的内容并释放监听。
- 一键连接纳入已保存、明确选中的 MA2 目标。本机调用真实插件 PING；网络模式连接后检查接口与插件。顶部与设备页共享正在进行的只读检查，失败不会显示连接检查全部成功。
- 本机 MA2 插件响应状态显示在顶部。网络登录状态仍与插件、MIDI 接收分别表达。
- MIDI 适配器改为添加、移除自己持有的状态监听，释放播放适配器不会清除顶部监视器的热插拔监听。
- OBS 预览脚本入口移入 OBS 设备区域。

P1 跟随模式保留既有参考试听；未修改工程格式、MA2 交换协议、用户 OBS 来源与滤镜，未执行提交或推送。

## 验证证据

| 检查 | 结果 |
| --- | --- |
| `pnpm verify` | 类型检查、608 项单测、Lint、构建与产物边界检查通过；32 项依赖外部条件的测试跳过 |
| 完整 Electron 回归 | 65/65 通过，输出目录 `acceptance-20260912-repair/electron` |
| 补充共用播放及先录制后播放 | 通过，输出目录 `acceptance-20260912-repair/transport-recording` |
| 最终开发模式复测 | 使用实际 `http://localhost:5173`；共用播放、MIDI 启动/插拔状态、灯光录制、一键连接 4/4 通过，目录 `acceptance-20260912-repair/dev-regression` |
| 本机 MA2 onPC 3.3.4.3 只读复测 | 版本、Timecode、执行器、小数 Cue 与连续插件请求通过；6 项通过、13 项未开启写入条件而跳过 |
| 开发版真实状态 | 最后只读核对：OBS 已连接；`TBLINK SOAK Waveform A` 已连接；本机 MA2 插件已响应 |

完整 Electron 回归发生在最后的录制准备和 MIDI 监听修正之前；最终受影响的工作流已在开发模式单独复测。不能将这些记录表述为最终版本重新执行了一次完整 65 项。

新共用播放用例实际播放测试 WAV，并断言 OBS IPC 场景动作、打点保存、录制保存、菜单切换不中断、暂停时间不前进和重播重新激活。OBS 在该用例中是 IPC 测试替身，不能当作本轮真实 OBS 输出画面的证据。

## 本机验收配置与未完成项

- `pnpm run dev` 已重新启动，开发入口为 `http://localhost:5173`，保留 Alt+R 工作方式。
- 编排台音乐时间码输出由不可用的旧选择改为专用 `TBLINK SOAK Waveform A`；MA2 onPC MIDI 输入由 `Default App Loopback (B)` 改为对应 `TBLINK SOAK Waveform B`。
- 编排台设备连接选择本机 onPC，目录为 `C:/ProgramData/MA Lighting Technologies/grandma/gma2_V_3.3.4`，真实 PING 成功。网络账号和密码未读取或改写。
- 这是本机验收端口配置，不能代替实体控台的物理 MIDI 接口配置。
- 桌面输入冲突多次被工具阻止，已询问是否方便暂停鼠标键盘操作。后续真实播放操作未完成，未改变 MA2 用户 Show 对象。
- 尚需复测：编辑器播放时真实 OBS 输出及既有滤镜/拉腿保持；音乐 → MTC → onPC Timecode 执行 Cue → 操作反馈录制；原 loopMIDI 无接收的根因；实体控台和跨版本网络权限。

MA2 MIDI 输入端口及 Timecode Slot 的对应关系参考官方 [onPC 选项说明](https://help.malighting.com/grandMA2/en/help/key_onpc_details.html) 与 [Timecode 信号说明](https://help.malighting.com/grandMA2/en/help/key_timecode_what_is.html)。端口可用、网络登录和插件 PING 都不能替代实际 Cue 执行验收。
