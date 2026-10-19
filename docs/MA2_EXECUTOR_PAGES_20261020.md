# 执行器页读取、歌曲落位与推杆方案

## 当前实现

- 用户照片中的 `ExecButtons 101–190 / Button 4 (Fixed)` 是执行器按钮第 4 页；`Fader 100` 是独立的推杆页。不能用 Layout 100 代替其中任何一个。
- 「控台页面」默认按钮页，可输入页码、翻页或选择实际存在的目录；按钮与推杆分别记住页码。浏览页码不触发灯光，也不强制切换控台操作者正在使用的页面。
- 使用桥的 `PAGES` 读取稀疏页面目录和当前按钮/推杆页，使用 `PAGE` 读取原生 Page XML。保留 nil 空格和跨格延续，按每行 15 格、每组 5 格显示，搜索仅弱化不匹配项，不重新排列格子。
- 页面附带引用序列的准确 Cue 编号和名称元数据，避免每张卡片发一次网络请求。原生对象 label 用于名称，地址另行展示。
- 左键 Cue 试听发送完整地址，例如 `5.101`；右键可展开此序列的 Cue 步骤。非 Sequence 对象目前仅显示，未实现所有宏、计时器、特殊 Master 的控制。
- 「读取全部 Cue 位置」扫描目录中的全部页，左侧显示真实已完成页数；扫描不抢当前页。反向索引显示一个序列的多个执行器地址。没有匹配仅代表未分配到执行器页，不代表 Layout 中也没有该对象。
- 素材筛选与 Cue 位置使用独立浮层，避免工具栏裁切；选择操作收进筛选弹层，右键选中不再增加一行或推动格子。页面读取失败会撤销“全部位置已读取”状态，定位后切换按钮/推杆仍记住定位页。
- 全工程灯光只占一条编辑器时间线。原轨道、片段和事件仍保留；重叠点显示数量，可右键选择。
- 歌曲新建默认按钮第 1000 页，101–190 找空格，不覆盖原对象。40 个点位对应一条 Sequence 的 40 个 Cue，绑定和点位编辑器保留准确地址。原 Layout 绑定沿用原位置。
- 新建或修改歌曲前先预检目标位置，写入后再次回读。控台位置已被替换或页面已满时阻止写入；不猜测原位置。
- 重新打开工程时，遗失的软件 Timecode 关联可根据原生 SNAPSHOT 核对执行器、序列、Cue、小数编号、时间和静音状态。仅唯一一致的事件恢复关联；歧义或控台新增未知事件会明确阻断，不能覆盖。

## 推杆页：已实现并完成本机往返测试

静态 Page 读取与实时推杆通道已接入。当前页面显示 15 条竖推杆，可切换 1–15 至 76–90 范围；与按钮页分别记住页码。现场控台与其他 MA2 版本尚未验收。

读取分两部分：

1. 原生 Page 提供页码、格号、空位、跨格宽度、分配对象和名称。保持实际编号，不能把 Sequence 编号当格号。
2. 播放状态通道提供当前 Cue、运行状态、推杆实际值、推杆功能及三个按键的功能。静态 XML 中的 `AssignmentExec.fader` 不可当作推杆百分比，也不可由最后一次发送值伪造真实回读。

本机 MA2 3.7.0.5 安装文件 `webserver/release/js/main.js` 的 Web Remote 使用 `playbacks` 请求读取状态，`playbacks_userInput` 发送操作。已经用实际普通用户完成登录、回读、推杆写回和按键往返；该通道仍不能视作跨版本稳定公开 API。

MA2 官方说明 Web Remote 要开启 `Remotes → Login Enabled`，且不能使用默认 Administrator 登录。本轮仅在隔离 Show 建立专用测试用户 `TBLINK_WEB_ACCEPTANCE`，没有为用户现场 Show 建用户。产品界面让操作者填写自己的普通控台用户；密码仅用本机 safeStorage 保存。Telnet/Lua 连接成功与实时推杆通道连接状态分别显示。

当前 UI 与行为：

- 复用「控台页面」区域和页码栏，在按钮页/推杆页间切换，右侧不常驻面板。
- 15 条紧凑竖推杆，每 5 条一组；执行器较多时选择 1–15、16–30 等范围。空格和跨格原样保留，不把有内容的推杆重新排满。
- 每条上方显示位置和控台原名，中部显示当前 Cue / 总步数与按键功能，下方显示竖推杆和实际读回值。
- Master、Temp、Speed、Rate、XFade 等按实际功能显示，不统一称亮度。只有已核验单位的值才显示百分比、BPM 或时间。
- 推杆拖动以完整页码和格号发送，连续更新合并为最新目标，松手后核对实际值；新读回不能抢正在拖动的手柄。过期状态明确标识，断线后禁用写入。
- 按键保持其实际 Go / Pause / Off / Flash / Toggle 等功能。按住型功能必须处理松手、取消和失焦，不能全部替换成 Go。
- 右键沿用紧凑编辑菜单，可定位序列、编辑 Cue、改名；不开整页侧栏。
- 原生按键位置从上至下采用 button3、button2、推杆、button1；控件使用控台返回的实际范围、功能名和显示值。Speed、Rate 等不强制限制为亮度的 0–1 范围；写入必须落在最新回读的 min/max 之内。
- 读取完成后间隔 100ms 读取下一帧，同一时刻最多一个状态请求；拖动输入每 30ms 合并最新目标。任何读取或输入错误停止界面轮询与操作，等待用户重新连接；不自动重试或重放。
- 未回读到目标值时保留待确认标识，超过 1.5s 停止。窗口失焦、离开页面、取消按压均释放按键；主进程在 1.5s 收不到读取心跳时也释放已记录按键并关闭通道。网络已物理断开时不能保证释放包抵达，仍需现场验证控台自身断连行为。
- 每秒通过桥核对 Show 与会话；改变后停止采用旧数据。过期输入和过期快照禁止写入，迟到的凭证加载不能恢复已关闭连接。

