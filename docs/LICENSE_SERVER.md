# 激活码与服务器授权

2026-09-28。授权服务已在目标服务器回环部署，生产密钥已现场生成、验签公钥已编入客户端；公网域名/HTTPS 尚未完成，没有真实收款或生产发码。客户端固定 `required`，未激活仍停在授权页；不能把该版本描述为已上线的收费版。

域名及部署步骤见 [COMMERCIAL_DEPLOYMENT.md](COMMERCIAL_DEPLOYMENT.md)，字段、响应与支付预留接口见 [COMMERCIAL_API.md](COMMERCIAL_API.md)，安全后续工作见 [SECURITY.md](SECURITY.md)。

## 购买与账户

- 操作员不注册账户，激活码就是一份机器授权的持有凭据。个人与企业都支持买断、订阅；企业一张订单可购买 1–100 份独立单机码。机器绑定成功后，重复使用同一码不会增加席位。
- 企业客户名称和个人客户标识随订单记录；订单金额使用人民币分，不使用浮点金额。后台保存订单编号、价格与期限快照、人工核款流水、绑定及审计记录。
- 首版只提供受保护的运营 API。核实实际到账后由运营确认收款并发码。没有直接连接银行核款，没有客户门户、企业成员角色或在线收银台；后台令牌不能交给客户，也不能放入 Electron。
- 发码操作幂等。重复核款可取回同一批码，金额不一致、同一收款流水用于不同订单均拒绝。发码恢复不要求客户再次付款。
- 续费暂通过新订单发放新码，客户停止运行后替换；没有自动扣款、原码自动续期、合并未消费余额或自动退款。金额、服务日期、发票与退款由经营者按真实订单处理，不能把 API 发码当作银行已到账或已退款的证据。

## 实现与保护边界

| 层 | 已实现 | 不能据此宣称 |
| --- | --- | --- |
| 服务端 | Ed25519 私钥签发；SQLite 事务；码的 HMAC 索引与 AES-256-GCM 加密；管理员认证、请求限额、审计 | 完整支付平台、企业权限门户 |
| 客户端 | 固定 HTTPS 地址、禁止重定向、十秒请求期限、响应大小上限；Windows safeStorage 保存码；机器与签名校验 | 本机管理员不能读取凭证 |
| 启动校验 | 每次进程启动联网验证一次，失败不放行、不自动重试；签名租约最多七天且不超过订阅使用期；检测超过五分钟的时间回拨 | TPM 绑定、系统克隆或清空全部状态不可绕过 |
| 收费边界 | 固定 `required`；未激活不挂载工作区，产品 IPC 默认检查、拒绝试用许可；已开始付费会话不因到期中断，已有工程可保存善后 | 已在 Windows 实机上完成全部输出组合验收 |
| 打包 | 关闭正式版 DevTools；禁用 Node 环境／调试入口、启用 ASAR 校验及只从 ASAR 加载；不分发 source map | 原生二进制无法修改，或已完成代码签名 |

公钥与签名许可证允许读取；签名用于防止伪造，不能叫作源码加密。激活码、服务端私钥、后台令牌与加密密钥才需要保密。数据库中的客户和订单信息没有应用层整体加密，生产磁盘和备份应使用存储加密和访问控制。SQLite 单机方案不支持把数据库直接放共享网络盘，也不支持多节点随意复制写入。

机器标识仍为 Windows MachineGuid 的产品域隔离 SHA-256。该值可伪造、系统可克隆；本轮没有设备私钥证明或 TPM 绑定。客户端完全处于攻击者控制之下时，补丁仍可能绕过检查。Web MIDI 是 renderer 能力，运行入口的授权检查也不是原生防破解模块。加强后的打包必须结合 Windows Authenticode 签名与实际篡改试验验收。

