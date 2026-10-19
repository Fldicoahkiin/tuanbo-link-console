# 控台页面浏览（0.4.53）

根据 2026-10-19 用户要求，将 Layout 页作为“多步”右边的“控台页面”分类。进入时读取工程配置的专用 Layout（未配置时为 999），在中间素材区显示，不打开右侧面板。

## 界面与操作

- 顶部显示实际 Layout 编号和名称；支持输入页码后回车/跳转、上一页、下一页、刷新。
- 按照控台导出的坐标与尺寸摆放按钮，去掉与原点之间无内容的留白；支持缩小、放大、适应窗口。筛选时保留其余按钮的位置。
- 单步按钮显示原名称与 Cue 地址，点击明确触发该 Cue；多步按钮显示总步数，点击进入单步，再通过“返回页面”回到当前 Layout。
- 同时支持名称搜索、属性筛选、右键分类及重命名、单步拖入或加号加入编排。
- 浏览页码不修改新建 Cue 的目标 Layout。“新建 Cue”才按需打开已有创建/设置面板；再次点击“控台页面”收起该面板。新建完成的回读结果会更新中央对应页面。
- 翻页开始及失败时清除旧页按钮；页面为空、尚未创建或读取失败分别显示实际结果。不会自动重复读取，不会因进入页面、翻页、缩放或展开多步而触发灯光。
- 结果绑定工程、控台来源和 Show 会话；切换工程后的迟到回读不进入新工程。

设计参考 MA 官方 [Layout View](https://help.malighting.com/grandMA2/en/help/key_layouts_edit.html) 与 [Layout View Options](https://help.malighting.com/grandMA2/en/help/key_layouts_view_options.html) 的紧凑标题栏、独立坐标画布和视口缩放。保留联动台的菜单、时间线及整体主题；未复制 MA 标识。该界面没有伪装为完整控台：宏等对象仍只显示不可调用占位，灯具符号显示省略数量，没有引入布局位置写回。

## 本地验证

- TypeScript 检查、修改文件 ESLint 通过。
- 页面读取状态及已有 Layout 服务共 7 项单测通过：失败清空、来源/页码校验、工程切换的迟到结果、创建结果绑定。
- 新增 Electron 场景通过：999/1000 页切换、998 页模拟失败、空页、真实坐标相对关系、多步返回、搜索、右侧收起、1180×720 / 1920×1080 和 200% 缩放；只有显式点击单步才记录一次正确的试听指令。
- 原有属性筛选与空 Cue 清单、Cue 拖入保存撤销重开、千条序列分类和名称同步回归通过。序列回归首次因启动时缺少本地测试授权环境而未进入工作区；加上既有 `TBLINK_LOCAL_TEST_ACCESS=1` 后通过，无修改被测功能规避失败。
- 日志和截图：`artifacts/layout-page-tests.log`、`layout-page-typecheck.log`、`layout-page-lint.log`、`layout-page-regression.log`、`layout-page-sequence-regression.log`、`layout-page-regression/`。
- 本机 MA2 onPC 3.7.0.5 的专用测试 Show `tblink_ui100_20261007`：只读 Layout 9919 成功，返回 2 个池对象及其真实坐标。记录为 `artifacts/layout-page-native-read.json`；没有修改此测试页或连接现场控台。

以上界面场景使用隔离工程及构造的控台返回，不等于现场 MA2 的 999 页已完成验证。

## 安装包

完整免激活版保存于 `D:/Tuanbo-Layout-Page-20261019/Tuanbo-Link-Test-NoActivation-0.4.53-x64.exe`。打包后 main、preload、renderer 的 12 个文件与本次构建逐字节一致；真实打包程序使用内置界面启动，版本 0.4.53、授权 active、音乐组件可用。原生组件本轮未修改，复用上一版验证过的资源；随包音乐源码 11 项和美颜资源 2114 项校验通过。

启动结果为 `artifacts/0.4.53-package-startup/result.json`。安装包载荷完整性检查通过，大小 1,013,677,853 字节；SHA-256 为 `fd0f2287766db22596e460eb1d1ad651359c408ec377180b989c85c2ecc98e48`。7z 对 NSIS 容器尾部数据有一项提示，载荷测试结果为 Everything is Ok，退出码 0。详细记录在安装包目录的 `package-verification.json`。

未覆盖安装或自动替换测试电脑上的版本；更新后在“多步”右侧点击“控台页面”即可使用。没有进行 RTL 布局验证。
