# MA2 执行器页面与原生按键验收（2026-10-20）

本记录分别记录 Windows 本机 grandMA2 onPC 3.7.0.5 隔离 Show `tblink_ui100_20261007` 的原生验证，以及真实 Electron 窗口配合测试数据的页面验证。两类证据不混用。未访问用户远程测试电脑，未宣称实体控台或实体灯具终验。

## 协议与行为

- `updateMa2Executor` 支持原生 `Move Executor`、`Label Executor`、`Delete Executor`；不会根据前端排序重建 Page。
- 写前核对 Show、桥接会话、原始执行器 XML 指纹、名称、分配、宽度；多格目标必须全部为空。最终核对和原生写命令在同一次控台 Lua 中执行。
- 修改前同时保留本机 JSON 备份和控台原生 Page XML 备份。写后重新读取受影响页；回读未确认时不会重复发送写命令。
- 删除只移除执行器分配。重命名遵循 MA2 的原生行为：执行器名称来自被分配的对象，同一 Sequence 在其他位置也会显示该名称。
- `inputMa2Executor` 通过既有 Telnet 与应用内置桥调用实际按键功能，无额外 WebRemote 登录。支持 Go、GoBack、Pause、Off、On、Toggle、Flash、Temp、Swop、SwopOn、SwopGo、FlashOn、FlashGo、Black、Top、Load、LoadNext、Select、Learn、Rate1、ToFull、ToZero。
- 按下会话每 500 ms 续约，续约不重复触发；松开执行原生释放。Flash 等按住功能在断线或应用退出后最多 2 秒自动释放。过期会话保留身份，迟到续约不会重新触发。
- 松开立即取消尚未发出的按下；释放后的原生会话保留过期标记，迟到续约不能重新开灯。断线释放未确认的本机记录在最晚租约截止后清理，避免旧连接永久阻挡后续编辑。执行器修改前统一释放本应用按住的按键。
- 页面保留稀疏格号、宽度、原生按键枚举、优先级、Soft LTP；颜色取自所分配 Sequence 的原生 `<Appearance Color>`，无 Appearance 时不编造彩色。颜色读取只返回导出头的颜色，不传回灯具数据，控台端缓存 2 秒。
- 旧版内置桥可在既有连接上升级：先取得旧桥空闲的只读事务、完整回读每片源码并编译，再释放本应用按键、使旧轮询失效、启动新桥。失败恢复旧入口，不重放执行器动作或 Show 写入；不覆盖无应用所有权标记的插件。网络桥和手动导出插件均来自 `link-main.ts` 导入的同一份 Lua。

## 本机验证证据

脚本：`artifacts/executor-native-probe.mjs`、`artifacts/executor-native-verify.mjs`。

结果：`artifacts/executor-native-codes.json`、`artifacts/executor-native-verification.json`。

测试使用新建的 Sequence 9800 和 Page 9899：

1. 读取真实颜色 `#3366cc` 及原生 Flash 枚举 12302。
2. 按下、同会话续约和释放均收到原生响应。释放后同会话再次按下被确认为已过期；停止续约 2.7 秒后再次续约也被确认为已过期，均未重复触发。
3. 名称修改为 `TBLINK_RENAMED`，回读一致。
4. 执行器从 9899.101 移到 9899.102；序列、名称、按键功能及颜色保留。
5. 删除 9899.102 分配；Sequence 9800 仍存在，其全部 Cue 指纹与修改前一致。

该次本机按下用时 28 ms，仅是一次隔离测试的测量值，不代表局域网、实体控台或零延迟保证。页面读取测得 Page 99 两项约 1014 ms，Page 1000 七项约 693 ms、再次读取约 633 ms；页面数据回读不应阻塞本地编辑。

旧桥安全升级已在同一隔离 onPC 实测成功，无需重启。原生测试额外发现 MA 命令解释器会消费 Lua 字符串中的 `|`、`^`；公共 Lua 发送器已将这些脚本按字节传输，并加入回归测试。

46 项后端定向单测通过，覆盖宽格占位、过期来源、指纹变化、误删 Sequence 防护、原生功能映射、按住/释放、排队时连接变更、松开抢先出队、断线租约清理、旧桥升级与失败恢复。

11 项 renderer 按键控制器单测通过，覆盖早松开、未回包立即释放、快速重按独立会话、连续 Go/Toggle 不吞点击、来源变化、续租不重叠、失焦、丢回包释放和过期点击不补发。

独立审查新增 9 项引用与并发测试通过：带序列号的 Go/Off 仍属于执行器专用动作；删除前同时检查节目模板和用户素材，写入期间新增动作保留并提示重新指定；移动迁移可编辑映射而保留原始 XML 和基线；旧读取不能覆盖新回读或永久留下忙碌状态，等待连接期间切换工程不发出旧删除。

