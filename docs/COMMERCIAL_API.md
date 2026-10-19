# 商业接口与凭证契约

2026-10-06 补充：可视化运营后台已在本地实现，含独立管理员认证、角色权限、订单／授权操作、特殊授权及人工售后记录，**尚未部署生产**。新增 `/console-api/*` 不替换下面的旧运维接口，实施与验收见 [运营管理后台](OPERATIONS_CONSOLE.md)。

2026-09-30 当前生产状态：Windows **0.4.29** 已正式发行，公司更新源已发布安装包、blockmap 与 `latest.yml`；官网已开放支付宝月付 **800 元／30 天／台**、年付 **8,000 元／365 天／台**。已核验未付款订单创建、同单恢复和未付款不发码，未进行实际扣款。Windows CI 已通过正式安装版无凭证拦截、覆盖安装与卸载验收，见[专项记录](LICENSE_UPDATE_ACCEPTANCE.md)；真实支付交付与续费、退款及两版本重启更新仍待真人测试；微信 Native 服务端及官网已部署、隔离测试通过，但生产商户尚未配置、未开放真实微信付款；自动开票尚未接入。实际构建、摘要与部署备份见 [发行记录](RELEASE_0.4.29.md)。下文带日期的旧关闭／未发行记录只表示当时状态。

2026-09-29。本文区分已实现接口和后续设计。生产 origin 为 `https://api.tuanbo-link.jinhefilm.com`，既有授权服务、公网 DNS/HTTPS 已有验收记录；支付宝回调、客户领取、自助商品目录与下单接口已部署。支付宝身份和回调验签已配置，服务器生产只读查单响应验签通过；销售开关和正式商品目录已于 2026-09-29 启用。客户领取接口要求订单专属凭据。实现依据：`apps/licensing-server/src/http.ts`、`service.ts`、`packages/schema/src/license.ts`。

## 2026-10-14 订单生命周期、关单、退款通知、支付环境与限流（本地实现，待部署）

本节取代下文旧记录中“订单只有 pending/fulfilled”“TRADE_CLOSED/退款通知非成功响应”“付款窗口结束不关闭订单”“固定生产网关”“地址表满拒绝新来源”的描述。公网路径、激活 JWS 格式与 `.tblink` 均未改动。

### 订单状态机

`orders.state` 取值 `pending → paid → fulfilled`、`paid/fulfilled → refunded`、`pending → closed/expired`；`closed/expired → paid` 仅用于关单后仍收到验签成功付款（保留收款事实并照常交付）。所有变更经 `LicensingService.transition()`，在事务内校验允许的前驱并写 `order.state-changed` 审计（`from->to:原因`）。生产激活脚本禁止改写既有表行，因此**不回填旧数据**：旧版“有收款记录但仍为 pending”的订单在下次补交付、退款事件时由 `settle()` 收敛为 paid；运营异常列表与客户 DTO 按“有收款且未交付”判断，二者兼容。

- **关单条件**：订单为 pending、无收款记录、`alipay_payment_links.expires_at` 已过，且渠道确认——`alipay.trade.query` 返回已验签的 `40004/ACQ.TRADE_NOT_EXIST` → expired；返回 `TRADE_CLOSED`（无退款）→ closed；返回 `WAIT_BUYER_PAY` 时服务端先调用 `alipay.trade.close`，收到已验签 `10000` 后 → closed，未确认（如 `ACQ.TRADE_STATUS_ERROR`）返回 502 `PAYMENT_CLOSE_UNCONFIRMED` 并保持 pending。付款期限内的任何结果都不关单；关单只由客户、运营或后台的显式查单触发，没有定时任务。
- **验签 TRADE_CLOSED 通知**满足同样条件时也关单；期限内只记事件。
- 微信订单暂不关单（Native 关单接口未接入），过期微信单仍按原流程查询。

### 客户 DTO 与旧客户端兼容

`/v1/orders`、`/v1/orders/:id`、`/v1/orders/:id/reconcile` 的 `state` 只公开 `pending | fulfilled | closed | expired`：paid 映射为 `pending + paymentConfirmed`（与旧版一致），已交付后退款仍为 fulfilled（授权是否撤销按下文退款规则，已撤销的码不再返回），未交付即全额退款为 closed。终态订单的客户查单直接返回本地结果，不再请求渠道。已发布的旧桌面版严格校验 `state`，遇到 closed/expired 会解析失败并保持锁定（与修复前同样无法下单），升级后即可解锁。

- **桌面**：查询返回 closed/expired 时把本机记录写为已结束，不再阻止新建订单或续费；付款按钮隐藏，查询按钮保留。
- **已发布的 0.4.29 桌面端**：其订单 schema 只接受 `pending | fulfilled`，查到 closed/expired 订单会显示解析错误；此前同一订单会一直停在待付款，两者都需运营核对。截至 2026-10-14 真实付款为 0 笔，没有受影响的客户；0.4.46 起的桌面端和网页按上述规则处理。
- **网页**：付款入口到期或查询结果为已关闭时显示“重新生成付款”。点击后先查单，服务端确认 closed/expired 才清除旧凭据、用同一套餐生成新凭据，客户需重新下载凭据再建单；原单仍可能到账时明确拒绝。

### 非成功通知与退款

`AlipayNotifications.verify()` 只做验签与字段校验，交由 `LicensingService.alipayNotification()` 判断：`TRADE_SUCCESS/TRADE_FINISHED` 且 `refund_fee` 为 0 才交付；其余验签通过的通知（含 `refund_fee>0` 的 TRADE_SUCCESS、TRADE_CLOSED、WAIT_BUYER_PAY）核对订单、绑定身份、金额与已有收款流水后写入新表 `payment_events`（`交易号:状态:累计退款额` 去重），应答纯文本 `success`。`refund_fee` 是累计退款额；等于订单金额时订单转 refunded，部分退款只记事件。**通知从不撤销授权**：支付宝商户后台直接办理的退款只记录、标记，由运营在控制台确认。

### 退款规则（2026-10-14 确定）

客户没有自助退款，退款只由运营在控制台发起或确认，均需原因与近五分钟二次验证。

- **支付宝原路退款**（`alipay-refund`，负责人/财务）：仅限已确认支付宝收款、未全额退款的订单，累计不超过订单金额。先在 `alipay_refunds` 登记退款请求（其 id 即 `out_request_no`），再调用 `alipay.trade.refund`（`refund_reason` 最多 256 字，超长拒绝）。响应已验签且 `fund_change=Y` 视为成功；否则用 `alipay.trade.fastpay.refund.query` 查询，`refund_status=REFUND_SUCCESS` 且金额一致才视为成功。网络错误、未签名、未确认时订单与授权都不变，退款请求保持待确认；同一订单只允许一笔待确认请求，运营稍后用新的操作按**相同金额**重提即复用同一 `out_request_no`，支付宝据此去重，不会重复退款；金额不同则拒绝。不提供取消待确认请求，避免掩盖支付宝已处理的退款。
- **确认后**：全额退款且非续费订单，在同一事务内标记 refunded、撤销本订单签发的全部授权（`licenses.order_id`）、写审计和自动处理记录；部分退款与续费订单只记录并进入异常队列（续费单不拥有授权，撤销会吊销原订单已付期限）。成功的原路退款同时写入财务退款记录，`reference` 为 `alipay-refund:<out_request_no>`，财务页显示为“支付宝原路退款”。
- **异常队列**：渠道累计退款（通知累计额与已确认原路退款取大）> 已处理金额（`refund_reviews`）的订单进入“交付异常”，工作台显示“渠道退款待处理”。运营在订单中“处理渠道退款”：一键撤销本订单全部授权，或保留授权结案（续费单只能保留，须先用“调整到期时间”回退续期）。之后再有新的退款会重新入列。“登记已办理的退款”只记财务账，不影响队列。`/admin/payment-exceptions` 与自动补交付任务不包含退款。
- 新增表 `alipay_refunds`、`refund_reviews`，均为新增表。原路退款依赖开放平台应用已开通退款权限（见 [商业接入](COMMERCIAL_ONBOARDING.md)）；支付宝建议退款发起后间隔 10 秒以上再查询，结果未确认时请稍后重提。

