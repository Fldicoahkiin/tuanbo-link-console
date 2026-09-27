# 商业接口与凭证契约

2026-09-28。本文区分已实现接口和后续设计。生产 origin 规划为 `https://api.tuanbo-link.jinhefilm.com`，服务已回环部署，公网 DNS/HTTPS 待完成；客户端配置该地址不代表公众已可用。实现依据：`apps/licensing-server/src/http.ts`、`service.ts`、`packages/schema/src/license.ts`。

## 已实现接口

服务本体成功时返回 200 JSON；请求对象经 Zod 校验。写接口必须 `Content-Type: application/json`。请求体最多 16KiB、请求头最多 8KiB、HTTP 请求超时 10 秒；当前限流每连接来源 IP 120 次/分钟，反向代理共享限额的限制见部署文档。响应 `Cache-Control: no-store`，带 `X-Request-Id`。不提供 CORS 购买页、会话 Cookie 或客户登录。

| 方法与路径 | 访问范围 | 请求 | 成功响应 |
| --- | --- | --- | --- |
| GET `/health` | 公网 | 无 | `{"status":"ok"}`，仅存活，不证明数据库、签名或支付可用 |
| POST `/v1/activate` | 公网 | `product, code, machineCode` | `{"license":"<Ed25519 JWS>"}` |
| POST `/admin/orders` | 回环/运维隧道 + Bearer | 订单对象，见下文 | `{"id":"<UUID>","state":"pending或fulfilled"}` |
| GET `/admin/orders/:id` | 同上 | UUID 路径 | 订单详情和 `licenses`，含完整激活码，仅运营可读 |
| POST `/admin/orders/:id/fulfill` | 同上 | `paymentReference, amountFen` | 与订单详情相同，人工核款后发码 |
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
- `amountFen` 是订单总金额，整数人民币分，1–100,000,000。人工 API 由运营确定价格，尚无公开商品目录或服务端计价接口。
- `kind` 为 `perpetual | subscription`；买断 `useUntil` 为 null，订阅为 UTC ISO 时间；`updatesUntil` 为 UTC ISO 时间。创建及交付拒绝已结束期限。
- 核款请求 `{"paymentReference":"渠道及真实流水的唯一编号","amountFen":200}`。管理员必须先查实际到账。重复同流水同金额返回已有授权；错误金额、重复占用其他订单的流水、同单改流水均拒绝，不重复发码。
- 详情返回 `{id,state,...订单字段,licenses:[{id,code,machineCode,revoked,leaseUntil}]}`；未绑定的 machineCode 与未签发的 leaseUntil 为 null。核款流水不在详情响应中，数据库及审计保留，不能把查询响应当财务对账单。
- 吊销可重复但每次记录审计；**迁移不是幂等发货接口**，新码生成后立即恢复未绑定状态，再次 migrate 会被拒绝。响应丢失时通过订单详情恢复新码，不再次生成。旧授权须先撤销并等待已签发租约到期加 5 分钟；旧码永久失效。

## 签名许可

JWS Compact Serialization，三段 Base64URL，header 为 `{alg:"EdDSA",typ:"JWT",kid:"发行密钥标识"}`。payload 包含 `version:1`、`product`、`licenseId`、`customer`、`machineCode`、`kind`、`issuedAt`、`useUntil`、`updatesUntil`，在线许可另有 `online:{customerType,leaseUntil}`。

客户端只信任编译时公钥表和固定产品/机器，校验结构、算法、keyId、签名和时间。签名正文可读取，不是加密容器。不得把付款密钥或额外个人资料写入许可。最长离线租约为 7 天且不超过订阅到期；固定购买的 updatesUntil 不会被刷新延长。

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
| 409 | `MACHINE_BOUND`, `LEASE_OUTSTANDING` | 已绑定别机或旧租约尚未结束 |
| 413 / 415 / 429 | `BODY_TOO_LARGE` / `CONTENT_TYPE` / `RATE_LIMITED` | 调整请求或稍后由操作员重试 |
| 500 | `INTERNAL_ERROR` | 提供请求 ID 排查；不删除现有许可 |

## 支付自动化接口草案——尚未实现，不能调用

不增加用户账号。购买凭据、支付订单、发票信息与机器授权分开：付款人可以替操作电脑购买，企业一笔订单可以发多码。

| 预留方法与路径 | 计划行为 |
| --- | --- |
| POST `/v1/orders` | `sku, quantity, channel`；服务端计算金额并创建渠道订单；返回二维码/支付链接、订单 ID、随机查询凭据 |
| GET `/v1/orders/:id` | 使用高熵查询凭据取订单状态；不能只凭可猜订单号查看客户或码 |
| POST `/v1/payments/wechat/notify` | 微信官方通知验签、解密、商户/币种/金额/订单/状态核对后交付 |
| POST `/v1/payments/alipay/notify` | 支付宝官方通知验签及 app/seller/金额/订单/状态核对后交付 |
| POST `/v1/orders/:id/invoice-requests` | 查询凭据授权后提交个人/企业开票资料；仅创建申请，不假装开票成功 |
| POST `/admin/orders/:id/refunds` | 运营确认规则后申请原路退款，跟踪渠道结果、吊销与红冲状态 |

具体字段、错误码与商户签约产品确定后冻结版本。支付通知必须使用官方要求的原始报文、证书/公钥校验与成功响应格式，不能统一套本服务 JSON 包装；微信和支付宝的成功确认格式不同。幂等处理通知及主动查单结果：先持久化可信支付事实、原子变更状态并创建授权，再用 outbox 交付，失败可补发但不重复发码。客户端跳转、截图、前端 paid 标志均不是收款事实。

无账号并不意味着无订单恢复机制。收银台需展示订单编号和收货凭据，按必要范围收集交付邮箱/联系方式；找回要核对购买证明，不以机器码或公开订单号直接发码。支付交易库应有独立渠道流水唯一约束、分币种金额、退款累计金额及渠道对账状态，不能将当前简单人工 fulfill 包装成已经全自动。

自动化范围：支付确认→发码→交付→对账异常队列→开票申请。企业合同、资格审核、证书续期、争议退款和税务申报仍有人工责任点。公司材料与财税工作流见 [PAYMENTS_AND_TAX.md](PAYMENTS_AND_TAX.md)。
