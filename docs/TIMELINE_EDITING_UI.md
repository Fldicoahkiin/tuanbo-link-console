# 时间线编辑交互

2026-09-14：移除顶部选择、分割、删除按钮；保留直接选中、拖动与键盘快捷键。

参考剪映官方基础编辑说明 https://www.capcut.com/resource/how-to-use-capcut 和分割说明 https://www.capcut.com/resource/split-video-into-parts ，采用选中描边、两端窄修剪手柄、按对象提供操作的右键菜单。

- 素材：复制、后方副本、播放头粘贴、分割、前后修剪、首尾定位、原声开关、删除。
- 机位 Cue：复制、后方副本、粘贴、前后修剪、首尾定位、删除。无时长 Cue 不显示修剪。
- 空白轨道：粘贴到播放头。
- 灯光：保留原有点编辑、剪切复制粘贴与删除；补充灯光片段删除。
- 锁定图层禁用修改；菜单支持方向键、Home/End、Escape，按实际尺寸避让窗口边界。
- 新增 Cue 副本经 addCueCommand，生成独立 Cue/动作编号，支持撤销。

验证：scripts/check-timeline-menu.mjs 使用隔离页面，不改用户工程；检查菜单回调、锁定、空白粘贴、键盘与边界。截图在 acceptance-20260914-timeline-menu。workspace-actions.test.ts 覆盖副本/撤销与锁定限制；timeline-geometry.test.ts 和 timeline-state.test.ts 验证几何和解析。

后续视觉修正：单点 Cue 使用 22px 单行标签，时间码保留在悬停提示中；时长片段保留两行。选中保留底色和原尺寸，使用细描边；修剪手柄仅在悬停或键盘聚焦时显示，不再使用整块白色端帽。