拒收的通知（验签失败、身份/金额/流水不符、未知订单等）返回非 200，并输出一行结构化日志 `{"requestId","error":"PAYMENT_NOTIFICATION_REJECTED","channel","code","orderId"}`；`orderId` 仅在验签通过后出现，不记录原始报文、买家信息或签名。微信通知同样记录拒收日志；微信退款通知仍不处理。

### 支付环境与沙箱联调

| 环境变量 | 取值 | 缺省 |
| --- | --- | --- |
| `PAYMENT_ENVIRONMENT` | 只接受 `production` / `sandbox`，其他值启动失败 | `production` |
| `PAYMENT_NOTIFY_ORIGIN` | 支付宝/微信异步通知的 HTTPS origin，不含路径 | `https://api.tuanbo-link.jinhefilm.com` |

`production` 使用 `https://openapi.alipay.com/gateway.do`，`sandbox` 使用 `https://openapi-sandbox.dl.alipaydev.com/gateway.do`（支付宝新版沙箱；以沙箱控制台显示的网关为准，旧域名 `openapi.alipaydev.com` 不再使用）。网关映射位于 `packages/schema/src/purchase.ts`。付款链接、查单、关单都使用所配环境；`notify_url` 为 `<PAYMENT_NOTIFY_ORIGIN>/v1/payments/alipay/notify`。微信支付 APIv3 没有沙箱，`sandbox` 下配置任何微信参数都拒绝启动。

`POST /v1/orders`（支付宝）响应头 `X-Tblink-Payment-Environment` 下发环境。桌面和网页只接受该环境对应的固定网关；头缺失、取值未知或网关不符时拒绝打开付款链接。桌面仍要求 `notify_url` 等于其编译配置的服务器 origin，所以 `PAYMENT_NOTIFY_ORIGIN` 必须与客户端访问的 API origin 一致。

沙箱联调步骤（不涉及真实资金）：

1. 在支付宝开放平台“沙箱环境”取得沙箱 APPID、沙箱商户 PID（2088 开头），按沙箱应用配置 RSA2 密钥，下载**沙箱**支付宝公钥；均与生产密钥不同，不能混用。
2. 在独立的测试服务器（不能与生产共用数据库或 env）配置 `PAYMENT_ENVIRONMENT=sandbox`、`PAYMENT_NOTIFY_ORIGIN=<该服务器公网 HTTPS origin>`、沙箱 `ALIPAY_APP_ID/ALIPAY_SELLER_ID/ALIPAY_PUBLIC_KEY_FILE/ALIPAY_PRIVATE_KEY_FILE`，`ALIPAY_CHECKOUT_ENABLED=true` 及测试目录；不要配置微信参数。确认启动日志显示“支付环境 sandbox”。
3. 用该服务器的 `/purchase/` 网页下单，用沙箱版支付宝 App 和沙箱买家账号付款，核对异步通知交付；在沙箱商户后台退款，核对事件表、订单 refunded 与后台异常队列；在控制台对另一笔订单发起全额与部分原路退款，分别核对 `fund_change=Y` 与重复提交（`fund_change=N` → 退款查询）两条路径、授权撤销及队列；让付款链接过期后查询，核对关单及“重新生成付款”。
4. 桌面端的服务器地址来自编译配置 `apps/desktop/src/main/link/license-config.json`，沙箱联调需单独构建指向测试服务器的版本，不得发布。

### 限流

支付通知路由（`/v1/payments/*`）不计入来源限流，只靠验签把关。其余分组计数表最多 10000 项，满时淘汰最久未用的来源，不再拒绝新地址；IPv6 按 /64 计数，IPv4 按单地址。计数仍是单进程内存状态。

### 运维步骤

- **无强制 env 变更**：两个新变量均有生产缺省值，现有 `service.env` 可直接部署。仅在想显式声明时追加 `PAYMENT_ENVIRONMENT=production`。
- 部署只新增 `payment_events` 表及索引，不改既有表行，符合 `activate-release.py` 的快照比对。
- 同步部署 `apps/licensing-server/deploy/export-payment-ledger.py`：台账导出的 `delivery_states` 新增 `paid`、`refunded`，旧脚本遇到新状态会拒绝导出。
- 微信关单、微信退款与退款通知尚未接入。

本地验证：授权服务与桌面购买 vitest、Python 运维测试（含用新 bundle 运行的交付恢复集成测试）、网页 Playwright 验收脚本，均使用测试密钥与隔离数据库；退款字段名按支付宝官方 Java SDK 的 `AlipayTradeRefundResponse`、`AlipayTradeFastpayRefundQueryResponse` 核对。未连接支付宝沙箱或生产网关，未做真实付款、退款或关单；上线前须在沙箱走通原路退款的两条确认路径。

## 产品与商户范围

公司首次支付宝商户申请优先使用金河分镜真实网站，团播联动台随后接入。商户可共用不表示当前接口已经支持多个产品：本服务许可契约固定为 `tuanbo-link-console`，当前订单付款交付会生成团播联动台激活码，不得将金河分镜订单导入本服务。支付宝配置当前也只接收一组应用与收款方身份。

统一支付后台是后续方案，尚未实现。接入第二个产品前须建立服务端确定的产品与商品标识、价格版本、订单所属应用和独立交付处理；回调以持久化订单为依据核对应用、收款方、金额和流水，不能使用客户端传来的产品名直接选择交付。发票与退款应关联原交易、产品及公司收款主体。不得仅放宽 APPID 校验或复制密钥来实现多产品接入；具体应用权限须先在开放平台确认。

## 已实现接口

除下述支付宝回调外，服务本体成功时返回 200 JSON，写接口要求 `Content-Type: application/json`；请求对象经 Zod 校验。请求体最多 16KiB、请求头最多 8KiB、HTTP 请求超时 10 秒；限流每连接来源 IP（IPv6 按 /64）每业务组 120 次/分钟，新增下单组与客户主动查单组各自限制 10 次/分钟；支付通知路由不限流。客户领取和其余接口分组独立，反向代理共享限额的限制见部署文档。响应 `Cache-Control: no-store`，带 `X-Request-Id`。不提供 CORS 购买页、会话 Cookie 或客户登录。

