---
name: 团播联动台官网
description: 制作设备手册式的 Windows 编排软件官网视觉系统
colors:
  primary: "#a94319"
  on-primary: "#fff9f2"
  selection-tint: "#f4e7dc"
  neutral-bg: "#f3f4f2"
  neutral-surface: "#fafbf9"
  neutral-text: "#202422"
  neutral-muted: "#59605b"
  neutral-line: "#cdd2cc"
  primary-dark: "#efa77c"
  on-primary-dark: "#262016"
  selection-tint-dark: "#33281e"
  neutral-bg-dark: "#151917"
  neutral-surface-dark: "#1e2420"
  neutral-text-dark: "#e8ede6"
  neutral-muted-dark: "#a7b2a8"
  neutral-line-dark: "#424c43"
typography:
  display:
    fontFamily: '"Tuanbo Display", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(38px, 4.6vw, 66px)"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-.035em"
  headline:
    fontFamily: '"Tuanbo Display", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "clamp(27px, 3vw, 42px)"
    fontWeight: 600
    lineHeight: 1.3
    letterSpacing: "-.025em"
  title:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "19px"
    fontWeight: 600
    lineHeight: 1.65
  body:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "16px"
    lineHeight: 1.65
  label:
    fontFamily: '"PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif'
    fontSize: "13px"
    lineHeight: 1.65
  price:
    fontSize: "43px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-.035em"
rounded:
  image: "2px"
  field: "6px"
  control: "8px"
spacing:
  compact: "8px"
  small: "12px"
  field-gap: "16px"
  column-gap: "20px"
  medium: "24px"
  panel: "32px"
  section-gap: "48px"
  desktop-gutter: "64px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.control}"
    padding: "11px 22px"
  button-primary-dark:
    backgroundColor: "{colors.primary-dark}"
    textColor: "{colors.on-primary-dark}"
    rounded: "{rounded.control}"
    padding: "11px 22px"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.control}"
    padding: "11px 22px"
  text-field:
    backgroundColor: "{colors.neutral-bg}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.field}"
    padding: "10px 12px"
  purchase-panel:
    backgroundColor: "{colors.neutral-surface}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.control}"
    padding: "28px 32px"
  plan:
    backgroundColor: "{colors.neutral-surface}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.control}"
    padding: "28px 32px"
  plan-selected:
    backgroundColor: "{colors.selection-tint}"
    textColor: "{colors.neutral-text}"
    rounded: "{rounded.control}"
    padding: "27px 31px"
---

# Design System: 团播联动台官网

## Overview

**Creative North Star: "制作设备手册"**

以“制作设备手册”为视觉隐喻：银灰纸面、炭色文字、暖橙操作提示，配合接近直角的现场图像与稍圆的表单控件。中文标题清楚、有分量，正文保留系统字体的阅读习惯。

信息按工作流分段，以留白和细线形成阅读秩序。界面跟随系统明暗偏好；暗色保留相同层级、形状与信息密度，不另造一套视觉语言。图像表达现场语境，生成图像须明确标注，不能承担真实产品界面或客户案例的证明。

**Key Characteristics:**

- 银灰与炭色构成中性底色，暖橙承担操作与选中提示。
- 标题使用自托管中文无衬线子集，正文使用系统中文字体。
- 平面分区、细线边界、轻圆角控件，不使用投影。
- 明暗主题保持布局一致，交互反馈简短且可减少。

本文件仅记录 `apps/licensing-server` 官网的已实现系统，不规定 Electron 工作区的视觉。依据为 `web/purchase.css`、`web/index.html`、`web/main.ts` 与 `.impeccable/review/` 下四份明暗、桌面及移动截图；HTML 方向契约为 grounded candidate 7，seed `85a4f6d8`。实现使用静态 HTML、CSS 与 TypeScript。源码是交互与最终文案依据，截图记录对应拍摄时刻。页面策略见 `.impeccable/surfaces/web-index-html.md`。

## Colors

中性底色略带冷绿灰，暖橙只用于动作、选中状态与焦点。机器可读数值以上方 frontmatter 为准。

### Primary

- **设备暖橙**：`primary` 对应亮色 `--accent`，用于主按钮、链接悬停、套餐选择边框与状态文字；`on-primary` 是按钮文字。
- **暗室浅橙**：`primary-dark` 与 `on-primary-dark` 是暗色主题的对应角色。
- **选择浅染**：`selection-tint` 及其暗色对应值用于选中套餐和错误提示底色；错误仍依靠明确文字与边框表达。

### Neutral

- **银灰纸面**：`neutral-bg` 是页面与输入框底色，`neutral-surface` 是购买面板和套餐表面。
- **炭色墨迹**：`neutral-text` 是标题及主要文字，`neutral-muted` 是说明、标签及辅助文字，`neutral-line` 是分区及控件边界。
- 暗色对应值使用 `-dark` 后缀，通过 `prefers-color-scheme: dark` 覆盖相同 CSS 语义变量。`--focus` 在两种主题中均取当前 `--accent`。

**The Single Accent Rule.** 可操作与选中状态共用暖橙；新增页面不得凭装饰需要另增品牌强调色。

## Typography

**Display Font:** 自托管 Noto Sans SC 子集，以 `Tuanbo Display` 声明，仅用于一级和二级标题。字体来源、许可与重建命令见 `web/assets/FONT-SOURCE.md`。

**Body Font:** PingFang SC、Microsoft YaHei、Segoe UI、sans-serif。无独立品牌等宽字体；激活码使用原生 `code` 字体呈现。

