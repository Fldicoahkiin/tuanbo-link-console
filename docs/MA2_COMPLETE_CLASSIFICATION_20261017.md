# MA2 完整属性分类、菜单管理和 Cue 步序（0.4.50）

## 分类依据

按 MA2 当前 Show 的 `PresetType → Feature → Attribute` 树分类，不使用 Cue 名称、属性编号或属性名称前缀猜测。分类目录和 Cue 数据均复读核对；读取期间 Show、目录、属性或分组变化时拒绝合入不一致结果。

依据 MA Lighting 官方手册：

- [Preset Control Bar](https://help.malighting.com/grandMA2/en/help/key_ws_preset_control_bar.html)：九个标准功能大类。
- [Attribute & Encoder Grouping](https://help.malighting.com/grandMA2/en/help/key_adv_fixture_attribute_encoder_grouping.html)：分组层级、可调整分组和不可编辑的 Library Name。
- [Attribute keyword](https://help.malighting.com/grandMA2/en/help/key_keyword_attribute.html)：属性编号可能随灯库变化，因此使用库名标识。
- [Bitmap control](https://help.malighting.com/grandMA2/en/help/key_bitmapfixture_control.html)：Video 也用于 Bitmap 灯光映射和播放属性。

| MA2 大类 | 软件名称 | 默认菜单位置 |
| --- | --- | --- |
| Dimmer | 亮度 | 常用 |
| Position | 位置 / XY | 常用 |
| Gobo | 图案 | 常用 |
| Color | 颜色 | 常用 |
| Beam | 光束 | 常用 |
| Focus | 聚焦 / 缩放 | 常用 |
| Control | 控制 | 更多分类 |
| Shapers | 切割 / 遮扉 | 更多分类 |
| Video | 视频 / 媒体 | 更多分类 |

额外提供快门 / 频闪、属性效果、控台扩展分类、属性待核对、未写属性 / 继承待核对。快门保留 Beam 父分类；自定义 PresetType 使用控台实际名称另建分类。一个 Cue 可以属于多个分类，多步序列取各步类别的并集。

“全部”是浏览范围，不是第十种灯具属性。面光、轮廓、人数、区域等舞台用途仍由用户手动归类。只读已写入属性，未解析最终 Tracking、默认值、其他执行器和灯具实际输出；因此不能承诺最终灯光用途绝对精准。缺失属性引用不会被自动猜成已知类别。

## 用户操作

1. 更新软件并连接控台后，先读取素材目录，再使用“读取属性并自动分类”。旧缓存没有控台属性树时，显示待核对并要求重读。
2. 右键 Cue →“查看灯具属性 / 自动分类”，显示原名称、真实 Cue 编号、分类标签、写入属性、灯具编号及控台分组依据。
3. 左侧“分类管理”可以勾选显示、设置常用、上下排序、新建、改名和删除。用户最终确认保留视频分类，默认放入“更多分类”。
4. 面光、轮廓、效果这三个入口也能隐藏、设为非常用和排序。控台素材总入口固定保留。
5. 隐藏保留分类和归类记录；删除分类不删除控台 Cue 或时间线。重新自动分类保留菜单显示、常用状态、排序和手工分类。自动生成的分类被删除后，下次主动自动分类可以再次生成；长期不显示请用隐藏。
6. 设置随工程保存，支持撤销和重开。菜单保留原布局宽度，预留滚动条空间，分类增多时按钮不横向跳动。

## Cue 步序

- 单步卡片第一行显示原名，不附加 Sequence 编号；第二行分别显示真实 Cue 地址和其在完整序列中的步序，例如 `Cue 2.5 · 第 3 步`。
- 搜索过滤不改变步序；目录未完整时不编造步序；全部 / 多步卡片仍显示总步数。
- 旧主进程附带的对象编号需安装新版并重新读取素材。名称本身的合法数字不会被截去。

## 音乐分段

- 自动名称统一为“段落 1、段落 2……”，不再判断主歌 / 副歌；保留用户手改名称。
- 逐段拟合拍间隔，顶部 BPM 跟随播放头所在段，不再显示全曲汇总 BPM 作为当前速度。既有缓存也从拍点重新派生分段数值，不直接改写工程。
- 渐变速度显示起止范围。模型歧义、拍点不足或不稳定显示“BPM 待核对”；数值标注“约”，不承诺任意音频绝对精准。
- 真实四模型音频测试：48 秒鼓和低音 WAV，前 24 秒为 120 BPM，后 24 秒为 150 BPM。稳定段识别为 120 / 150；变速附近 24.39–29.99 秒有两段证据不稳定，保持待核对。边界也有约 390 ms 偏差。这一结果不等于任意歌曲已经精确验收，报告保留在 `artifacts/music-known-tempos-result.json`。

## 验证记录

Windows 原生环境，开发机 MA2 onPC 3.7.0.5，自有测试 Show `tblink_ui100_20261007`：

- 真实读取 226 个属性及完整九类分组，全部有明确归属。测试 fixture 是控台读取的属性结构，包含棱镜、图案旋转、切割和媒体属性。
- 真实读取 Sequence 9918：DIM、PAN、TILT、COLOR1，正确归入亮度、位置、颜色，无未知引用。仅只读查询，未调用灯光。
- 真实 Electron UI：Cue 7.1 显示第 4 步，搜索后不变；Cue 2.5 显示第 3 步。九类标签、隐藏面光、视频设常用、亮度移至首项、新建分类、保存重开均通过。菜单内容宽度前后同为 209 px，外部侧栏布局不变。
- UI 的 226 属性 Cue 和 120 / 150 拍点为明确构造的显示验证数据，不能作为现场 Cue 或音乐模型正确性的证据。
- `pnpm typecheck`、`pnpm lint`、`pnpm release:check` 通过。`pnpm test`：265 文件 / 1817 测试通过，15 文件 / 67 测试按既有条件跳过；另 7 项发布脚本测试通过。
- 本工作树重建 main / preload / renderer。复用未变更原生资源，52 个源码 / 构建文件已核对；打包检查 2114 个美颜资源。
- 界面证据：`artifacts/cue-music-attributes-ui/`；原生属性证据：`artifacts/ma2-attribute-catalog-native.json`、`artifacts/attributes-library-native.json`。

## 交付

目标安装包：`D:/Tuanbo-MA2-Complete-20261017/Tuanbo-Link-Test-NoActivation-0.4.50-x64.exe`。使用已授权的 portable-test 构建通道，免激活。

安装包已生成：988,084,328 字节；SHA-256：`aed3aa056a3873d2ea3c520728bac9c7995d3f8325db18053953b8e9f0d333a7`。最终 ASAR 内 12 个构建文件与本工作树逐字节一致。打包程序独立用户目录离线启动：版本 0.4.50、`file:///` 内置界面、授权 active、音乐组件 available，Layout / 新建 API 存在。记录：`D:/Tuanbo-MA2-Complete-20261017/package-verification.json`、`artifacts/complete-offline-acceptance/result.json`。

本轮未安装到现场测试电脑，也未重启旧现场 HMR 或把新 preload 接口混入旧主进程。完整分类需更新后对现场 Show 重新读取，并核对实体控台。此前用户确认的旧版灯光响应不替代本轮现场验收。