| 方法与路径 | 访问范围 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET `/health` | 公网 | 无 | `{"status":"ok"}`，仅存活，不证明数据库、签名或支付可用 |
| GET `/v1/catalog` | 已部署并开放精确代理；月付和年付单机订阅可售 | 无 | `available,currency,termStart,offers`；配置缺失时无可售商品 |
| POST `/v1/orders` | 已部署并开放精确代理；销售关闭时 503 | 客户预存随机 Bearer 凭据及商品请求，见下文 | 原订单、商品快照、付款期限及 `paymentUrl`；价格只由服务端计算 |
| POST `/v1/payments/alipay/notify` | 代理与验签已启用；缺失配置时 404 | RSA2 签名表单，见下文 | 纯文本 `success`，不返回客户信息或激活码 |
| POST `/v1/activate` | 公网 | `product, code, machineCode` | `{"license":"<Ed25519 JWS>"}` |
| GET `/v1/orders/:id` | 订单专属 Bearer 领取凭据 | 无正文，不接受 URL 凭据 | 脱敏订单状态和已支付授权，见下文 |
| POST `/v1/orders/:id/reconcile` | 订单专属 Bearer 领取凭据 | 空对象 `{}` | 已交付返回原授权；待付向支付宝查单后返回同一交付 DTO，详见客户主动查单 |
| POST `/admin/orders/:id/delivery-access` | 回环/运维隧道 + 管理员 Bearer | `{"reason":"签发或更换原因"}` | `{"token":"TBD-…","expiresAt":"UTC时间"}`，重新签发即作废旧凭据 |
| POST `/admin/orders/:id/delivery-access/revoke` | 同上 | `{"reason":"原因"}` | `{"revoked":true}`，不撤销产品授权本身 |
| POST `/admin/orders` | 回环/运维隧道 + Bearer | 订单对象，见下文 | `{"id":"<UUID>","state":"pending或fulfilled"}` |
| GET `/admin/orders/:id` | 同上 | UUID 路径 | 订单详情和 `licenses`，含完整激活码，仅运营可读 |
| POST `/admin/orders/:id/fulfill` | 同上 | `paymentReference, amountFen` | 与订单详情相同，人工核款后发码 |
| POST `/admin/orders/:id/payment-link` | 同上，代码和收款配置已启用 | 空对象 `{}` | `id,amountFen,quantity,expiresAt,paymentUrl`；默认 503 未启用 |
| POST `/admin/orders/:id/reconcile` | 同上，代码和收款配置已启用 | 空对象 `{}` | `id,state,paymentStatus,needsReview`；调用支付宝查单，可信已付结果幂等发码 |
| GET `/admin/payment-exceptions?after=0` | 回环/运维隧道 + 管理员 Bearer | 非负整数游标，可省略 | 最多 100 条已收款未交付记录与 `nextCursor`，见下文 |
| GET `/admin/orders/lapsed-payment-links` | 同上 | 无 | `{items}`：支付宝付款期限已过 1 分钟以上、仍待付款且无收款的订单 ID，最多 100 条，新近过期在前 |
| POST `/admin/orders/:id/retry-delivery` | 同上 | `{"reason":"补发原因"}` | `{id,state}`；按已保存收款事实补交付，不发起扣款 |
| POST `/admin/licenses/:id/revoke` | 同上 | `{"reason":"原因"}` | `{"revoked":true}` |
| POST `/admin/licenses/:id/migrate` | 同上 | `{"reason":"原因"}` | `{"code":"TBA-…"}`，同一 license ID 换新码 |

管理员请求头 `Authorization: Bearer <至少32字符随机后台令牌>`。不得把后台令牌放在 renderer、preload、安装包或公开网站。Nginx/Caddy 模板对公网 `/admin/*` 返回 404；不能通过修改代理使其成为支付通知入口。

激活请求示意（以下码是格式示例，不是真实授权）：

```json
{
  "product": "tuanbo-link-console",
  "code": "TBA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "machineCode": "TB1-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
}
```

激活码是 `TBA-` 加 32 位十六进制；机器码是 `TB1-` 加 64 位十六进制。首次激活事务绑定机器，同码同机再次请求刷新租约；并非多机新席位。跨机返回 409。刷新仍使用 `/v1/activate`，不存在独立 `/refresh` 路由。

创建订单示例只演示字段，不代表正式报价：

```json
{
  "reference": "TEST-ORDER-001",
  "customer": "验收企业",
  "customerType": "company",
  "quantity": 2,
  "kind": "subscription",
  "amountFen": 200,
  "useUntil": "2027-09-28T00:00:00Z",
  "updatesUntil": "2027-09-28T00:00:00Z"
}
```

- `reference` 1–100 字符，业务幂等键；相同编号、相同规范化内容返回原订单，不同内容 409。
- `customer` 1–160 字符；`customerType` 为 `personal | company`；一份订单 1–100 个独立机器码授权，`quantity` 为整数。
- `amountFen` 是订单总金额，整数人民币分，1–100,000,000。此人工 API 由运营确定价格；客户下单使用下节独立接口，不能提交订单总价。
- `kind` 为 `perpetual | subscription`；买断 `useUntil` 为 null，订阅为 UTC ISO 时间；`updatesUntil` 为 UTC ISO 时间。创建及交付拒绝已结束期限。
- 核款请求 `{"paymentReference":"渠道及真实流水的唯一编号","amountFen":200}`。管理员必须先查实际到账。重复同流水同金额返回已有授权；错误金额、重复占用其他订单的流水、同单改流水均拒绝，不重复发码。
- 详情返回 `{id,state,...订单字段,licenses:[{id,code,machineCode,revoked,leaseUntil}]}`；未绑定的 machineCode 与未签发的 leaseUntil 为 null。核款流水不在详情响应中，数据库及审计保留，不能把查询响应当财务对账单。
- 吊销可重复但每次记录审计；**迁移不是幂等发货接口**，新码生成后立即恢复未绑定状态，再次 migrate 会被拒绝。响应丢失时通过订单详情恢复新码，不再次生成。旧授权须先撤销并等待已签发租约到期加 5 分钟；旧码永久失效。

## 无账号客户领取（API 已部署，桌面随 0.4.29 发布）

领取凭据与激活码、管理员令牌是三种不同的凭证。生产自助下单由客户预存随机凭据，创建时直接绑定订单，不要求建立用户账号；受保护运营接口也可为已经创建的订单签发或恢复领取凭据。客户端不能提交任意金额或标记已付款。

- 领取凭据为 `TBD-` 加 64 位大写十六进制，使用 32 字节随机数；数据库仅存带用途及订单 ID 隔离的 HMAC-SHA256 摘要，不存可还原的凭据。仅签发响应返回一次明文，不记录到日志或审计。
- 当前领取凭据有效期固定为签发后七天，是领取入口的有效期，与软件授权期限分开。响应丢失或遗忘时，运营核对真实购买人后明确重新签发；旧凭据立即失效，不能承诺能找回原文。重复签发不是幂等操作。
- 请求为 `GET /v1/orders/<订单UUID>`，头部 `Authorization: Bearer TBD-…`。不接受查询字符串中的 token，不建立 Cookie，不开放 CORS。将来的网站必须使用同源受控代理或另行实现明确的来源策略，不可为了调通任意开放跨域。
- 未交付返回 `state: pending` 和空 `licenses`；已确认收款但尚未交付时另带 `paymentConfirmed:true`，不能把 pending 等同于未付款。只有交付事务成功后返回原批次激活码。多次领取、服务重启或支付回调重复不会增发授权；领取本身不会核款或改变授权状态。
- 基础返回字段为 `id,state,amountFen,quantity,kind,useUntil,updatesUntil,licenses:[{id,code,revoked}]`，续费含可选 `renewalLicenseId`，已收款待交付含可选 `paymentConfirmed:true`。不返回客户名称、人工订单编号、交易流水、机器码和管理员信息。已撤销的单码只返回 `code: null`，其他未撤销席位仍可领取。
- 无凭据、错误、跨订单、过期、撤销和未知订单均返回 401 `INVALID_DELIVERY_ACCESS`，不泄露该订单是否存在。管理员令牌不能当作客户凭据；客户凭据也不能调用任何运营接口。
- 响应 `Cache-Control: no-store` 与 `Referrer-Policy: no-referrer`；代理日志不得包含 Authorization 或响应正文。凭据不得放进图片、公开聊天、分析埋点或含 token 的 URL。未来收银台需让购买人保存领取凭据，并提供经核实的恢复流程。
- `/delivery-access/revoke` 仅撤销领取权限，不取消已付款授权。换机成功会同时撤销该订单原领取凭据，避免旧领取人取走新码；企业订单换机后由运营向经核实的接收人重新签发订单级凭据。

