# 0.4.29 发行与开售记录

2026-09-29 用户明确授权正式发行并开放收款，随后安排真实客户测试。本次允许发布未做 Authenticode 签名的安装包；这不代表签名、Windows 安装、真实付款、退款或设备联调已经验收。

## 构建来源

- 发行标签：`v0.4.29`；产品提交 `3dcf91cafc56dcebf368160da2961648c330fdbe`。已完成正式发行与开售，实际证据见文末。
- 前一标签 `v0.4.28` 对应 `dc12f1b61d398b0408c7a6dbba1cc6bfa800130e`，保留失败记录，没有移动或重新使用该标签。
- [0.4.28 构建](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36453607620) 完成原生编译后，在 Node.js 25.8.2 的测试模块导入时因 `localStorage.getItem is not a function` 失败；148 个测试文件、1,036 项测试通过，1 个测试文件未能导入，40 项测试跳过。没有生成或发布安装包。
- 在相同 Node.js 25.8.2 本地复现该错误。修复是让 MA2 模式测试在模块导入前建立模拟存储，避免依赖 Node 的 Web Storage；客户端行为不变。随后三项测试、定向 ESLint 和测试 TypeScript 配置检查通过。
- 前一标签推送未观察到自动 run，因此使用显式标签和完整提交手动触发。新构建同样核对实际 SHA，不把标签存在视为构建完成。
- [0.4.29 第一轮构建](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36457266164) 已通过完整 `pnpm verify:release`，包括 149 个测试文件、1,039 项测试通过（2 个文件、40 项测试跳过），Windows 打包及 manifest 校验；归档阶段因 GitHub Actions artifact 存储配额已满失败，未取得可下载产物，未发布正式版。
- 工作流增加显式 `archive_to_draft` 选项：仍检出指定完整源码 SHA、验证版本标签与 manifest 一致，但直接从 Windows runner 上传四个分发文件到草稿 Release，不经过 Actions artifact 存储。该选项默认关闭，不自动公开或覆盖旧发行资产；GitHub 临时令牌仅由工作流使用。
- [归档修复后的构建](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36461288338) 使用工作流提交 `6c5a5dfff8525cf9f8ee50d977cd9f8b8e1a506a`，实际产品源码仍固定为 `3dcf91cafc56dcebf368160da2961648c330fdbe` / `v0.4.29`。GitHub run 的 headSha 此时标识工作流来源，产品来源必须从实际 checkout 和 manifest 核对。通过后下载草稿资产再核验，最后才转为正式发行。
- 之前的 `3965dd0` 候选构建因其版本仍为已发行的 0.4.27 而主动取消，不是校验通过或失败。

## 发布与收款操作

1. 从上述成功 run 创建的草稿 Release 下载安装器、blockmap、`latest.yml` 和 `release-manifest.json`。核对 manifest 的 Git SHA、平台、版本、工作区状态、检查结果及三个分发文件的长度和 SHA-256；本机使用 YAML 解析器核对 `latest.yml` 的版本、文件名、长度及安装器 SHA-512。
2. 上传上述文件到服务器非公开暂存目录。执行 `publish-update.py <目录> <已核验的manifest摘要> <Git SHA> 0.4.29`。脚本拒绝覆盖同名安装包；文件完整写入并校验后先发布安装器和 blockmap，最后原子替换清单。操作记录和旧清单保存在私有备份目录，不修改 Nginx 或授权服务。
3. 核对公网清单、安装包 HEAD、Range 响应与缓存头。首次更新出口此前没有清单，回退时将新清单移入私有备份可停止后续更新；已安装客户端不能由此降级。
4. 商品目录使用 `apps/licensing-server/deploy/catalog.json`：800 元 / 30 天 / 台，8,000 元 / 365 天 / 台；仅订阅、单份一台，主动续费。价格和期限均由服务端决定。
5. 上传经审查的目录，执行 `activate-catalog.py <目录文件> <目录SHA-256> <当前service.env的SHA-256>`。脚本校验公司支付宝身份及密钥文件存在，备份环境配置，保留原注释与未知配置，只启用支付宝收款并添加目录路径；重启授权服务后比对商品接口，失败则还原销售关闭状态。
6. 检查官网和 API 的实际商品与支付入口。开启接口不等于交易完成；真实扣款、通知发码、绑定、续费、退款和开票须按实际订单单独记录，不能用模拟回调代替。