标题以字重和紧凑字距形成分量，正文保持较宽松的行距。当前字号按内容角色分配，没有统一等比刻度。

### Hierarchy

- **Display**：首页主标题使用 `display`；移动端覆盖为（43px）。
- **Headline**：章节使用 `headline`；工作流标题覆盖为（28px），演示、须知与联系标题为（30px）。
- **Title**：面板标题使用 `title`；工作流子标题缩为（16px）。
- **Body**：基础使用 `body`；主说明行高（1.85），多数区域说明为（14px），段落最大宽度（65ch）。
- **Label**：表单标签与多数辅助说明使用 `label`；细节提示为（12px），图片图注和页脚为（11px）。
- **Price**：套餐数字使用 `price` 和等宽数字；中等宽度降为（38px），移动端降为（30px）。合计数额桌面为（28px），移动端为（25px）。

**The Glyph Coverage Rule.** 标题字形由本地子集承载；改动标题后必须检查子集，不把后备字体混排当作已完成的排版。

## Layout

页面容器最大宽度（1440px），桌面两侧内边距（64px）；不超过（1100px）时收为（32px），不超过（767px）时收为（20px）。段落按水平分割线与纵向留白组织，表单是局部密集区域。

首页桌面首屏为文案与图像双栏（1 : 1.18），间隔（48px）；移动端依文案、行动、图像顺序堆叠。图片桌面高度为 `clamp(280px, 31vw, 430px)` 并裁切填满，移动端为（3 : 2）。此构图属于首页，其他页面继承对齐、间距与层级，不必重复相同首屏。

工作流在中等宽度先切单栏；移动端将内部两段、结算、演示、须知和联系区改为单栏。套餐始终保留并排两列；移动端价格周期与状态移到独立行。表单的购买主体与数量仍为两列，移动端订单操作按钮纵向排列。间距以 frontmatter 中的实际复用值为参考；源码存在内容驱动的局部覆盖，不宣称统一栅格倍数。

## Elevation & Depth

页面没有投影。层次由页面与表面色差、单像素描边、留白和文字层级产生。选中套餐以双像素强调边框与浅染底色标识；同步减少内边距，避免边框增粗造成内容跳动。图片自身的光影不扩展为界面光效。

**The Flat Surface Rule.** 常态与悬停均保持平面，不为卡片和按钮增加投影；交互反馈由颜色、焦点和短促按压表达。

## Shapes

图像采用接近直角的 `image` 圆角；按钮、套餐与购买面板使用 `control`；输入框与错误提示使用 `field`。普通边框为（1px），套餐选中边框为（2px）。不使用胶囊式按钮、装饰切角或悬浮玻璃表面。分割线沿内容区域展开，维持各章节的共同左边界。

## Components

### Buttons

主按钮使用当前主题强调色与对应文字色，最小高度（46px），内边距见 token。次按钮为透明底、边线色边框、正文色文字；文字链接保留可识别的下划线，导航链接仅在悬停时换为强调色。

按钮悬停亮度（0.94），按压缩放（0.98）；禁用态透明度（0.5）、不可操作指针。所有链接、按钮、输入框、下拉框及折叠标题的键盘焦点是（3px）强调色轮廓，偏移（4px）。按钮与链接过渡（0.18s）；减少动效偏好下移除过渡和平滑滚动。

### Cards / Containers

购买面板使用浅表面、单像素描边与轻圆角，无投影。桌面内边距见 `purchase-panel`，中等宽度改为（24px），移动端为（22px 18px）。演示占位容器沿用同类边框与圆角，背景不刻意抬升。

### Inputs / Fields

输入框与原生选择框最小高度（44px），使用页面底色、文字色、边线色与轻圆角；内边距见 `text-field`。标签位于上方，说明紧随字段。复选框使用系统控件与强调色。错误在明确的 `role="alert"` 提示区域显示，不只通过字段着色表达。

### Navigation

桌面页头高（80px），品牌左置，导航右置，以（13px）文字及（28px）间距呈现。中等宽度隐藏英文品牌附注并缩小导航间距；移动端导航换行占满宽度，四项等距分布，字号（12px）。导航不是悬浮层。

### Plan Selector

套餐是完整可点击的按钮，通过 `aria-pressed` 表达单选状态，辅以“已选择”文字。未选为表面色、普通边线；选中使用强调边框与浅染底色。价格使用大号等宽数字，周期与每台单位降级显示。生成订单凭据后锁定选择，界面标识“本单套餐”或“当前在售套餐”。金额、周期、可售性来自服务端目录，设计文件不成为定价来源。

### Disclosure / Status

购买须知与恢复订单使用原生 `details` / `summary`，沿用细线分隔与键盘焦点。加载和不可售说明占据套餐区域；订单进度使用 `role="status"`。没有独立胶囊标签组件，套餐状态采用普通文字。

## Do's and Don'ts

### Do:

- Do 沿用语义 CSS 变量，使文字、边线、表面与焦点随系统明暗模式切换。
- Do 为可操作元素保留可见焦点，并用文字说明选中、不可售、加载与错误状态。
- Do 修改标题后检查字体子集覆盖；新增字形缺失时重新生成子集。
- Do 将生成图像的说明同时保留在替代文字与可见图注中。

### Don't:

- Don't 为营销强调增加第二种品牌色、渐变光晕或卡片投影。
- Don't 将整页正文替换为标题子集字体，或让价格失去清楚的数字层级。
- Don't 用颜色作为套餐选中状态的唯一提示。
- Don't 将示意图当作软件截图或已经发生的客户现场。