数据库只新增 `order_delivery_access` 表，旧订单没有默认领取权限。已验证旧数据库结构升级、凭据不以明文落库及服务重启后仍可领取。生产升级已完成数据库备份、副本恢复和既有数据一致性核对；异地密钥备份及整机恢复仍待完成。本地 HTTP 测试已贯通“受保护签发凭据 → RSA2 测试通知 → 事务发码 → 客户凭据领取”，这不等同于支付宝真实付款或已具备收银台。

## 无账号商品计价与订单恢复（服务与商品已启用）

只有同时启用支付宝收款配置并提供 `LICENSE_CATALOG_FILE` 才提供新订单。没有目录时 `GET /v1/catalog` 返回 `{available:false,currency:"CNY",termStart:"fulfillment",offers:[]}`，新下单返回 503；不会回退到测试价格。2026-09-29 已配置正式目录并开放月付 800 元／30 天／台、年付 8,000 元／365 天／台，使用与更新天数一致，每单一份单机授权。客户端报价须匹配商品 revision；商户实际额度及 Windows／真实支付验收仍未完成。

目录是严格 JSON：`version:1,maxOrderAmountFen,offers`。每个商品包含 `id,revision,name,unitAmountFen,kind,useDays,updatesDays,maxQuantity,saleUntil`。金额为人民币整数分；天数为 24 小时，不是自然月。买断 `useDays:null`，订阅为明确正整数天数；升级期限也必须明确。商品 ID 唯一，最多 20 项；单笔金额上限与商品数量共同限制台数。价格或条款变化必须更新 `revision`，不能在原版本号下更改授权条款。

1. 客户读取可售目录，展示商品、含税价、授权/升级天数、起算方式、机器数及购买条款。剩余销售期不足一分钟不再提供新单。
2. 在第一次下单之前，用密码学安全随机源生成 `TBD-` 加 32 字节随机数的大写十六进制，先安全持久化该凭据和完整请求。不得通过 `Math.random`、机器码或用户联系方式派生。凭据及其保存失败不能进入日志，也不能保存失败后继续付款。
3. `POST /v1/orders` 使用 `Authorization: Bearer TBD-…`，正文只接受 `offerId,revision,quotedUnitAmountFen,quantity,customer,customerType`。报价字段用于核对用户刚看到的价格，实际总价始终来自服务端目录乘数量；不能提交期限、渠道身份、订单编号或付款状态。
4. 创建事务同时保存订单、商品快照、领取凭据摘要和支付宝身份/截止时间。返回 `id,state,amountFen,quantity,offer,expiresAt,payable,paymentUrl`。付款期限最多 15 分钟且不超过停售时间。随机凭据不进入付款链接，数据库只保存用途隔离的 HMAC 摘要。
5. 响应丢失或软件重启后，用户明确恢复原购买时，使用原凭据及相同请求重新提交，返回同一订单；不能自动换新凭据重建订单。商品下架、改价或关闭收款配置后仍可恢复原单。原请求已变更返回 409 `PURCHASE_CONFLICT`；未知商品/报价版本返回 409 `OFFER_CHANGED`；超限数量返回 400 `QUANTITY_LIMIT`。
6. 付款链接过期、订单已交付、已保存确认收款或当前商户身份不同，返回 `payable:false,paymentUrl:null`，不延长原窗口、不切换商户。pending 不是渠道确认未付款；通知延迟时沿用原订单，客户可持领取凭据主动查单补交付，运营仍保留查单入口。过期后经查单确认渠道交易不存在或已关闭，订单转 `expired`/`closed`，客户方可另建新单，见上文 2026-10-14 一节。
7. 已验签付款事实首次交付时，按商品快照起算完整使用/升级天数；重复通知和查单不延长期限。人工订单仍保持原有固定截止时间契约。待付领取响应的日期只是预估，客户 UI 应展示商品天数和“首次核款交付起算”，已交付后才显示实际到期日。
8. 通过既有 `GET /v1/orders/:id` 领取原批次激活码。凭据从建单起有效七天，超过七天才确认的支付仍能发码，但需运营核实后重签领取凭据。撤销/更换凭据会使原创建凭据无法恢复；新凭据用于领取原订单，不能冒充原建单凭据。

新增 `purchase_requests` 表记录凭据摘要、规范化请求与商品快照，旧表不删改。服务当前只支持支付宝付款链接；微信不会在请求失败时自动替代。自助订单不收邮箱、不发送交付邮件，客户称呼也不能作为找回凭据的身份证明。

本地隔离测试覆盖服务端计价、篡改拒绝、并发重复、重启恢复、停售恢复、凭据不明文存库、过期/撤销、首次交付起算，以及 HTTP 下单 → RSA2 测试通知 → 原码领取。未向渠道发送真实交易。生产已显式启用 `LICENSE_PROXY_MODE=loopback`，服务只监听回环地址，由本机 Nginx 覆盖 `X-Tblink-Client-IP` 后按客户分组限流：下单 10 次/分钟，领取及其余请求分别 120 次/分钟，支付通知不限流。默认不信任转发头，非回环连接不能改写来源，等价 IPv6 和 IPv4 映射地址统一计数，IPv6 按 /64 合并；不接受 `X-Forwarded-For`。真实负载容量尚未验收，详见部署文档。

### 订阅续费

续费复用 `POST /v1/orders`，在购买请求中增加可选 `renewalLicenseId`；首次建单同时提供 `X-Tblink-Renewal-Code` 激活码与 `X-Tblink-Machine-Code` 机器码请求头。不得放入 URL、日志或 renderer。服务端核对授权 ID、激活码、已绑定机器及撤销状态；只允许订阅商品续订原订阅，数量固定 1，客户名称与个人／企业类型必须与原授权一致。管理员、原订单号或公开机器码本身都不能代替该认证。

新增 `license_renewals` 表记录续费订单与原授权，以及核款后生效的使用／升级截止时间。未付订单不改变授权。核款使用既有商户、金额、签名与唯一流水校验；从当前时间和已有权益截止时间中较晚者追加商品天数，各项权益分别计算，重复回调／主动查单不重复延长。原购买订单快照不改写，不生成新激活码、不解除机器绑定。原授权被撤销时付款不自动恢复授权，交付失败独立保留收款流水与原订单，标记已收款待处理；补发不会绕过原授权撤销规则。

订单和交付响应返回可选 `renewalLicenseId`。续费交付只返回目标授权 ID、撤销状态和本次期限，`code` 始终为 null，避免旧续费领取凭据泄漏后来换机生成的激活码。客户订单凭据仍有七天有效期；原订单响应丢失后使用原凭据恢复，不重新下单。续费认证信息仅用于首次建单，持有原订单凭据的恢复请求不再次授予其他授权的访问权。

桌面“购买方式”新增“续费本机订阅”，仅针对本机保存的在线订阅（包含到期订阅）。主进程从安全存储读取激活码，并将本笔恢复所需认证信息连同随机订单凭据加密保存；renderer 只接收授权 ID 和订单摘要。续费界面固定原客户及一台机器，仅列出订阅商品。付款后主动查询结果，再由用户“联网验证授权”刷新本机签名许可；不自动扣款、不替换激活码、不干扰正在运行的演出。企业跨机统一续费及自然月／年计期尚未实现。

此节为新增源码与本地验证范围；是否已部署及真实验收状态见 [部署记录](COMMERCIAL_DEPLOYMENT.md)。

### 桌面购买与本机恢复

共享契约位于 `packages/schema/src/purchase.ts`；`PurchaseService` 在主进程访问编译配置中的 HTTPS origin，不接受界面传来的服务器地址。请求不跟随重定向，10 秒网络时限，响应最多 64KiB；JSON、金额、数量、商品与原订单不匹配时拒绝保存结果。

