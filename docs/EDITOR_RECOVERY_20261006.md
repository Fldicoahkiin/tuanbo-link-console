# 2026-10-06 编辑器与播放恢复

本记录只覆盖此次播放按钮、标题栏拖动、OBS 编辑恢复和游标时钟修复，不代表五小时全链路验收通过。开发热更新按用户要求保持开启；修改主进程或 preload 后仍需完整重启开发程序。

## 根因与改动

- 播放按钮根据播放列表判空，可能忽略播放器已经选中的音频；页面任务忙碌还会使传入的控制器变成空值。改为使用选中节目，并保持已有播放器的控制入口；不可用原因记录日志并在按钮提示中显示。
- 顶部整块状态区域使用 no-drag，空白部分也不能拖窗。空白恢复原生拖窗区域，状态按钮与详细按钮保留可点击。
- OBS 场景切换的写入拒绝与预览故障共用一个错误状态，导致选中框永久消失。现将两种错误分开，丢弃旧目标待发修改，读取当前场景并重新建立选中框，不重发旧场景写入。
- 拖动的每次变换事件会再次读取整个场景。现拖动期间不重复读取，结束时核对一次；晚到的旧读取不能覆盖新拖动。丢失指针捕获时结束手势。
- 无音频预览时钟依赖每次渲染新建的回调，使计时起点反复重置。现回调通过 ref 更新，时钟仅在实际播放条件变化时重建。此项不等同于所有正式音频场景的黄线性能验收。
- 工程 store 在模块重新求值时总是创建空状态，不能保持仍在使用旧模块的页面与播放器订阅。现通过 Vite HMR 生命周期保留同一 store、工程、路径、会话和未保存历史，并替换操作实现；保持热更新开启。`artifacts/document-hmr-20261006/acceptance.json` 使用真实 Vite 热更新三次验证旧订阅仍可看到工程和后续编辑，撤销重做有效。没有完整现场 HMR 轨迹，不能宣布它是所有空白情况的唯一原因。已经发生状态分离的旧开发窗口需完整重启一次加载一致的主进程、preload 和界面。原工程仍在磁盘，已复制备份到 `D:/Tuanbo-Recovery-20261006/11111 联动工程.before-editor-repair.tblink`，两份 SHA256 一致。

## 已执行证据

- 类型检查通过：`artifacts/editor-final-typecheck-20261006.log`。
- Lint：`artifacts/editor-final-lint-20261006.log`。
- 浏览器组件边界回归：`artifacts/editor-late-read-20261006/acceptance.json`。包括旧场景写入不重发、迟到读取不覆盖拖动、拖动期间整场景请求为零、频繁父组件渲染不重置预览时钟；该项使用模拟 OBS，不算实机验收。
- 最终安装程序：`D:/Tuanbo-Editor-Final-Player-20261006/acceptance.json`。原生音频在没有 OBS/MIDI 时播放、暂停、继续、停止三轮；空列表保留选中音频；编辑器与节目页往返三次；重新加载后恢复工程；Windows 原生标题栏命中结果为 HTCAPTION。
- 最终安装程序与真实独立 OBS 32.2.2：`D:/Tuanbo-Editor-Installed-OBS-20261006/acceptance.json` 以及 `no-password/editor-acceptance.json`。无认证、错误密码、正确密码、重复一键连接、场景读取；拖动中外部切换场景后可继续编辑新场景，OBS 回读确认变换。
- 免激活、重新启动与原生设备访问：`D:/Tuanbo-Editor-Final-License-20261006/acceptance.json`。
- 过程中另一次 OBS 验收在重复连接时超过原 30 秒门槛，保留 `artifacts/editor-final-obs-20261006.log`，没有放宽门槛。该轮与安装操作重叠；安装结束后的独立完整复测通过，不能用这次复测消除所有偶发超时风险。

## 测试安装包

版本 0.4.41，独立“团播联动台功能测试版”，不要求激活码，正式授权渠道保持不变。

包含工程热更新修复的最终包：`D:/Tuanbo-Test-Editor-Project-20261006/Tuanbo-Link-Test-NoActivation-0.4.41-x64.exe`

SHA256：`5C5E1CC18DAE1407B961840EC8593377171CD4164C7BB3BD3E1D08189316066D`

最终包已安装后再次验证：

- `D:/Tuanbo-Editor-Real-Project-Complete-20261006/acceptance.json`：使用用户「11111 联动工程」及全部被引用素材的独立副本，4 个节目、编辑器往返 6 次、完整关闭重开，工程及当前节目始终显示；不再把已有保存路径显示为“选择保存位置”。第二次启动截图 `editor-launch-1.png` 确认音频波形、素材和时间线均可见；该项不连接用户 OBS，画面提示未连接属测试边界。原工程 SHA256 前后一致。
- `D:/Tuanbo-Editor-Project-Player-20261006/acceptance.json`：再次通过原生音频播放与标题栏原生命中测试。
- `D:/Tuanbo-Editor-Project-License-20261006/acceptance.json`：再次通过免激活启动与重开。
- `artifacts/document-hmr-typecheck-20261006.log`、`artifacts/document-hmr-lint-20261006.log`、`artifacts/document-hmr-store-test-20261006.log`：类型、Lint 和工程命令历史回归。

## 未验收项

- 六小时原生音频/MIDI 回环已退出成功，324007 个测量点，最大绝对误差 8.237267ms，P99 8.06ms，欠载为零。来源是静音 PCM 与本机回环，不证明实际出声、OBS 画面或实体灯具同步。证据：`artifacts/native-soak-2026-10-06T03-09-45-952Z/report.json`。
- 大工程 UI 长测在约 48 分钟检测到 stopped，未通过；日志记录停止请求，但缺少足够证据区分触发来源。证据完整保留于 `artifacts/native-ui-program-host-prep-60min-20261006`。本包不能作为规定高负载六小时稳定性完成版。
- MA2 3.7.0.5 原生混合动作、现场出灯和高分辨率复杂画面六小时完整验收仍未完成。
