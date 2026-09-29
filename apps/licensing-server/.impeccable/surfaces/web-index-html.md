---
version: 1
slug: "web-index-html"
primary_target: "web/index.html"
related_targets: ["web/purchase.css","web/main.ts"]
---

# 团播联动台官网首页与购买

## 范围与访问模式

官网 `/`；主要模式为 Persuade，进入结算后以完成购买及恢复原单为目标。目标文件为 `web/index.html`，相关实现为 `web/purchase.css` 与 `web/main.ts`。

## 受众、任务与动作

面向团播工作室、现场操作者及采购者。先说明本机编排与 OBS 联动的用途，再让用户下载 Windows 软件或在同页比较月付、年付，最后进入单个结算表单。两种周期直接并列，移动端也保留两列，不能藏入周期切换器。

## 方向与记忆点

已选方向是制作设备手册，grounded candidate 7，seed `85a4f6d8`。首屏左侧短标题与行动，右侧大幅空置直播间图；移动端依次排列。方向来自 HTML body 契约，视觉 token 由 `DESIGN.md` 持有。后续内容依次为工作流、套餐与结算、演示、购买须知、联系信息。

## 证明材料与内容边界

直播间图是 AI 生成的场景示意，不能暗示产品截图或真实客户现场；图注与替代文字均明确其来源，素材溯源见 `web/assets/studio-provenance.md`。标题字库来源见 `web/assets/FONT-SOURCE.md`。无真实演示视频时显示准备中占位，不使用自动播放装饰视频。官网仅显示产品名，不展示公司全称。

## 购买约束

同页套餐共用一个 checkout，服务端目录决定金额、期限和可售性；设计不改定价。保留订单凭据下载、导入恢复、查询与领取激活码。目录失败应明确提示并保留恢复入口，不把示例金额视为可售报价。准备订单与实际创建、付款状态必须保持区分。

## 当前证据与未决项

静态 HTML/CSS 与 TypeScript 实现，明暗跟随系统。视觉记录为 `.impeccable/review/desktop.png`、`mobile.png`、`desktop-dark.png`、`mobile-dark.png`；截图只证明对应时刻的渲染，最终图注与交互以源码为准。finish review 已由主任务完成，修复范围与验收结论由主任务保留；本文不扩大为正式支付或 Windows 实机验收。真实演示视频仍待提供。