- 主进程用 `randomBytes(32)` 生成领取凭据，在任何下单请求前将凭据、规范化请求和本机购买编号写入 `SecureProfileStore` 的加密 `license.purchases` 项。保存失败不下单；服务端返回后本地写入失败仍保留最初的恢复凭据。安全存储串行读改写，防止激活码、时钟与订单并发保存时互相覆盖。
- renderer/preload 只接收脱敏 `PurchaseReceipt`，不接收 TBD 凭据或签名付款链接。购买页使用 `getPurchaseCatalog/listPurchases/createPurchase/refreshPurchase/openPurchasePayment/copyPurchaseCode` 六个类型化 IPC，均仅受信主窗口可调用，未激活时允许使用；其余产品功能保持付费门槛。
- 启动购买区只读取本机记录；查看商品、建单、打开付款页及查询均由用户明确操作，不轮询、不自动重试。用户先核对服务端含税价、台数和期限，再创建订单；只有点击付款按钮才打开系统浏览器。
- 首次响应丢失时用本机原记录重新 POST 同一请求，已知订单则直接读取领取接口。存在待核对购买时禁止再建一单；仅收到服务端明确未建单的报价、数量或收款未开放拒绝，或查询确认原单 closed/expired（渠道确认未收款），才允许重新下单。5xx、超时和未知错误不能证明未建单。
- 付款链接必须是服务端经 `X-Tblink-Payment-Environment` 下发环境对应的支付宝固定 HTTPS 网关，核对方法、重复参数、通知地址、原单号和金额；拒绝自定义回跳地址、其他域名或协议。重新取链接不得改变已记录商品与截止时间。打开浏览器 10 秒内未确认则明确报错，保留原单，不自动重开。
- 领取不自动激活。企业购买人可逐枚选择或复制激活码，选择后聚焦本机激活栏，再由用户点击激活；运行中禁止填入和替换授权。复制只接受本机购买编号与授权 ID，主进程从已保存的已交付订单取码并写入系统剪贴板，不开放任意剪贴板读取。已撤销席位不能选择，刷新后由服务端结果更新。界面保留上次查询结果，离线缓存不被当作本次服务器验证成功。
- 本机最多保存 100 笔记录，不自动删除历史或未知订单。当前没有跨机自助导入、凭据备份导出或用户自主关单（关单只在付款期限过后由服务端查单确认）；重装、凭据过期以及长期未知付款状态需要运营核实。不能为恢复界面可用而删除原记录或直接新建付款单。客户购买入口尚不包含微信、退款或自动开票。

验证分层：主进程适配器与真实本地授权服务验证响应丢失后同单恢复、先保存后请求、并发拒绝、验签通知发码、领取和异常链接；浏览器测试使用类型化 IPC 桩验证界面，未真实打开支付宝或扣款。macOS 已通过 TypeScript 与 Electron Vite 打包；完整 `pnpm build` 被 Windows 原生 OBS 插件构建要求阻止，不能据此声称 Windows 安装包、safeStorage 实机或 preload 运行已验收。

2026-09-28 本地验证记录：授权服务五个测试文件与桌面购买、安全存储、授权服务/访问门槛四个文件，合计 85 项分批通过；授权页九个 Playwright 用例分批通过，修正测试定位后重验企业多机购买、复制和选择激活码。桌面四组 tsconfig、授权服务类型检查、变更 TS/TSX 的 ESLint、服务端 bundle 均通过。浏览器初次在沙箱下因 macOS MachPort 权限未能启动，随后在隔离临时浏览器中完成测试，未读取真实商户会话。安全存储并发覆盖问题先复现失败，再修复验证。

## 签名许可

JWS Compact Serialization，三段 Base64URL，header 为 `{alg:"EdDSA",typ:"JWT",kid:"发行密钥标识"}`。payload 包含 `version:1`、`product`、`licenseId`、`customer`、`machineCode`、`kind`、`issuedAt`、`useUntil`、`updatesUntil`，在线许可另有 `online:{customerType,leaseUntil}`。

客户端只信任编译时公钥表和固定产品/机器，校验结构、算法、keyId、签名和时间。签名正文可读取，不是加密容器。不得把付款密钥或额外个人资料写入许可。签名租约为最多 7 天且不超过订阅到期；当前客户端每次启动仍须通过 `/v1/activate` 联网验证，不以未到期缓存免检。启动失败不自动重试，手动验证成功后放行。固定购买的 updatesUntil 不会被刷新延长。

`updatesUntil` 当前仅保存和展示，**尚未限制新版安装/启动资格**。在版本发布日期与已购升级权校验实现前，不得承诺已实现“升级期过后不能使用新版本”。下载公开安装包也不代表可免费使用：产品入口仍需有效授权。

桌面 IPC `getLicenseStatus / activateLicenseCode / refreshOnlineLicense / importLicense / exportLicenseRequest / requireOutputLicense` 仅通过受信窗口使用。工程文件不存激活码、私钥或支付身份。运行期间禁止替换授权；已获授权开始的会话允许完成，停止后的新会话重验。

## 错误与恢复

应用返回 `{code,message,requestId}`；代理 404/502、网络断开等可能不是 JSON，客户端应在边界明确报错。日志可记请求 ID 与错误码，禁止记录激活请求正文、签名许可、Authorization 和含客户信息的完整响应。