原生 Timecode 引用移动另行验证：隔离创建 Timecode 9898，引用应用测试执行器 9899.101；调用原生 Move 到 9899.102 后，Timecode 导出的 `<Object>` 自动改为同一新地址。本地可编辑映射更新后，单测确认继续打点、自动关联和事件身份匹配不会增加轨道。证据为 `artifacts/executor-timecode-move-result.json` 及前后 XML；该次新建 Timecode 和执行器分配已清理。

## 三层页面本地验收已完成

测试文件：`apps/desktop/test-e2e/ma2-executor-page.spec.ts`、`apps/desktop/test-e2e/ma2-live-faders.spec.ts`，使用 `ma2-executor-fixture.ts` 提供隔离工程及有状态 IPC 测试数据。实际启动构建后的 Electron 应用，验证真实 DOM、键鼠交互、回读结果和窗口布局；这些测试没有向实体控台发送命令。

- 上层 Button 保留 101–190 的原格位及六行布局；中层显示 1–15 执行器的紧凑原生功能按键，含左侧 LTP 和右侧三项功能；下层 Button 保留 101–115。没有竖推杆、密码输入或额外实时推杆连接。
- 稀疏空格、多格执行器和跨格占位保持原位置。上、中、下层页码各自独立，输入页码切页不会触发灯光。中层切换 16–30 范围后能访问 16 格；上层切换 191–240 范围后能访问 219 格。右键编辑步骤和控台位置清单可返回对应页面及格子。
- 默认上区占比 68%，小窗口优先完整展示三层；下方时间线最小高度 160 px。1180×780、1600×1000、1920×1080 三种窗口尺寸均通过内容高度不超过可见高度的断言，无内部滚动；主工具栏保持一行。上下分区手动调整为 65% 后，切换单步与控台页面仍保持该比例。
- 右键重命名等待写入回读后才更新卡片，不提前显示成功。实际拖拽到空格后按返回页数据刷新原地址和新地址；拖动不误触发原生按键。右键删除确认显示页码、格号和名称，完成后清空分配且保留底层 Sequence。
- 某一页回读异常时，其他层和换页操作仍可使用；恢复后继续读取控台修改的名称。普通按键走原生输入接口，Flash 按住、松开和失焦释放均有检查，不调用额外 WebRemote 读写接口。

页面定向测试已通过。另以约 80% 格子填充、不同 Cue 数量、少量长名称和不同颜色检查密集显示。以下是真实 Electron 窗口截图，内容为明确构造的测试数据，并非实体控台截图：

- [1600×1000 密集页面](../artifacts/ma2-three-band-ui/ma2-executor-page-三层执行器保留原格位和独立页码，翻页不播放，紧凑工具栏无竖推杆/executor-fixture-filled-1600.png)
- [1180×780 密集页面](../artifacts/ma2-three-band-ui/ma2-executor-page-三层执行器保留原格位和独立页码，翻页不播放，紧凑工具栏无竖推杆/executor-fixture-filled-1180.png)
- [1920×1080 密集页面](../artifacts/ma2-three-band-ui/ma2-executor-page-三层执行器保留原格位和独立页码，翻页不播放，紧凑工具栏无竖推杆/executor-fixture-filled-1920.png)
- [原位与稀疏格子页面](../artifacts/ma2-three-band-ui/ma2-executor-page-三层执行器保留原格位和独立页码，翻页不播放，紧凑工具栏无竖推杆/executor-three-bands.png)

## 综合验收与现场边界

- 0.4.57 的完整单测、类型、Lint、构建、桌面回归及免激活包启动结果见[最终交付记录](MA2_RELEASE_ACCEPTANCE_20261021.md)。
- 桥 generation 在原生写入回包期间刷新时，仍迁移同一工程的本地引用，但不合并旧会话页面缓存；切到其他工程或 Show 后不污染新工程，明确返回实际写入的位置与备份。新增 8 项并发测试通过，两套 store 测试共 20 项通过。
- 完整安装包已生成；包内 Lua 与已验证源码逐字节一致。
- 本次未验证实体灯具输出；不得用控台命令回执代替实体灯光观察。

官方依据：[ExecButton1 与按键位置](https://help.malighting.com/grandMA2/en/help/key_keyword_execbutton1.html)、[执行器功能](https://help.malighting.com/grandMA2/en/help/key_exec_assign.html)、[Flash 按下与松开](https://help.malighting.com/grandMA2/en/help/key_keyword_flash.html)、[Temp](https://help.malighting.com/grandMA2/en/help/key_keyword_temp.html)、[Appearance 来自被分配对象](https://help.malighting.com/grandMA2/en/help/key_keyword_appearance.html)、[删除执行器](https://help.malighting.com/grandMA2/en/help/key_keyword_executor.html)。
