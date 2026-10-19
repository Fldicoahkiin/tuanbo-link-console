# MA2 Layout、新建 Cue 与属性分类（0.4.48）

## 用户确认的范围

- 2026-10-17 用户选择 MA2 **Layout 自由布局画布**，新建方式同时需要「组合已有 Cue」和「保存控台当前灯光」。
- 在控台素材右侧增加 Layout 面板，保留原左侧菜单尺寸、名称与步骤展示。
- 读取 Cue 已保存的灯具属性，右键查看，并据此多标签自动分类；允许手动分类及新建、重命名、删除自定义分类。
- 用户此前要求暂缓现场更新。此版本独立开发、打包，本轮没有安装到现场测试电脑或重启现场热更新服务。

## 使用方式

1. 连接 MA2 网络并读取控台素材，打开右侧「Layout」。输入已有 Layout 编号，点击「读取页面」查看按钮位置；点击序列按钮可展开其中的 Cue。
2. 首次新建，在「专用页面设置」填写一个空 Layout 编号、布局名称、空的起始序列编号和每行按钮数。之后新建的 Cue 追加在该工程创建的专用 Layout。
3. 「组合已有 Cue」：拖入或用素材旁的 `+` 加入，填写名称并创建。同一灯具的重叠属性由列表后面的 Cue 覆盖。
4. 「保存控台当前灯光」：选择 Programmer 已激活属性（Active）或当前可见灯光（Look），填写名称并创建。使用控台当前 World、Store Filter，保留 Programmer 激活状态。
5. 右键素材选择「灯具属性」，可读取、查看并自动分类。自动分类也可从序列预览中触发。右键分类选项可手动调整，左侧可管理自定义分类。

## 行为与边界

- 新建使用空 Sequence，默认建立 Cue 1，并将 Sequence、Cue 都命名为用户输入的名字。写入后核对真实属性和 Layout，再写入工程；不靠发出命令就报告成功。
- 旧 Layout 只能查看；新建只追加到本工程在当前电脑登记的专用 Layout，不覆盖已有 Sequence 或其它 Layout。删除分类不删除控台对象或时间线内容。
- Layout 中的 Sequence 按真实位置与尺寸显示。宏、组等暂作为不可调用对象显示；灯具符号不绘制，显示省略数量。布局阅读是显式刷新，当前不提供拖动位置写回。
- 静态合成不包含时间延迟或多步运行过程。无显式属性的 Tracking Cue、多 Part、重复通道等不能确认的情况明确拒绝。合成前后比较实际保存的通道与值。
- 自动标签包含亮度、位置、颜色、图案、光束、聚焦、快门、效果；一个 Cue 可有多个标签。名称、灯具编号或画面用途不会用于猜测「面光」「轮廓」「人数」「区域」。
- 未写 DIM 只说明该 Cue 没有显式亮度数据，不代表灯一定不亮；Tracking、默认值、其他执行器仍可能提供亮度。读取失败或未知属性保留明确状态。
- 不在播放中执行新建。来源 Show、桥会话、对象占用、Layout 改动均核对；发生不确定结果保留已创建对象并报错，不自动重试或删除。
- 专用 Layout 所有权保存在本机集成数据中。工程换电脑后，已存在的 Layout 不会被自动认领；可查看，继续创建需另选空 Layout。

## 2026-10-17 验收证据

在 Windows 原生环境、开发电脑的 grandMA2 onPC **3.7.0.5**、自有测试 Show `tblink_ui100_20261007` 执行；这不等于现场实体控台和灯具完成验收。

- 原生 XML 导出证实 Layout 为 `Group/LayoutData/CObjects/LayoutCObject`，Sequence 引用为 `25/1/编号`；原生样本入测试 fixtures。
- Sequence 9919、9920：由测试 Cue 静态合成，回读属性值一致，连续追加至 Layout 9919，不改变旧按钮。
- Sequence 9921：在 BlindEdit 下设置测试灯具 DIM 37，经 Active 新建并回读 DIM 37；完成后 ClearAll、关闭 BlindEdit。新 Layout 无意外灯具符号。
- 真实 Electron 界面通过 preload/IPC 新建 Sequence 9922「界面合成验证」至 Layout 9922；画布显示正确名称，属性读取及自动分类成功。
- 自定义分类新建、改名、删除；保存重开属性数据；设置页往返左侧菜单宽度均为 **256 px**；页面异常为空。
- UI 证据：`artifacts/ui-acceptance/result.json`、`attributes.png`、`layout-panel.png`。原生测试证据：`artifacts/layout-native-9919.json`、`layout-native-9920.json`、`layout-native-9921.json`。
- TypeScript 检查、ESLint、相关 36 项测试通过；`pnpm test` 完整回归 **261 个文件、1802 项测试通过，15 个文件、67 项测试按条件跳过**。最后补齐原生音频播放状态的阻断后，类型检查、相关 Lint 和 19 项网络/创建测试再次通过。

## 构建与后续现场验证

- 版本：0.4.48；安装包目标：`D:/Tuanbo-MA2-Layout-20261017/Tuanbo-Link-Test-NoActivation-0.4.48-x64.exe`。
- renderer/main/preload 由本工作树重新构建；未修改的美颜、音频分析等原生运行时复用此前验证的完整资源，美颜打包校验仍逐个核对 2114 个文件。没有修改或替换原 Lua 桥脚本。
- 复用运行时相关的 52 个源码/构建文件已对比，除 CRLF/LF 行尾外一致。记录：`artifacts/layout-offline-acceptance/reused-native.json`。
- 最终安装包生成成功，大小 **988,035,017 字节**；SHA-256：`554ad215c86d9a4da4badd35337e72ee6a54fa528f84c58852b8d94ada6e8120`。记录：`D:/Tuanbo-MA2-Layout-20261017/package-verification.json`。
- 打包程序在独立用户数据目录启动：版本 0.4.48、`file:///` 内置界面、授权状态 active；Layout 读取和新建接口存在。最终 ASAR 的 main、preload、renderer 入口逐字节与本工作树构建产物一致。记录：`artifacts/layout-offline-acceptance/result.json`。
- 用户更新后需现场验证：选定空 Layout 与 Sequence 范围，两种新建方式，已有布局按钮对应关系，颜色/位置/亮度属性分类，以及实际灯光效果。此前用户确认过旧版 Cue 试听正确，但不能替代本功能验收。