运行部署脚本需服务器管理员权限。摘要必须来自本次已核验文件；示例不是授予未来任意部署的授权。脚本测试：`PYTHONDONTWRITEBYTECODE=1 python3 -W error::ResourceWarning -m unittest discover -s apps/licensing-server/deploy -p 'test_*.py'`。

## 尚未验收

- Windows 用户现场 SmartScreen 提示、首次真实付费激活、到期和换机，以及两个版本之间的安装更新。Windows CI 的正式安装版无凭证拦截、覆盖安装、正常退出与卸载已通过，见[授权与更新验收](LICENSE_UPDATE_ACCEPTANCE.md)。
- 支付宝公司产品额度、800 元 / 8,000 元实际付款及自动发码、原单恢复与续费。
- 自动开票、退款对账、微信支付和现场 OBS / MIDI / MA2 联调。
- GitHub 到腾讯云的自动同步仍未配置，本次使用受控上传。

## 2026-09-29 实际发布与开售结果

- 产品来源：`3dcf91cafc56dcebf368160da2961648c330fdbe`，标签 `v0.4.29`；[正式 Release](https://github.com/JinHe9527/tuanbo-link-console/releases/tag/v0.4.29)。私有仓库无需公开，客户从公司更新域名下载安装包。
- [Windows 构建](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36461288338) 完成校验与直接草稿归档；下载后逐项验证 manifest、三个分发文件 SHA-256、清单版本／大小／SHA-512，再发布正式 Release。
- Manifest SHA-256：`ad37f80fde39ee760a2671214d799d58ec227ce768989983e6c57b2adb5811a9`。安装器保持未签名，未伪造 Authenticode 状态。
- 更新发布备份：`/var/lib/tblink-licensing/backups/20260928T181937Z-e217bc22-update-0.4.29`；公网清单与 blockmap 摘要一致，安装包 HEAD 大小一致、Range 返回 206 且片段一致。
- 官网来源 `3dcf91cafc56dcebf368160da2961648c330fdbe`，增加 Windows 0.4.29 下载入口；商品与金额从生产目录读取。
- 开售备份：`/var/lib/tblink-licensing/backups/20260928T182029Z-open-sales-bc3ae9fd`；目录 SHA-256：`07fd7553d5a5f11184eafb9f92282f10f06f026a01e1c879980d6adb02d14c6d`；启用后环境文件 SHA-256：`11a2c78ad6cd9ea54cfe1ed4c3bc47d047dcbc30f9cc146449435bf08f3437a5`。仅改变团播收款和目录设置。
- 公网未付款验证订单：`0f0a3434-f6ae-4925-99c8-99c7ad32468a`，800 元；同凭据重复创建返回同一订单，领取状态 pending、激活码数量 0；公司 app、支付方法及回调地址匹配，没有实际扣款。该凭据仅保留在本机受限文件，未入库文档。
- 自动开票、微信、真实支付／回调／激活／续费和两版本重启更新仍未验收。后续应按真实平台流水核对，不用伪造回调或手动改已付状态替代。正式安装器的后续 CI 验收结果见[专项记录](LICENSE_UPDATE_ACCEPTANCE.md)。
- 最终服务器复核：授权 bundle 与 Nginx 摘要保持不变，授权服务、Nginx、金河分镜、无忧排班均 active。官网 HTML／JS／CSS 的公网摘要与发布包一致，授权 health 为 200；官网与 API 的管理员路径及配置文件探测均为 404。
- 官网浏览器已验证 0.4.29 下载链接、月付 800 元／30 天与年付 8,000 元／365 天选项及对应合计；未勾选购买协议或执行浏览器付款。官网备份为 `/var/lib/tblink-licensing/backups/20260928T182005Z-website`。
- 本地上线脚本回归 38 项通过；最终 Windows 构建为 149 个测试文件、1,039 项通过，40 项跳过。Actionlint 与工作流 YAML 检查通过。

## 2026-09-29 授权与更新专项补验

[Windows 验收 36469197729](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36469197729) 整体成功：无凭证／损坏凭证的真实 IPC 拦截、正式 0.4.29 安装与覆盖安装、正常关闭和零残留卸载，以及真实更新器从公司 HTTPS 源完整下载并核对 SHA512／SHA256、拒绝损坏包均通过。测试没有修改发行产物、付款或签发授权。真实付费激活和两版本自动更新重启仍未验收；完整证据和失败脚本修复记录见[授权与更新验收](LICENSE_UPDATE_ACCEPTANCE.md)。
