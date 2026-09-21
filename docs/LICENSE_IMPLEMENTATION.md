# 单主机授权实施记录

2026-09-21。销售规则：一台主机一份授权，第二台（包括备机）独立购买；买断、订阅和试用使用同一签名协议。参考总方案：COMMERCIALIZATION.md。

## 本轮已实现

- 设置 → 外观与更新 → 本机授权：显示机器码、当前状态、客户、使用期限及升级期限；导出申请、导入授权文件、刷新状态。运行中禁止更换许可。
- Windows MachineGuid 经产品域隔离 SHA-256 后作为本轮机器码，不向发行方导出原始标识。不是设备私钥方案；克隆 Windows、重装 Windows 的处理仍需完善。
- 主进程验证 Compact JWS / Ed25519；校验可信 keyId、签名、产品、主机、授权类型和期限。renderer 不拥有签名能力。
- 买断使用期限为空，升级服务到期不影响本轮有效性判断；订阅和试用按 useUntil 到期。无效、跨机器和已到期许可不覆盖现有有效文件。原子保存，不写进工程。
- 独立发行方工具 scripts/license-issuer.mjs：生成 Ed25519 密钥，针对机器码签发许可；拒绝覆盖已有文件。没有将生产私钥放入仓库或客户端。

## 尚未启用，不可当作商业发布版

enforcement 固定为 preview；目前只验签和显示资格，没有正式输出权限拦截，也没有限制现有客户。客户端公钥配置 license-public-keys.json 为空，明确显示“尚未启用”。测试公私钥在临时测试目录生成，未加入客户端信任列表。

尚未完成：生产签发密钥配置、付费输出边界拦截及运行会话锁存、试用防重复领取、时钟回拨检测、在线撤销/迁移、离线订阅宽限、商业更新资格、支付/订单/公司门户及商户部署。许可期限不是已实现续费服务；签发工具不代替支付验收或订单台账。

本轮 JWS 仅检查未来签发时间，没有实现可信时间高水位；不宣称防回拨或防破解。MachineGuid 不能阻止克隆系统；重装后可能需重新签发。永久离线许可也不能即时撤销。

## 发行方离线操作

1. 客户在本机授权页导出申请 JSON；其中只有产品、协议版本和机器码。
2. 发行方保管私钥，并将对应公钥 JSON 内容配置到 src/main/link/license-public-keys.json 后构建客户端。只能分发公钥，私钥应放仓库之外并做受控备份。更换公钥需保留历史公钥以兼容已售许可。
3. 核对订单与销售规则后签发：

```powershell
node scripts/license-issuer.mjs keygen --kid release-1 --private D:/LicenseVault/signing.pem --public D:/LicenseVault/public.json
node scripts/license-issuer.mjs issue --kid release-1 --private D:/LicenseVault/signing.pem --public D:/LicenseVault/public.json --request D:/LicenseVault/request.json --customer "客户公司" --kind perpetual --updates-until 2027-09-21T00:00:00Z --out D:/LicenseVault/customer.tbllicense
```

上面为操作示例，未执行生产签发。路径父目录需预先存在，日期按真实订单填写；订阅和试用还需 --use-until ISO 日期。所有参数中的时间均明确为 UTC，桌面按本地时间展示。

4. 客户导入 .tbllicense；不同机器会明确拒绝。记录订单号、licenseId、机器码、授权类型和期限。离线手工发货不自动收款、不自动退款。

## 验证

- 签名篡改、错误主机、未知公钥、未来签发、订阅/试用到期、买断升级到期、错误导入不覆盖已通过单测。
- 实际执行发行方 CLI 生成测试密钥及许可，客户端验证通过，重复文件拒绝覆盖。
- Electron 新进程测试本机机器码读取、申请导出、错误文件反馈与刷新状态；截图在 apps/desktop/test-results-license。
- 修改 preload 后本轮运行的是重新构建并新启动的 Electron，不复用旧 preload。未生成安装包，未对真实客户签发或收款。
