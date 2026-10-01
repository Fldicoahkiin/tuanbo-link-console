# MA2 Cue UI 官方对照 · 2026-09-26

用户纠正：现有软件的序列预览不是 MA2 的 Cue UI。当前 0.4.35 界面不作为对齐完成版。此记录是重新检索的依据，不是已实施说明。

## 官方实际界面

1. **Sequence Pool**：紧凑网格方块，序列编号与原名是主体，另有分配、Tracking 等信息；支持 Pool Playback / Direct Action。不能把所有序列展开成一长串独立 Cue 素材冒充序列池。
   - [官方说明](https://help.malighting.com/grandMA2/en/help/key_cs_what_are.html)
   - [官方原图](https://help.malighting.com/grandMA2/img/window_sequence-pool_v3-3.png)
2. **Sequence Mini Executor**：执行器、序列编号与名称在顶部；多步时中部显示上一步、当前步、下一步，当前步及渐变进度有明确视觉状态；下方是实际分配的按键/推杆控制。
   - [官方说明](https://help.malighting.com/grandMA2/en/help/key_cs_sequence_mini_executor.html)
   - [官方原图](https://help.malighting.com/grandMA2/img/img_mini-executor_sequence_v3_3.png)
3. **Sequence Executor Sheet**：紧凑多列 Cue 表，包含 Number、Name、Trig、Trig Time、Fade、Delay、Loop 等；活动 Cue 使用黄色框标识，列可调整。当前三列“Cue/名称/调用按钮”不是这一界面。
   - [官方说明](https://help.malighting.com/grandMA2/en/help/key_cs_cue_sequence.html)
   - [官方原图](https://help.malighting.com/grandMA2/img/window_sequence-executor-sheet_v3-3.png)
4. **Action Buttons**：执行器网格，Direct Action 决定是否点击整个块执行分配动作，不能一概把点击解释为 Goto 首 Cue。
   - [官方说明](https://help.malighting.com/grandMA2/en/help/key_exec_on_screen.html)
   - [官方原图](https://help.malighting.com/grandMA2/img/window_action-buttons_v3-3.png)

图像来自官方 grandMA2 帮助，文件名标记 v3-3；当前页面标题版本为 3.9。它们用于确认 MA2 界面结构，不作为现场 3.7.0.5 元数据/API 已兼容的证据。搜索结果中的 grandMA3 Sequence Sheet 已排除。

## 对当前实现的纠正

- 素材库主视图应按序列池组织，单 Cue 与多 Cue 都属于自己的序列；原始编号和名称必须保留。
- 常用试听应能在执行器式控件中完成，而不是每步重复一个“调用 Cue”网页按钮。
- 多步 Cue 展开后的明细才使用 Sequence Executor Sheet；不能混淆素材池、运行控制与参数表。
- 当前只缓存编号和名称，没有真实活动步、Fade 进度、按键分配、Trig/Loop 等完整数据。完善外观必须同时补足数据来源；未知值和未回读状态不得伪造成控台状态。
- 后续截图应直接对照上述官方原图检查布局及交互，再对照实机验收；不能用类型检查、模拟指令通过或普通窗口布局检查代替 MA2 UI 对齐验收。

## 0.4.36 中文界面与分类

按现有界面的颜色、圆角、字体和工作台布局实现序列网格、执行器式控制与单步子菜单。应用按钮和状态采用中文，控台原始名称保留。单步序列点击直接发送其原始步骤的调用；多步序列点击仅打开子菜单，不出灯，子菜单中每个原始步骤均可点击试听。完整序列通过“从第一步开始”“继续”“关闭输出”交由控台运行。目录不完整单列“目录待补全”，不推断为单步序列。

子菜单按读取到的顺序、编号和名称显示，编号含小数时不改写为整数。上/选中/下步骤属于浏览状态，不冒充控台活动步骤。实际活动步、亮度与渐变进度尚未回读；界面明确标识，未展示虚构的触发或循环参数。

验收材料位于 `docs/acceptance/ma2-0.4.36`。36 序列分类样本仅用于布局和交互验证，不是现场读取证据；24 事件混合动作使用此前的截图重建样本，也不是原始现场 XML。真实出灯、自动跟随与循环仍需连接现场 3.7.0.5 控台确认。
