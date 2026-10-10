# 产品官网重做 · 2026-10-10

本次只修改官网、官网素材与发布链。美颜不作为官网内容；未修改桌面软件的美颜功能，未发布桌面安装包，未提交或推送 Git。工作区的其他桌面端改动属于已有工作。

## 页面与运行

首页 `/`、下载 `/download/`、指南 `/guide/`、购买 `/purchase/`。旧 `/#purchase` 定位到首页授权区，继续进入购买页；`/purchase/#receipt` 恢复已有订单。订单客户端和存储格式沿用原实现。

```powershell
pnpm --filter @tb/licensing-server build:web
node scripts/serve-product-website.mjs
```

预览地址 `http://127.0.0.1:4178/`。预览只读取正式商品目录；创建与查询订单的写请求被明确拒绝。购买流程由隔离测试服务验证，不能在预览中实际付款。

HTML 来源为 `apps/licensing-server/web/pages.mjs` 与 `checkout.html`。`site.ts` 只处理商品读取、截图放大与播放器；`main.ts` 只在购买页加载。公共视觉为 `site.css`，购买表单补充样式为 `purchase.css`。旧首页源码已移除，旧 studio.webp 仅为历史发布白名单兼容保留，新页面不引用。

## 功能证据与版本

正式下载信息来自 `web/release.json`，2026-10-10 核对公网 `latest.yml` 为 **0.4.29**。演示来自本地 **0.4.46 开发快照**，所有功能段落、视频、指南均标注开发预览，下载页再次解释差异。没有把测试版本功能写成正式版交付承诺。

| 功能 | 实际证据 | 可说明的范围 | 未完成的实机证据 |
|---|---|---|---|
| 节目编排 | 三节目隔离工程、节目单截图、节目改名与切换工作区录屏 | 每首节目单独保存画面和灯光编排 | 未验证所有正式版功能与开发版完全一致 |
| 素材播放 | 60 秒原创视频、音乐波形、真实片段拖移、修剪入点、撤销与时间线播放 | 对照波形定位、素材播放与编排 | 不作为端到端延迟测量 |
| 机位切换 | 真实独立 OBS 32.2.2、两个专用场景、WebSocket 当前场景回读 | 机位 A/B 与受管素材场景切换 | 没有现场摄像机；使用原创建色块和标题的示例场景 |
| 灯光编辑 | 真实灯光工作台、8 个 Cue、修改时间与撤销重做 | 离线 Cue 编排与编辑 | 没有 MA2 onPC/实体控台联动录屏，也没有实体灯具效果证据 |

功能实现依据见 `OBS_SCENE_WORKFLOW.md`、`OBS_REALTIME_CANVAS.md`、`LIGHTING_MA2_IMPLEMENTATION.md` 与桌面端的 TimelineItems、ClipInspector、ReferenceTimeline、LightingOutputControl。实时连接状态未重绘或伪造，离线状态直接保留在素材中。

## 素材与来源

- `web/assets/20261010-*.webp`：6 张真实软件截图，1440 × 900；首页主图复用素材时间线截图。只压缩，不重绘 UI。
- `web/media/20261010-overview.mp4`：90 秒操作演示，四段实际操作依次连接。无合成配音，不添加假同步音轨。
- 同目录四支功能短片、中文字幕 `20261010-overview.vtt`；完整视频每段保持原速，捕获帧间隔按真实时钟记录。屏幕采样约 4–6 fps，编码为 30 fps，不能用于评估设备时序精度。
- `web/media.json`：软件版本、来源、每个媒体的字节数和 SHA-256。
- `artifacts/website-delivery/官网静态站.zip` 与 `官网演示源素材.zip`：完整静态站和源素材交付包；后者包含工程、原创素材、脚本、逐帧原始录制及时间间隔、截图、字幕和来源记录，不包含用户配置或凭据。
- `artifacts/website-media/直播剪辑化.tblink`：schema v2 隔离演示工程，开场、主节目、返场；同目录 `music.wav` 为脚本原创 120 BPM 音乐，`visual.mp4` 为原创渐变背景。不得把程序生成的示例背景宣传为现场机位录像。
- `artifacts/website-recording/`：原始截图、逐帧图片和真实时间间隔、OBS 回读证据与录制记录。`evidence.json` 为成功记录；调试失败日志单独保留，不冒充成功证据。
- `scripts/create-website-media.mjs`、`record-website-demo.mjs`、`website-obs-session.mjs`：可复用的素材创建与真实软件录制脚本，Windows 原生运行。