| HTTP | 常见 code | 处理 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST`, `INVALID_JSON`, `INVALID_TERM` | 修正字段/JSON，不自动重试 |
| 401 | `UNAUTHORIZED` | 管理员认证失败 |
| 403 | `INVALID_CODE`, `REVOKED`, `EXPIRED` | 不授权，联系运营核查 |
| 404 | `NOT_FOUND`, `ORDER_NOT_FOUND`, `LICENSE_NOT_FOUND` | 检查路由/编号；无此记录 |
| 409 | `ORDER_CONFLICT`, `PAYMENT_CONFLICT`, `PAYMENT_REUSED`, `AMOUNT_MISMATCH`, `ORDER_EXPIRED` | 订单或支付冲突，人工核实 |
| 409 | `ORDER_ALREADY_FULFILLED`, `PAYMENT_LINK_EXPIRED`, `PAYMENT_IDENTITY_MISMATCH`, `PAYMENT_CHANNEL_MISMATCH` | 不再生成付款链接；先核对原订单和渠道交易，不改价或切换商户重试 |
| 409 | `MACHINE_BOUND`, `LEASE_OUTSTANDING` | 已绑定别机或旧租约尚未结束 |
| 413 / 415 / 429 | `BODY_TOO_LARGE` / `CONTENT_TYPE` / `RATE_LIMITED` | 调整请求或稍后由操作员重试 |
| 500 | `INTERNAL_ERROR` | 提供请求 ID 排查；不删除现有许可 |
| 503 | `PAYMENTS_UNAVAILABLE` | 收款入口未启用，不生成付款链接 |

## 支付宝通知自动发码（代码与商户配置已启用，实付待验收）

`POST /v1/payments/alipay/notify` 接受 `application/x-www-form-urlencoded`（可带 UTF-8 charset），同样限制 16KiB。运营先创建服务端订单；现有已部署回调接受订单 UUID。本地下单实现按渠道字符限制使用 `TB_` 加去掉连字符的 UUID 作为 `out_trade_no`，新版回调在验签后映射回原订单 UUID，也保留既有 UUID 通知契约。不能使用人类可读 `reference` 替代，生成新格式付款入口前须同时部署新版回调。

- 启用条件：服务端完整配置 `ALIPAY_APP_ID`、`ALIPAY_SELLER_ID`、`ALIPAY_PUBLIC_KEY_FILE`。缺项使服务启动失败；全部省略时路由 404。公钥文件是从官方平台核对取得的支付宝验签公钥，不能误用本应用公钥；当前实现采用固定 RSA 公钥，不包含证书自动轮换。
- 只接受 RSA2、UTF-8、`trade_status_sync`；表单只解码一次，拒绝重复字段。验签包含未知扩展字段，排除 `sign` 与 `sign_type`，不能只签自己挑选的业务字段。
- 验签后比对 app_id/seller_id，核对订单 UUID、已付款状态 `TRADE_SUCCESS` 或 `TRADE_FINISHED`、整数分金额；非 CNY 拒绝。含非零退款、未支付或交易关闭的通知不发码，2026-10-14 起落 `payment_events` 并应答 `success`，见上文同日一节。
- 验签、核款、数据库事务和发码全部完成后才返回 200 纯文本 `success`。先独立提交核对后的收款事实，再在另一个事务提交订单变更、激活码与交付审计；通道流水保存为 `alipay:<trade_no>` 并受唯一约束。重复或迟到的同笔成功通知只读取原码，不再生成。
- 错误签名 401；错商户/应用、金额、交易状态或流水冲突 409；未知订单 404；其他结构错误 400。失败响应为错误 JSON，绝不返回 `success`。支付宝的渠道重发不等于客户端自动重试；重复通知由幂等处理保护。
- 审计使用 `order.alipay-payment-confirmed` 区分人工核款。通知原始表单、买方信息、签名及激活码不进入日志；拒收通知只输出带错误码的结构化日志。通知、领取、购买与其余请求的限流相互隔离；生产使用可信本机代理覆盖的客户地址计数，正式上线前仍需按容量验收。

通知阶段最初仅打通“有效支付通知 → 事务发码”。截至 2026-09-28，付款链接、主动查单、商品计价、自助下单及原机器订阅续费服务已部署至 `4c064d5`；桌面购买／领码／续费 UI 已本地实现与验证，尚未发布 Windows 安装包。公司支付宝、电脑网站支付和应用签名配置已完成，服务器只读查单响应验签通过；公网空通知返回 400，伪造签名返回 401。销售仍关闭，经营材料补件、真实交易交付、退款对账及发票 API 仍待完成，没有真实扣款或开票验收。

实现参考：[支付宝网站支付通知说明](https://opendocs.alipay.com/open/270/105902)、[官方 Node SDK 通知验签说明](https://github.com/alipay/alipay-sdk-nodejs-all#通知验签)。本实现只覆盖网站支付标准表单通知，不作为所有支付宝业务通知的通用解析器。

## 既有订单的支付宝付款入口（代码与收款配置已启用）

运营先通过受保护接口创建已确认金额与授权期限的团播订单，再请求 `POST /admin/orders/<UUID>/payment-link`，正文仅 `{}`。身份仍使用管理员 Bearer；客户领取凭据、公开订单编号和请求中的金额不能代替运营权限。此步骤生成电脑网站支付链接，不扣款、不交付，也不自动发送给任何客户。

- 配置独立开关 `ALIPAY_CHECKOUT_ENABLED=true` 和 `ALIPAY_PRIVATE_KEY_FILE`，同时必须完整配置通知验签的三项身份/公钥；默认关闭。私钥只在服务器受限文件中，至少 2048 位 RSA。应用私钥和支付宝验签公钥不同，不能互换。
- 金额、台数和期限只从已有订单读取；请求包含金额、回跳地址或其他字段时拒绝。签名请求发送到 `PAYMENT_ENVIRONMENT` 对应的固定网关（生产为 `https://openapi.alipay.com/gateway.do`），通知为 `PAYMENT_NOTIFY_ORIGIN` 下本服务路径；尚无客户完成页，不配置虚假的 `return_url`。
- `alipay_payment_links` 保存订单、APPID、seller_id 和首次付款截止时间；截止时间最多为首次生成后 15 分钟，且不能超过原订单使用/升级期限。重复获取及服务重启不延长截止时间；剩余不足一分钟时返回 409 `PAYMENT_LINK_EXPIRED`，需先查清原订单付款情况，不能直接再发另一单诱导重复支付。
- OpenAPI 请求签名包含 `sign_type`，异步通知验签不包含它。时间采用 UTC+8，金额为整数分转换的两位小数，软件按虚拟商品发送；不传个人信息、激活码或领取凭据。
- 已交付订单拒绝再次生成链接。已生成链接的订单不能改为人工核款；通知必须与该订单记录的应用和商户一致。付款窗口结束不直接把订单当作未支付关闭，需查单确认后才关单；关单后仍收到已验签成功通知时保留收款并按原规则交付。
- 测试覆盖独立 RSA 验签、参数篡改、固定网关、重复/过期/重启、商户切换、管理员权限，以及生成链接 → 新格式订单号通知 → 原订单发码。全部使用隔离数据库和临时密钥，无真实渠道请求。

