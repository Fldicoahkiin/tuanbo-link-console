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

**2026-10-10 当时未正式上线；2026-10-13 已发布，见下文。** 当时本机到既有服务器的只读 SSH 检查返回 `Host key verification failed`，没有绕过主机身份校验，也没有读取用户凭证目录。服务端接收器仍需要受信任管理员连接更新白名单与脚本；不能只上传新页面。已有 CI 还要求来源提交与服务器工具哈希一致，当时未获提交/推送请求，因此未触发部署。

恢复可信发布连接后，先更新并校验接收器工具哈希，再发布网站静态包与网站 Nginx block；完成公网四页面、所有媒体、Range、商品目录不变、旧入口和回退检查后，才可标记正式上线。

## 尚未达到原计划的验收项

MA2 真实同步与灯具实机片段尚缺；当前只交付真实离线编辑演示。完整视频为四段操作记录，不声称完成整场端到端联动验收。真实移动设备触屏验收尚未完成；官网正式发布及一次真实故障回退已于 2026-10-13 验证。

## 2026-10-13 正式官网更新

用户明确要求将已经重做的官网更新上线。原因确认：服务器的官网目录仍为旧提交 `667fd4d`，先前只部署了授权服务和管理端，新官网未切换。

- 使用提交 `fbf2c92f851db6239d6e037529248a5be0ac420a` 对应的现有官网源码构建；官网内容、录屏与截图均未临时改写。上传归档 2,948,884 字节，SHA256 `610a7cd7addbbf57be47557917038783b658c9c0a39908b8388082489588a0b6`。
- 通过已认证的现有腾讯云管理连接独立发布官网，持有同一部署锁，校验原 Nginx、授权 bundle、环境文件和发布工具摘要；没有触发整个运行时发布或替换生产数据库。
- 首次实际发布在新增截图路由检查失败后自动恢复旧网站指针及 Nginx。发现原来的就绪检查只读取首页：原子切换静态目录后，尚未加载新配置的旧 worker 也会返回新 HTML，不能由此证明新增资源路由就绪。现在同时核对首页与新 manifest 路由，再检查全部文件。新增“新 HTML + 旧路由 404”及错误 manifest 的测试，本地 11 项通过、1 项 POSIX 测试跳过；本次线上故障回退另有实际证据。
- 新发布工具 SHA256 `bf0d3d8cf5276f7ca4965d31ea3c8364acfcefc06892a07411d7223eb93690e3`，原工具备份至 `/var/lib/tblink-deploy/website-manual-20261013T135717Z/publisher.previous.py`。该工具修复尚未提交；后续 CI 应使用包含此修复的源码，旧工具摘要的上传会被现有校验明确拒绝。
- 成功目录 `/srv/tblink-purchase-releases/fbf2c92f851db6239d6e037529248a5be0ac420a-77d13792`；原网站及 Nginx 回退资料 `/var/lib/tblink-licensing/backups/20261013T140216Z-website`；完整回执 `/var/lib/tblink-deploy/website-manual-20261013T140216Z/result.json`。受限部署政策中的 Nginx 摘要已同步更新，其他政策字段保留。
- 服务端 28 个公开文件逐一回读摘要一致，所有 MP4 Range 通过，授权 bundle、环境文件、商品目录及其他站点服务保持原状态。
- 公网首页、`/purchase/`、`/guide/`、`/download/`、JS/CSS 和元数据 200，摘要与本地构建一致；演示视频返回 206 与 1024 字节分段。产品站 `/admin/orders`、`/console-api/session`、`/v1/activate` 仍为 404。商品目录仍为月付 800 元、年付 8,000 元。
- 本地和公网分别完成 20 组页面／视口浏览器复核：图片解码和放大、播放／章节切换、Range 206/416、200% 缩放均通过。浏览器布局测试的商品请求使用隔离响应，真实商品目录另经公网只读请求确认；没有创建生产订单或付款。结果保存在 `artifacts/website-release-20261013/` 与 `artifacts/website-review/`。

官网现已更新；下载仍明确提供正式 0.4.29，视频标明 0.4.46 开发预览。本次没有发布桌面安装包，也不代表软件功能验收已全部通过。

### 2026-10-13 售后入口补充

正式版激活页的“购买咨询与售后”使用首页 `#contact`；新版官网联系区域漏了对应锚点。已补齐并发布至 `/srv/tblink-purchase-releases/fbf2c92f851db6239d6e037529248a5be0ac420a-23f53e2a`，回退资料在 `/var/lib/tblink-licensing/backups/20261013T153606Z-website`。本次仅首页及其清单摘要变化，Nginx、授权服务文件和商品目录保持一致。发布工具完成全部静态资源与视频分段核验；公网首页与本地构建字节一致，`contact`、`purchase` 锚点唯一。浏览器控制工具连续超时，因此未将实际滚动效果记为已验证。证据：`artifacts/website-contact-20261013/`。