录制使用独立 Electron profile、独立 OBS portable 配置和专用场景，不修改用户正式节目，不控制 OBS 推流或录像。未正常退出的隔离 OBS 身份在各素材目录的 `owned-obs.json` 中，关闭错误写入 `cleanup.txt`；没有强杀。

最终录制成功并正常关闭了 PID 50760 的独立 OBS。早期素材阶段 PID 18576 与一次复用 profile 卡住的 Electron PID 53096 / 录制 Node PID 30776 在正常关闭尝试后仍未退出，窗口已关闭；没有采用强制终止。后续清理必须重新核对 PID、启动时间和命令行，不能仅凭这里的 PID 操作。

## 验证

```powershell
pnpm --filter @tb/licensing-server typecheck
pnpm --filter @tb/licensing-server build:web
node scripts/verify-product-website.mjs
node scripts/verify-purchase-website.mjs
python -m unittest discover -s apps/licensing-server/deploy -p test_publish_website.py
```

产品浏览器测试包含 360、390、768、1440、1920 像素 × 四页面，图片解码与放大、Escape 关闭、视频章节和短片切换、字幕恢复、HTTP Range 206/416、200% 缩放。首页用户播放前不得请求 MP4；页面资源校验目标 1.5 MB。截图与结果保存在 `artifacts/website-review/`。

2026-10-10 本地结果：20 组页面/宽度全部通过，视频播放、暂停、章节定位、全屏和字幕恢复通过；放大图关闭后键盘焦点返回原链接。首页在滚动加载全部图片后资源约 705 KB，未点击视频时 0 个 MP4 请求。购买浏览器场景通过，购买客户端 8 项单测通过，授权站 TypeScript 检查通过。

购买测试沿用原隔离场景，覆盖套餐切换、不可售和请求错误、会话恢复、凭据导入导出以及微信待付款、已付款、失败、关闭和超时状态。未向真实支付渠道发请求，未实际扣款。

Windows 本地发布脚本单测包含清单篡改、路径白名单、Range 检查、Nginx 路由与安全头；POSIX 的符号链接回退场景在 Windows 跳过。完整 Linux 发布/回退测试由已有 CI 执行，未将 Windows 通过等同于服务器验收。

## 发布与回退

构建输出 `website-manifest.json`：精确文件列表、大小和 SHA-256。上传端、接收端和网站发布端同步扩展为 28 个公开文件；每支 MP4 限 40 MB，其余单文件限 2 MB，总接收包限 128 MB。禁止从任意 URL 动态装载未列出的媒体。

Nginx 明确放行四页面及素材；版本化媒体一年缓存，HTML、脚本元数据与订单接口保留 no-store。每个重定义缓存头的媒体 location 重复安全响应头。产品站不能代理管理员或桌面激活接口。

`publish-website.py` 解包前检查允许文件与大小，解包后核对清单哈希，保护现有服务 bundle、环境文件和商品目录。先 `nginx -t` 再原子切换静态目录，发布后逐文件回读 SHA-256，逐 MP4 检查 Range 206。任一发布探针失败会恢复旧静态目录指针与 Nginx 配置并重新校验/加载。回退信息保存在服务端备份目录的 `rollback.json`、`nginx.previous.conf` 和 `result.json`。

**当前未正式上线。** 本机到既有服务器的只读 SSH 检查返回 `Host key verification failed`，没有绕过主机身份校验，也没有读取用户凭证目录。服务端接收器仍需要受信任管理员连接更新白名单与脚本；不能只上传新页面。已有 CI 还要求来源提交与服务器工具哈希一致，本次未获提交/推送请求，因此未触发部署。

恢复可信发布连接后，先更新并校验接收器工具哈希，再发布网站静态包与网站 Nginx block；完成公网四页面、所有媒体、Range、商品目录不变、旧入口和回退检查后，才可标记正式上线。

## 尚未达到原计划的验收项

MA2 真实同步与灯具实机片段尚缺；当前只交付真实离线编辑演示。完整视频为四段操作记录，不声称完成整场端到端联动验收。正式发布、Linux 回退实测以及真实移动设备触屏验收尚未完成。需要这些外部条件后才能关闭全部计划验收项。