## 验证记录

隔离本机 Show：`tblink_ui100_20261007`，MA2 onPC 3.7.0.5。

- Page 99 原生读取保留 101、201 格和序列引用；目录读到 24 页。带序列元数据的一次页面读取约 644 ms。证据：`artifacts/executor-page-native-verification.json`。
- Sequence 9986 / 按钮页 1000.102：创建 40 Cue、软件改名写回、控台改名读回通过。证据：`artifacts/song-executor-native-verification.json`。测试对象保留，不清理用户 Show 内容。
- 隔离空 Cue 五次本机命令发送确认约 19–22 ms；后台读取页面同时发送约 21 ms。证据：`artifacts/executor-dispatch-native-verification.json`。这是本机命令确认时间，不是实体灯光响应延迟。
- Sequence 9986 / 推杆页 1000.1：软件写入 20%、70%、40%，原生回读一致；控台命令改为 63% 后软件读取一致，Go/Off 往返通过。普通用户重新连接成功。证据：`artifacts/fader-native-verification.json`、`artifacts/fader-service-native-verification.json`。
- 连续约 26.5 秒测试共 239 次状态回读，软件和控台各修改 12 次；每次目标一致，切换 16–30 再返回、关闭后读取已保存用户连接均通过。本机回读耗时范围 31.8–142.2ms，中位 66.0ms。证据：`artifacts/fader-continuous-verification.json`。这是短时本机验证，不是实体灯具延迟或长时间稳定性承诺。
- 页面、歌曲、同步恢复、源对象变更、空格占用、播放中阻止变更等单测已通过。全量单测 1876 项通过，67 项跳过；随后增加的两个预检/恢复集成用例与相关 12 项定向测试通过。
- 完整界面回归一次执行 185 项：151 通过、9 失败、25 项依赖现场或特定环境跳过。9 项失败已定位为折叠入口、合并时间线等 UI 调整后的旧测试操作，修正操作路径后全部定向补跑通过；保留原功能与保存数据断言。合计 160 项可运行用例通过，不代表单次全绿，也不代表外设现场验收。日志：`artifacts/executor-acceptance-e2e.log`、`artifacts/executor-recheck-e2e.log`、`artifacts/executor-final-e2e.log`。
- 最后修正右键位移、浮层裁切后，属性/空 Cue、页面、素材、歌曲 4 项界面回归通过。收尾修正测试 Promise 和稳定回调后，6 文件 37 项定向单测、页面及歌曲 2 项界面回归通过。日志：`artifacts/executor-ui-final-e2e.log`、`artifacts/executor-guards-close.log`、`artifacts/executor-ui-close.log`。
- 最终类型、Lint（无警告）和构建通过：`artifacts/executor-typecheck-close.log`、`artifacts/executor-lint-close.log`、`artifacts/executor-build-close.log`。实际应用截图保存为 `artifacts/ma2-executor-page-preview.png`、`artifacts/ma2-executor-context-preview.png`、`artifacts/ma2-executor-compact-preview.png`；截图使用界面示例数据，不代表现场读取。

上述原执行器验证之后又完成了本轮推杆实现。最新回归、打包和发布门槛汇总见 [本轮验收记录](./MA2_RELEASE_ACCEPTANCE_20261020.md)，不要把上方历史检查计数视为新增推杆版本的完整发布验收。

本轮尚未连接用户实体测试电脑，也没有向该电脑热更新。页面/名称刷新采用轮询，实际耗时受网络和 Show 大小影响，不承诺 0 ms 或全部 MA2 对象无条件双向同步。

## 官方依据

- [执行器与推杆、按键](https://help.malighting.com/grandMA2/en/help/key_exec_what_are.html)
- [按钮与推杆独立页码](https://help.malighting.com/grandMA2/en/help/key_adv_exec_pages.html)
- [执行器功能分配与跨格限制](https://help.malighting.com/grandMA2/en/help/key_exec_assign.html)
- [推杆命令及完整地址](https://help.malighting.com/grandMA2/en/help/key_keyword_fader.html)
- [Web Remote 和登录限制](https://help.malighting.com/grandMA2/en/help/key_remote_control_web_remote.html)