官方依据：[Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)、[ASAR 完整性校验](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)、[electron-builder Fuses 配置](https://www.electron.build/docs/tutorials/adding-electron-fuses/)。

## 启动验证、吊销与换机

2026-09-28 用户确认采用每次启动联网检测。当前客户端启动后，进入工作区或执行受保护 IPC 前，自动使用安全存储中的激活码请求 `/v1/activate`，校验签名和机器绑定后放行；并发读取共用一次请求。十秒请求超时、断网、403 撤销、409 绑定不符或响应验证失败均阻止进入，不回退旧缓存、不自动重试；用户可在激活页手动联网验证。初次使用没有激活码时不发送空请求。

买断使用权仍为永久，签名凭证保留最长七天的会话期限，但该期限不豁免下一次进程启动验证。运行中不后台轮询，不因断网强停演出；停止后仍校验本地期限，长期开着程序也可能需要手动刷新。刷新不延长已购买的升级期。

正式客户端禁用离线文件导入，主进程也拒绝通过导入放行。旧文件格式和发行工具仅用于历史兼容验证，不改变已经发出的旧版本行为；旧客户端和旧永久离线文件依然不能即时撤销。

吊销立即阻止新激活和刷新；当前客户端下一次启动即拒绝已撤销激活码。已经通过本次启动验证的会话不会后台获知撤销，在本地租约期限内仍可能继续使用。已运行的现场会话继续，到停止后重新检查。迁移必须先撤销、等待最后签发租约到期加五分钟容差，再生成新码并清除机器绑定。旧码不能再次兑换。此流程宁可延后换机，也不假称离线旧机器已即时解绑；需要当日紧急换机的服务政策应另行确认。

不使用授权服务器驱动 Cue、音频或 MTC；没有后台自动重试。网络失败不会删除许可，也不会自动切换计时或播放来源。工程文件不存授权字段，保留原 schema。

## 本地构建和运行

需要 Node.js 22.16 或更新的 Node 22 LTS，启用该版本的 `node:sqlite`；当前 Node 22 会提示 SQLite 实验性警告。使用仓库锁文件：

```sh
pnpm install --frozen-lockfile
pnpm --filter @tb/licensing-server build
```

配置项见 `apps/licensing-server/deploy/service.env.example`。服务默认仅监听 `127.0.0.1:8787`；签名私钥、32 字节随机数据密钥（base64 文本）和至少 32 字符随机后台令牌分别从文件读取。文件仅服务账号可读，放在仓库及网页目录之外；不要把秘密放在命令行、Git 或桌面包里。

签名密钥用既有 `scripts/license-issuer.mjs keygen` 生成。只把其公钥 JSON 写入 `apps/desktop/src/main/link/license-public-keys.json`；本轮生产私钥已仅在服务器生成。数据密钥一旦更换会影响旧码查找与解密，必须备份，不能直接替换文件当作已完成密钥轮换。保留旧签名公钥，按 keyId 轮换发行密钥。

## Linux 部署交接

1. 确认服务器、域名、服务账号、存储位置及运营访问方式。构建服务，当前 `dist/index.js` 已包含 zod，搭配 `type: module` 的 package.json 和 Node 22.16+ 即可运行，无需在生产下载 npm 依赖。
2. 建立 `/etc/tblink-licensing` 的受限密钥文件和环境文件；创建 `tblink-license` 系统用户。`systemd` 示例会建立私有数据库目录。核对 Node 的实际绝对路径与部署目录，再启用示例 unit。
3. Nginx（当前服务器）及 Caddy（全新环境备选）模板仅将 `/v1/activate` 和 `/health` 暴露为 HTTPS。`/admin/` 不公开，运营在服务器本机或受控隧道调用；不要把监听地址改成公网来绕过反向代理。当前进程按 socket 地址限流，代理后的连接共享限额，需按实际流量在代理补充真实来源限流并调整总容量；不得盲目信任任意 X-Forwarded-For。
4. 客户端 `license-config.json.serverUrl` 已配置为 `https://api.tuanbo-link.jinhefilm.com`；使用独立测试密钥与已签名的测试付费许可做端到端验收。固定 `enforcement: "required"`，不提供免费绕过开关。正式发行前确认生产公钥、Windows safeStorage、单机绑定、网络故障和安装器签名。配置编译进主进程，没有用户可用的环境变量绕过开关。
5. 备份数据库及密钥。备份数据库使用 SQLite 在线备份或停服后一并处理 WAL 状态，不能只在写入期间复制 `license.db`。使用测试环境恢复备份验证旧码可查询、可刷新，订单和审计无缺失。

已通过公网 SSH 登录并部署 systemd 服务；此次 Tailscale SSH 连接超时。Nginx 已用于其他业务，因此不安装 Caddy；新项目 DNS、证书及独立反代已启用，公网健康探测通过。实时部署证据见部署文档。

## 运营 API

所有 `/admin/` 请求需 `Authorization: Bearer <后台令牌>`；JSON 请求需 `Content-Type: application/json`。把令牌直接注入运营进程，勿记录请求头。响应含激活码时仅供受控交付，不上传公开日志。

| 请求 | 用途 |
| --- | --- |
| `POST /admin/orders` | 建立未核款订单，`reference` 幂等；相同编号不同内容拒绝 |
| `GET /admin/orders/:id` | 查状态、码、绑定和最后租约，支持发货恢复 |
| `POST /admin/orders/:id/fulfill` | 实际核款后提交 `paymentReference`、`amountFen`，事务发码 |
| `POST /admin/licenses/:id/revoke` | 提交 `reason`，撤销并记录原因；不等同执行退款 |
| `POST /admin/licenses/:id/migrate` | 提交 `reason`，满足旧凭证失效条件后返回新码 |
| `POST /v1/activate` | 客户端提交 `product`、`code`、`machineCode`，返回签名 `license` |

订单 JSON 示例（纯测试数据，非正式报价；日期按实际服务合同填写）：

```json
{
  "reference": "TEST-20260927-001",
  "customer": "验收企业",
  "customerType": "company",
  "quantity": 3,
  "kind": "subscription",
  "amountFen": 300,
  "useUntil": "2027-09-27T00:00:00Z",
  "updatesUntil": "2027-09-27T00:00:00Z"
}
```

客户类型 `personal | company`；类型 `perpetual | subscription`。买断 `useUntil` 必须为 null。不提供试用；客户端拒绝 trial 许可。

## 自动支付后续接入要求

公司商户申请、税务及自动开票规划见 [PAYMENTS_AND_TAX.md](PAYMENTS_AND_TAX.md)。不建设客户账户。

经营者需要确定收款公司主体、商户号、渠道、服务端通知域名及正式套餐。个人购买与企业采购共享授权模型，企业另按真实需求处理合同、发票抬头和税号；本轮不收集多余实名资料。

自动支付应新增服务端商品价目、下单、官方回调验签／解密、查单、幂等交付与退款对账。当前 `/admin/.../fulfill` 是受控人工核款 API，绝不能直接暴露为“支付成功回调”。客户截图或前端 `paid: true` 不构成付款事实。生产必须用官方渠道回调核对商户、订单、币种、金额和流水；测试通过后再进行受控真实订单验收。本轮没有实现或模拟微信／支付宝支付成功。

现有建议价格见 `COMMERCIALIZATION.md`，仍不是生效报价。上线前由经营者确认授权条款、隐私说明、退款规则、开票主体及第三方软件分发义务。

## 本轮验证记录

验证主机为 macOS，2026-09-28：

- `pnpm typecheck`、`pnpm lint` 通过。最终授权变更相关文件的定向 lint 再次通过。
- 服务端、客户端许可和权限会话专项共 18 项通过，覆盖核款幂等、错误金额、流水复用、跨机绑定、签名互通、加密落盘、订阅到期、升级期不被续租延长、吊销／迁移、服务端时钟回退、客户端回拨、网络失败、坏响应、会话到期保留与停止竞态。
- Chromium 组件回归 3 项通过，使用测试桥验证真实授权组件；覆盖激活成功、字段清空、企业名称及期限显示、错误提示、断网保留授权和运行中禁用。另验证未付费不挂载工作区和激活后进入。截图已检查。此项不是 Windows Electron safeStorage／MachineGuid 的实机验收。
- `pnpm --filter @tb/licensing-server build` 通过；对构建产物使用临时测试密钥启动，健康检查和受认证订单创建通过；测试服务已停止。
- `pnpm --filter @tb/desktop exec electron-vite build` 通过，重新生成 main、preload、renderer；未复用旧 preload。macOS 无法运行本仓库完整 `pnpm dev` 的 Windows 原生前置构建，因此没有宣称 Windows 进程重启验收通过。
- 全库 Vitest 回归快照：913 项通过、18 项失败、44 项跳过。18 项位于原有 Windows PowerShell／OBS 插件／IBT 和真实媒体处理用例，错误包括平台限制、缺少 DLL／EXE／FFmpeg；没有将失败跳过或修改断言以伪造通过。该快照之后补充的两个时序测试已包含在之前 16 项专项检查；此次全功能付费策略新增测试后的 18 项也已通过中。
- 仓库标准 `pnpm test` 在 IBT Windows 构建前置步骤停止，`pnpm build` 在 OBS Windows 插件构建前置步骤停止。正式 `pnpm verify:release`、安装器签名、ASAR 篡改拦截、真实 OBS／MIDI／MA2 与服务器 HTTPS 联调仍须 Windows 与部署环境验收。
- 以上为最初本地检查记录；后续已部署回环服务，见部署文档。未进行 DNS 修改、商户提交、收付款或 Git push。