本步骤供运营已确认订单使用，客户自助商品计价与桌面领取见上节。历史 `8b428e2` 部署时，正式价格与公开下单尚未落实，内部接口返回 503 `PAYMENTS_UNAVAILABLE`；这不是当前完整部署状态。最新源版本见 [部署记录](COMMERCIAL_DEPLOYMENT.md)，2026-09-29 定价见 [首发销售方案](COMMERCIAL_ONBOARDING.md#首发销售方案已按授权开售)。当前生产新售已开启，真实交易及 Windows 实机验收仍未完成。

实现依据：[支付宝官方请求签名实现](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/src/util.ts)、[官方电脑网站支付参数模型](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePagePayModel.java)。

## 主动查单补交付（代码与配置已部署，真实收款补交付待验收）

当原订单的通知丢失或延迟时，运营通过 `POST /admin/orders/<UUID>/reconcile`，正文 `{}`，查询 `alipay.trade.query`。接口与付款入口共用开关和密钥；只有本服务已生成付款入口、且绑定当前应用/商户的订单才会请求渠道。付款链接过期仍可查询，不能通过重建订单掩盖未知付款状态。公网与客户领取凭据不能访问此接口。

- 所配环境的固定网关、RSA2 请求签名、8 秒总网络时限、最多 64KiB 响应，不跟随重定向、不自动重试。网络、HTTP、签名、格式或渠道错误均返回失败；已验签的 `ACQ.TRADE_NOT_EXIST` 仅在付款期限过后使订单转 expired。错误不包含支付宝响应正文或买家信息。
- 公钥模式接收官方的 `alipay_trade_query_response` 加 `sign` 信封，对原始 JSON 对象字符串验签后解析，保留空格、转义及字段顺序。未签名错误、未知信封或证书模式扩展默认拒绝，需根据实际签约配置另行接入，不能降级跳过验签。
- 核对查询订单号、人民币金额，以及返回中存在的身份字段；查询响应并不保证返回 APPID/seller_id，所以身份同时依赖本地持久化绑定、签名请求和固定网关。发现非零退款字段或附加收款状态时返回需核对错误。
- `TRADE_SUCCESS`/`TRADE_FINISHED` 通过已有发码事务处理。金额、流水唯一性、绑定身份、授权期限均重复校验；查询和通知并发、重复查单不会产生第二批激活码，也不会恢复已撤销的授权。查询状态与发码审计在同一事务内提交。
- `WAIT_BUYER_PAY`/`TRADE_CLOSED` 不交付；付款期限内只记录查询事实，期限过后按上文关单条件转 closed（WAIT_BUYER_PAY 先调用 `alipay.trade.close`）。已交付订单出现非成功状态时响应 `needsReview: true`；不能从 CLOSED 推断具体退款金额或应撤销的企业席位。
- **该查询不是退款对账**：标准交易查询不提供完整部分退款历史。退款由控制台原路退款、退款通知与运营处理负责，见上文 2026-10-14 退款规则。

本地隔离测试覆盖签名与报文篡改、订单串换、身份/金额/币种、网络超时、待付/关闭、并发补发、通知重复及撤销后再次查单。未发送真实支付渠道请求。

实现依据：[支付宝官方查询参数](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradeQueryModel.java)、[查询响应字段](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayTradeQueryResponse.java)、[官方 Node SDK 原文验签实现](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/src/alipay.ts)。

## 其余支付自动化接口草案——尚未实现，不能调用

不增加用户账号。购买凭据、支付订单、发票信息与机器授权分开：付款人可以替操作电脑购买，企业一笔订单可以发多码。

| 预留方法与路径 | 计划行为 |
| --- | --- |
| POST `/v1/payments/wechat/notify` | 微信官方通知验签、解密、商户/币种/金额/订单/状态核对后交付 |
| POST `/v1/orders/:id/invoice-requests` | 查询凭据授权后提交个人/企业开票资料；仅创建申请，不假装开票成功 |
| POST `/admin/orders/:id/refunds` | 运营确认规则后申请原路退款，跟踪渠道结果、吊销与红冲状态（2026-10-14 已在控制台以 `alipay-refund` 实现，此运维接口仍未实现） |

具体字段、错误码与商户签约产品确定后冻结版本。支付通知必须使用官方要求的原始报文、证书/公钥校验与成功响应格式，不能统一套本服务 JSON 包装；微信和支付宝的成功确认格式不同。幂等处理通知及主动查单结果：先持久化可信支付事实、原子变更状态并创建授权，再用 outbox 交付，失败可补发但不重复发码。客户端跳转、截图、前端 paid 标志均不是收款事实。

无账号并不意味着无订单恢复机制。收银台需展示订单编号和收货凭据，按必要范围收集交付邮箱/联系方式；找回要核对购买证明，不以机器码或公开订单号直接发码。支付交易库应有独立渠道流水唯一约束、分币种金额、退款累计金额及渠道对账状态，不能将当前简单人工 fulfill 包装成已经全自动。

自动化范围：支付确认→发码→交付→对账异常队列→开票申请。企业合同、资格审核、证书续期、争议退款和税务申报仍有人工责任点。公司材料与财税工作流见 [PAYMENTS_AND_TAX.md](PAYMENTS_AND_TAX.md)。

## 网页购买调用方

### 客户主动查单补交付

`POST /v1/orders/:id/reconcile` 使用原领取凭据 `Authorization: Bearer TBD-...`，正文仅 `{}`。网页“查询付款并领取激活码”和桌面购买记录的显式刷新使用此接口；原 `GET /v1/orders/:id` 继续只读取本地交付状态。

- 先检查领取凭据，再读取请求；请求读取后与渠道等待结束后重新检查有效性，过期、撤销或错单凭据不能领取。公开订单号、管理员令牌不能替代领取凭据。
- 已交付、已关闭或已过期订单直接返回现有结果，不再次查询渠道。待付订单核对持久化商户/应用绑定，然后仅调用一次 `alipay.trade.query`；既有 RSA2 验签、订单/金额/状态核对与事务交付保持不变。接口只返回 `purchaseDeliverySchema` 字段，不返回渠道买家、流水、内部客户或机器标识。
- 单个客户地址每分钟最多十次查单请求；单个订单只允许一个在途渠道查询，查询结束后十秒内拒绝再次查询。该限流状态限当前单进程，重启会清空；未来多实例须共享限流，数据库交付幂等不依赖此限流。
- 渠道超时、无确认交易、异常签名、退款信息或异常收款状态明确报错，保留原单，不自动重试或重新下单。已关闭收款配置时未交付订单查单返回 503；已经交付的订单仍可凭原凭据领取。该接口不执行退款，也不把已交付查询当作退款对账。
- 支付宝官方说明在未收到异步通知时可主动查单：[交易查询接口](https://developer.alibaba.com/docs/doc.htm?articleId=757&docType=4&treeId=180)。本地使用测试 RSA 密钥与隔离 HTTP 验证补交付，不代表真实商户付款验收完成。

`apps/licensing-server/web` 使用 `/v1/catalog`、`/v1/orders`、`/v1/orders/:id` 和客户主动查单接口。网页与 API 使用同源 Nginx 代理，续费仍由桌面发起；订单令牌保存在标签会话及用户导出的凭据文件中。官网已开放月付与年付购买；公开下单实测返回待付款订单及公司支付宝付款链接，未实际付款、未发码。详见 [购买网页](PURCHASE_WEBSITE.md)。


## 收款记录与交付异常

`payment_receipts` 是新增表，不重写既有订单或授权。每个订单只有一条收款事实，流水全表唯一，并与旧订单流水共同查重。仅通过签名、订单、商户和金额核对的支付宝通知／查单，或受保护人工核款入口可以写入；客户端不能标记已收款。保留原流水、金额、来源、应用／商户、首次收款确认时间和最近交付错误码，不保存原始通知或买方资料。

收款与交付使用两个事务。发码失败或进程在两者之间退出时，原收款事实仍存在；异常列表包括错误码为空但尚未交付的中间状态。失败写入 `order.delivery-failed` 审计和脱敏错误码；成功补发清除最近错误，移出异常列表。重复同流水不重复发码或延长期限。

客户 GET 领取或 POST 主动查询可得到 `paymentConfirmed:true` 的待处理 DTO。官网隐藏付款链接与再次创建入口，桌面记录不再允许付款。POST 主动查询发现已保存收款时，按原收款记录尝试补交付，无需再次请求支付宝；这一分支在停止新售后仍可使用。交付失败时返回明确待处理状态并记录脱敏日志，不伪报交付成功；凭据、签名或金额错误且没有有效收款事实时仍返回错误。通知和运营补发失败则继续返回非成功状态。

运营异常列表每页最多 100 条，返回 `cursor,orderId,paymentReference,amountFen,source,receivedAt,lastError`，不返回客户名称、激活码、机器码或领取凭据。若 `nextCursor` 非空，下一页通过 `after` 继续；一次清单结束后下次从 0 开始，避免遗漏仍待处理的旧单。列表是交付异常台账，不代替支付宝账单或税务收入核算。

补发请求必须带 1–500 字符原因，只读服务器中原流水和金额，不允许客户端指定新流水。不存在收款记录时返回 `PAYMENT_NOT_RECEIVED`；已交付重复调用返回原状态；被撤销的续费授权或已结束的人工固定期限仍拒绝交付。退款需另行核对和办理，补发不发起退款或扣款。

服务器运维命令为 `apps/licensing-server/deploy/payment-exceptions.py`。默认从 `/etc/tblink-licensing/admin-token.txt` 在进程内部加载管理员令牌，仅请求固定回环地址，禁止系统代理和 HTTP 跳转，12 秒超时。以下在服务器安装该脚本后执行，不向公网开放 admin 路由：

```sh
sudo python3 /opt/tblink-licensing/payment-exceptions.py
sudo python3 /opt/tblink-licensing/payment-exceptions.py --after 100
sudo python3 /opt/tblink-licensing/payment-exceptions.py --retry-order <订单UUID> --reason '已确认交付故障修复，按原收款补发'
```

2026-09-29 增加 `--recover-batch` 自动恢复模式，配套 `tblink-delivery-recovery.service` / `.timer`。它只从上述受保护异常接口读取已核实的支付宝收款，至少等待 60 秒；仅对没有错误码或 `INTERNAL_ERROR` 的本地交付异常调用原补交付接口。每批最多 5 单，同一单最多 5 次，间隔按 60、120、240、480、960 秒递增；次数在请求前写入独立 SQLite 状态，重启或响应丢失不清零。续费撤销等业务错误、异常成功响应和耗尽次数均停止自动尝试，运营仍用原显式补发入口处理。

2026-10-19 提交 be319cf 起（服务器上的 `/opt/tblink-licensing/payment-exceptions.py` 须人工换装为该版本后生效，CI 不部署此脚本），同一批次在交付恢复之后读取 `/admin/orders/lapsed-payment-links`，对付款链接已过期的未付款订单逐单调用 `/admin/orders/:id/reconcile`：渠道返回交易不存在则转为已过期，仍待付款则关闭原交易并关单，已付款则照常交付。每批最多查 5 单，同一单最多 5 次，间隔 300、600、1200、2400、4800 秒；渠道仍无结论或返回业务错误时停止自动查单，留给运营在订单详情手动查单。交付恢复遇到网络错误时本批不查单。部署时该定时任务与服务一同停止，查单不会在数据库快照比对期间写库。

状态文件默认 `/var/lib/tblink-licensing/delivery-recovery.db`，权限 0600，仅保存订单 ID、尝试次数、下次时间、错误码与分页游标；拒绝把业务主库用作恢复状态库。进程文件锁避免重复运行，分页游标避免前一页故障订单阻塞后续订单。任务每次结束 60 秒后进入下一次调度，实际执行时间受 systemd 默认定时精度影响；授权服务停机时任务失败而不会擅自拉起它，日志只输出统计。

该模式是服务端对已确认收款的本地交付恢复，不自动创建订单、扣款、退款、请求支付宝重付或放宽授权规则。没有收到可信付款事实的订单不在任务范围内，仍需渠道通知或现有主动查单；退款、自动开票与跨机找回并未由此实现。正式部署结果以部署记录为准。

自动恢复停止后，运营先核对记录和原因，再使用显式补发命令；该手动命令不会自动重试，脚本也不会自动撤销授权或对客户发送消息。本地测试覆盖故障事务回滚、重启恢复、重复流水拒绝、补发幂等、撤销边界及 HTTP 权限，不能代替真实商户交易验收。生产状态见部署记录。

## 内部收款台账导出

`apps/licensing-server/deploy/export-payment-ledger.py` 在服务器以 SQLite `mode=ro`、`query_only` 和单个读事务导出一致快照，不加载管理员令牌或授权密钥，不调用支付渠道，也不新增公网接口。数据库锁等待最多 5 秒，查询和逐行导出设 30 秒限时。并发到账不会混入已开始读取的快照，下一次导出才能看到。

安装后执行（输出目录必须不存在，其父目录需已存在）：

```sh
sudo python3 /opt/tblink-licensing/export-payment-ledger.py \
  --from-date 2026-09-01 --before-date 2026-10-01 \
  --output-dir /var/lib/tblink-licensing/payment-ledger-2026-09
```

日期按上海时区计算，起日包含、止日不包含。筛选依据是服务本地首次确认收款的 `received_at`，不是支付宝交易时间、银行结算日期或收入／纳税时点；月末延迟通知可能落入次月，须在渠道对账时核对。仅导出已保存收款事实，包括已付款尚未交付的订单；未支付订单不计入，人工核款与支付宝核款分别汇总。

新建目录权限为 0700，文件为 0600；拒绝覆盖已有目录或符号链接。目录内含：

- `receipts.jsonl`：无损记录订单 UUID、支付流水、整数分金额、CNY、来源、确认时间与当前交付状态。对账程序使用这一份，保留长流水号。
- `receipts.csv`：带 UTF-8 BOM 的表格查看版；可能被解释为公式的文本及超过 15 位的纯数字标识加前导单引号，避免公式执行或长流水四舍五入，不改变 JSONL 原值。金额列仍为整数分。
- `summary.json`：最后生成的完成标记、范围、条数、分来源金额、交付状态数量与历史覆盖缺口。仅当该文件是有效 JSON 且 `complete=true` 时使用此包；异常时保留不完整文件供检查，改用新目录重导，不覆盖原输出。

不导出客户名称、机器码、激活码、领取凭据、商户密钥或错误详情。`fulfilled_orders_without_receipt_all_time` 如大于零，表示存在已交付但没有新收款事实表记录的历史订单；该数量跨全部时间，因为旧表没有足以可靠重建收款日期的字段，不能把它分摊到本次月份，也不能把导出误认为全量历史收入。

此包是内部核款依据，不是渠道账单。手续费、退款、银行结算及发票金额尚无对应数据源，不填零、不推算净额、不据此自动申报。下一步需与真实渠道账单和银行入账核对，并接入退款与开票记录。导出文件保留在服务器受限目录，不上传 GitHub 或官网。

## 2026-09-30 微信 Native 接口与兼容性

本节描述已实现代码，生产部署回执另见 `COMMERCIAL_DEPLOYMENT.md`。真实微信支付尚未验收，不得以隔离密钥测试代替商户开通或实际到账。

- `GET /v1/catalog`、`POST /v1/orders` 可显式发送 `X-Tblink-Payment-Channel: wechat`；省略仍为支付宝，既有请求和响应 JSON 形状不变。目录响应回送同名头，新官网要求微信目录返回 `wechat`，防止旧服务端忽略请求头后误认为微信已开通。只接受 `alipay | wechat`。
- 微信使用同一服务端价目、报价版本、领取凭据、机器授权与续费规则，订单以 `wechat_payment_links` 固定 AppID、商户号、到期时间及已验证的 `code_url`。同一领取凭据不能换渠道，管理员也不能为微信订单再建支付宝入口或改成人工核款。旧版 Windows 0.4.29 保持支付宝购买；微信新增入口在官网。
- 官网支付宝凭据仍为 `version: 1`；微信为 `version: 2, paymentChannel: wechat`。这使旧网站拒绝不认识的凭据，而不会将微信单误作支付宝单。微信 `paymentUrl` 仅允许 `weixin://wxpay/bizpayurl?pr=...`，由本地 Canvas 生成二维码，不调用二维码代生成服务，不直接作为网页跳转链接。
- Native 下单先持久化本地订单，再调用固定微信网关，复用去掉连字符的 32 位 UUID。创建失败返回的错误可附订单 `orderId`，官网保存它用于查单；不丢弃不确定订单，不自动重试、不自动换渠道。重复手动恢复复用已保存的二维码及原支付期限。
- `POST /v1/payments/wechat/notify` 接收 JSON，缺少微信配置时 404。用配置的微信支付公钥 ID 精确匹配请求头，校验原始字节 RSA-SHA256 签名、五分钟时间窗，拒绝签名探测流量；再用 APIv3 密钥解密 AES-256-GCM。只处理 `TRANSACTION.SUCCESS`、Native、人民币且商户、AppID、金额、订单一致的成功交易。发码成功返回 HTTP 200 `{"code":"SUCCESS","message":"成功"}`；失败不确认成功。
- 客户及管理员 `.../reconcile` 按数据库中的渠道查单，客户端不能指定另一渠道；请求签名覆盖方法、完整路径（含查询串）、时间戳、随机串和正文。响应必须先验签，非 `SUCCESS` 不交付，退款状态只记录审计和复核标记，不能推断退款金额或自动撤销席位。
- 请求固定为 `api.mch.weixin.qq.com`，禁止重定向，八秒超时，最多 64KiB 响应；商户报错或网络失败保留原订单。微信交易流水使用 `wechat:` 前缀，与支付宝分开。
- 已确认收款先落 `payment_receipts`，再交付；发码故障、重启、重复回调和重复补交付沿用既有幂等机制。恢复任务接受已验证的微信和支付宝收款，仍跳过人工收款，单笔最多五次。账簿导出分别汇总两渠道；渠道手续费、退款、结算、发票仍需实际账单核对。

依据：[Native 下单](https://pay.wechatpay.cn/doc/v3/merchant/4012791877)、[Native 支付通知](https://pay.wechatpay.cn/doc/v3/merchant/4012791882)、[公钥验签](https://pay.wechatpay.cn/doc/v3/merchant/4013053249)。
