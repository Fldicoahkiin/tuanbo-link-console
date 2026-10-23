# 团播服务与官网自动发布

## 当前状态（2026-09-30）

服务器接收器和专用 `tblink-deploy` 身份已安装，实际 SSH 探测确认公钥认证可用、任意 shell 命令不执行、非法包在部署前被拒绝。现有团播支付配置与业务数据未修改。初始化记录位于 `/var/lib/tblink-licensing/backups/ci-bootstrap-20260930T023247Z/receipt.json`。

GitHub 仓库为 `JinHe9527/tuanbo-link-console`，生产分支为 `master`。2026-09-30 用户明确授权向 GitHub 保存长期生产部署私钥并启用持续自动部署；两个 Actions Secrets 已写入，`TBLINK_AUTO_DEPLOY=true` 已启用。专用私钥没有进入 Git 文件，没有打印到聊天或日志。启用配置与实际部署验收分别记录如下。

这条链路发布授权服务和官网，不自动发布 Windows Release、不改变商品价格、不启用微信、不创建支付订单或授权。Windows 安装包及 `latest.yml` 的发布仍走已有独立流程。

实现提交 `3d27779a0998fd3788add2d33d4eed2a0f51210e` 的 [CI 36661008165](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36661008165) 已全部通过：类型检查、支付／授权测试、服务与官网构建、浏览器检查、Python 回归。新增接收器 7 项回归与既有套件合计 62 项在本地通过；CI 同一套件通过。`Confirm production branch is still current` 与 `Deploy verified licensing service and website` 均为 `skipped`，这次不是自动部署成功证明。

启用前的独立服务器复核：生产来源仍为 `fb6e286c4a9c700b9693d566389598ace3ad446d`；API bundle、Nginx 和支付环境摘要保持此前部署值；数据库检查 `ok`，订单 1、收款 0、授权 0。SSH、团播、恢复定时器、Nginx、金河分镜和无忧排班均 active。当时自动发布任务目录为空、尚无 `last-success.json`；该初始化记录不代表后续启用结果。

## 首次启用与修复记录

- [36667188691](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36667188691)：验证与构建通过，SSH 解析 Secret 中的私钥时报 `error in libcrypto`，未登录服务器。用同一密钥本地复现缺少末尾换行失败、补齐后成功；`3c32a8b` 修正文件末尾换行，回归使用临时生成的无权限测试密钥让实际 `ssh-keygen` 验证解析。
- [36667746831](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36667746831)：SSH 认证成功，接收阶段的 60 秒 alarm 超时，未创建部署任务。`d52dcc6` 将上传限时设为 300 秒，分块计数并在超时中报告已接收字节数；16 MiB 总量及固定文件约束不变。
- [36668497809](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36668497809)：1,228,800 字节实际上传用时 55.4 秒，随后服务发布成功、官网探针失败。独立读取确认新静态目录因继承 umask 077 成为 0700，Nginx 无法读取；官网自动恢复旧链接，服务 bundle、支付环境和代理摘要未改变，未记作完整发布成功。
- `7083aa8`：只给公开静态目录显式设置 0755，公开文件保持 0644；私有备份仍为 0700。探针增加 HTTP 失败识别。已在原实现上复现两种旧站状态的权限断言失败，修复后部署套件 64 项通过。

受限接收器修复备份 `/var/lib/tblink-licensing/backups/ci-receiver-20260930T042014Z`，现文件 SHA256 `c26353c444155c7ab8f426f6cda52ea39103dbeafa1e73fc2974e554d9a0d118`；官网发布工具修复备份 `/var/lib/tblink-licensing/backups/ci-publisher-20260930T042946Z`，现文件 SHA256 `3c930130c2cdbcb93c433de2c4e55be0fc6ce9c4bd1c3704b067d36c162eb693`。工具经独立管理员通道校验和安装，CI 上传包不能自行更新它们。

## 首次自动发布验收成功

[运行 36669107756](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36669107756) 由 master 推送自动触发，提交 `7083aa85ccb9f4bde9fbde9d0f1fea6934dc2055`，整体 success，耗时 3 分 3 秒。类型检查、支付／授权回归、构建、官网浏览器检查、部署回归及实际发布步骤均通过。

随后通过独立管理员 SSH 通道读取服务器，核对：

- `/opt/tblink-licensing/RELEASE` 与 `/var/lib/tblink-deploy/last-success.json` 的 revision 均为上述 SHA，回执 runId 为 `36669107756`、attempt 为 1、status 为 success。
- 官网链接指向 `/srv/tblink-purchase-releases/7083aa85ccb9f4bde9fbde9d0f1fea6934dc2055-f5ec2cc0`；页面、脚本、样式、图片、字体及许可文件的公网 SHA256 均匹配 CI 部署回执，六项均返回 HTTP 200。
- 服务备份 `/var/lib/tblink-licensing/backups/20260930T043302Z`，官网备份 `/var/lib/tblink-licensing/backups/20260930T043303Z-website`；API bundle、Nginx 和支付环境摘要保持原值。
- SSH、团播服务、交付恢复定时器、Nginx、金河分镜和无忧排班均 active。SQLite quick_check 为 ok，订单 1、收款 0、授权 0。
- 公网 API 与官网代理的支付宝目录仍开放 800 元／8,000 元商品，微信目录仍关闭；此次未产生付款或新授权。

GitHub 已确认存在 `TBLINK_DEPLOY_SSH_KEY`、`TBLINK_DEPLOY_KNOWN_HOSTS`，开关为 `true`。这证明服务和官网的持续部署链路已完成首次实测，不代表 Windows 自动发行、企业提额、微信商户办理或真实支付验收已完成。

## 验证与发布顺序

1. `.github/workflows/verify-licensing-server.yml` 在匹配路径的 master push、PR 或手动触发时，使用锁文件安装依赖，执行类型检查、支付／授权测试、服务和官网构建、浏览器检查、Python 发布恢复回归。
2. 只有正式仓库、master 分支、非 PR 事件，且仓库变量 `TBLINK_AUTO_DEPLOY=true` 时进入部署判断。确认远端 master 仍与本次构建 SHA 一致；已被新提交取代的运行跳过部署并写入 Actions summary。若新提交只改文档、不触发本工作流，需在当前 master 手动运行一次。
3. `deploy-from-ci.py` 再核对 Git HEAD、仓库、分支及跟踪文件无修改，生成全部产物（服务 JS、运营后台、官网页面与媒体）的来源／摘要清单。部署分两次连接：先只发送清单，接收器核对部署工具与 Nginx 摘要后，返回生产环境中缺失或摘要不同的产物；再只上传这些产物。生产已与本次构建一致时跳过上传并写入 Actions summary。固定 SSH 目标与主机公钥校验；私钥只在 runner 的受限临时目录使用，用后清空。
4. 服务器接收器上传窗口 900 秒（海外 runner 到上海实测约 15 KB/s），每个成员不超过 2,000,000 字节（演示视频 40 MB）。拒绝额外文件、重复成员、软链接、目录穿越、摘要不一致和不支持的元数据。未上传的产物从当前生产副本读取，并按清单摘要逐一复核，不一致即拒绝；组装出的完整包再进入后续流程。CI 不能上传环境文件、Nginx 配置、Python 部署工具或数据库。
5. 验证后的包写入 root 所有、0700 的任务目录；通过 systemd transient service 执行，SSH 断开不会直接终止发布。工作流不取消进行中的运行，服务器文件锁再次限制并发；已完成或更旧的 run ID／attempt 被拒绝。
6. 服务器核对已安装的四项部署工具（`activate-release.py`、`publish-website.py`、`publish-console.py`、`receive-release.py`）与本次源码的摘要逐字节一致，并核对 Nginx 与操作员批准的摘要一致。需要修改部署工具或代理时，必须先单独检查并安装它们，不能借上传包获得任意 root 脚本执行能力。
   - 任何修改 `apps/licensing-server/deploy/` 下这四个文件的提交合入 master 后，运维都要先重装对应工具，否则之后每次部署都会以 `Deployment tools or proxy require an operator-reviewed update` 拒绝。安装内容取 `git show <提交>:apps/licensing-server/deploy/<文件>` 的原始字节；不要从 Windows 工作区复制，CRLF 换行会让摘要不一致（2026-10-13 至 10-19 的部署全部因此被拒）。
   - CI 只部署服务 bundle、官网和后台静态文件。`deploy/` 下的运维脚本（如交付恢复定时任务调用的 `payment-exceptions.py`）和 systemd 单元不随部署更新，改动合入后需人工安装到 `/opt/tblink-licensing/`，取 `git show` 原始字节，保持原属主和权限，先备份，且不得在部署进行中安装。若新脚本依赖新的服务接口，须等对应服务部署成功后再装。
7. 复用 `activate-release.py` 执行维护、SQLite 备份及恢复校验、既有表比较、服务切换和商品目录比较；随后复用 `publish-website.py` 原子切换官网并核对页面。最后逐文件比较 CI 摘要，保存服务／官网备份路径和部署回执。

## 服务器身份和文件

| 对象 | 位置或约束 |
| --- | --- |
| 用户 | `tblink-deploy`，无密码认证，home `/var/lib/tblink-deploy` 由 root 管理 |
| SSH 规则 | `/etc/ssh/sshd_config.d/70-tblink-deploy.conf`，模板为 `apps/licensing-server/deploy/tblink-deploy.sshd.conf` |
| SSH 公钥 | `/etc/tblink-deploy/authorized_keys`，root 所有、0644，只包含专用部署公钥及 `restrict` 选项 |
| sudo | `/etc/sudoers.d/tblink-deploy`，root 所有、0440，仅允许固定接收器命令；模板同目录 `tblink-deploy.sudoers` |
| 接收器 | `/usr/local/libexec/tblink-receive-release.py`，root 所有、0644 |
| 部署工具 | `/opt/tblink-licensing/activate-release.py` 与 `publish-website.py`，root 所有 |
| 代理批准摘要 | `/etc/tblink-deploy/policy.json`，root 所有、0600，字段 `nginxSha256` |
| 任务记录 | `/var/lib/tblink-deploy/jobs/<随机 ID>/`，root 所有、0700 |
| 最新成功回执 | `/var/lib/tblink-deploy/last-success.json`，仅完整发布后更新 |

SSH 有效配置必须包含 `authenticationmethods publickey`、`passwordauthentication no`、`disableforwarding yes`、`permittty no`、`permituserrc no`，以及固定 `forcecommand`。当前服务器的全局 `permituserenvironment no` 已核对；该版本不允许将这项放进 Match 块。初次失败候选已撤回，修正后 `sshd -t`、`visudo -cf` 和有效配置检查通过。

## GitHub 配置与权限

用户已批准并在此仓库的 Actions Secrets 中配置：

- `TBLINK_DEPLOY_SSH_KEY`：专用部署私钥，不使用管理员登录密码或既有个人 SSH 密钥。
- `TBLINK_DEPLOY_KNOWN_HOSTS`：经独立核对的服务器主机公钥记录，不用运行时 `ssh-keyscan` 的未核实结果替代。

仓库变量 `TBLINK_AUTO_DEPLOY` 已设为 `true`。首次手动运行及随后修复提交触发的运行用于端到端验收；需核对 Actions success、服务器回执中的相同 SHA、生产服务与官网摘要及健康状态，才能标记自动部署成功。

关闭后续自动发布：将变量设为 `false`。这不会中断已启动的 systemd 发布任务。撤销部署身份还需移除其公钥或停用对应 SSH 规则；不要靠删除本地私钥副本撤销服务器访问权。具备仓库写权限的人能够修改工作流使用该 Secret，因此应在团队范围内管理写权限。当前账号没有仓库管理权限，尚未配置分支保护或 Environment 审批规则。

## 失败处理与回退

接收校验失败不会开始部署。服务端或官网失败会保留该任务目录；`runtime-result.json` 表示服务已更新，`result.json` 表示服务和官网均完成，`failure.json` 只记录失败类型。详细进程错误在服务器 root 可读的 systemd journal 中。

服务发布失败沿用现有旧代码／环境／代理回退，不用旧数据库覆盖期间产生的新业务写入。官网发布失败沿用旧官网链接；如果服务已经成功，则保留兼容的新服务及 `runtime-result.json`，不能宣称整次部署成功。先检查实际状态，再选择修复后的新运行或重跑 attempt，不盲目重复提交。

这条通道只支持现有工具允许的兼容、增量数据库变更。修改既有表内容或删除字段不应直接进入自动发布。根权限部署工具、Nginx 路由、支付密钥、价格与发码操作不在构建包接口范围内。

依据：[GitHub Secrets 权限](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub 部署并发](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、[OpenSSH 服务端配置](https://man.openbsd.org/sshd_config)。实现与实际机器的有效配置共同作为验收依据。

<a id="windows-更新发布staging-与后台确认"></a>
## Windows 更新发布：staging 与后台确认

授权服务和官网的自动部署（见上文）不发布 Windows 安装包。2026-10-23 起，Windows 正式包按下面的链路发布，构建机的准备步骤见 [构建机准备](RELEASE_BUILDER_SETUP.md)。

1. 发布提交只改根目录和 `apps/desktop` 两个 `package.json` 的版本号，推 master 后，在 Actions 手动运行 Release Windows（填完整提交号），或推 `vX.Y.Z` 标签。
2. 托管机做版本检查（必须高于所有已有标签和线上 `latest.yml`）、类型检查、全量单测和 lint。
3. 国内构建机（self-hosted runner，标签 `release-builder`）打包。美颜产物按仓库里的 `tools/obs/beauty/release-pin.json` 从 `D:\tblink-release-assets\beauty\<指纹前 12 位>\` 复制，afterPack 核对指纹，不符就失败。打包后用发布私钥给 `latest.yml` 加签名：私钥存在 GitHub Actions secret `TBLINK_RELEASE_SIGNING_KEY`，只在签名这一步注入环境变量，不写磁盘。然后写 `release-manifest.json`，通过受限身份 `tblink-release` 上传。
4. 服务器 `receive-update.py` 以 tblink-release 身份运行，不用 sudo。它只把这一份包写进 `/var/lib/tblink-release/staging/<版本>-<提交前 12 位>/`，不能覆盖已有目录，最多保留 5 份，也碰不到更新源。
5. 管理员在运营后台「软件更新」里看到待发布版本，经二次验证、填写原因后点「发布更新」。后台只往 `/var/lib/tblink-licensing/update-release/update-requests/` 写一份请求，内容只有：请求编号、动作（发布 / 回滚 / 丢弃）、staging 名称（发布和丢弃）或回滚目标版本、确认时看到的 manifest sha256（发布）、操作人、原因、请求时间。
6. root 的 `tblink-update-publish.path` 在请求目录或 staging 变化时触发 `publish-update.py --process-requests`；`tblink-update-publish.timer` 每 2 分钟兜底一次，接住运行期间到达的请求。脚本路径和参数都写死。它对请求目录只读：用 `O_NOFOLLOW` 打开，只接受属主为 `tblink-license`、16 KB 以内的普通文件，字段必须正好是上面几项且格式正确；已有结果的请求视为重复，直接忽略；同一时间只处理一个请求（文件锁）。然后重新核对 manifest、各文件 sha256、`latest.yml` 的版本和 sha512、Ed25519 发布签名，确认请求里的 manifest 摘要与 staging 一致，版本高于当前更新源，全部通过才按「安装包先、`latest.yml` 最后」上线，保存上一版 `latest.yml` 和回执。结果写到 `update-results/` 给后台显示，同时追加审计 `/var/lib/tblink-licensing/backups/update-audit.jsonl`（请求时间、处理时间、操作人、动作、版本、结果、失败原因）。后台读到结果后删除自己的请求文件。
7. 「回滚到上一版」同样走后台请求，把更新源改回发布当前版本之前的 `latest.yml`，前提是那一版的安装包仍在、摘要一致、签名（如有）有效。已经装上新版本的电脑不会自动降级。
8. 发布后运行 `node scripts/write-website-release.mjs` 生成官网下载信息并提交，官网随授权服务自动部署。

<a id="信任边界"></a>
### 信任边界

- 包只能来自构建机：上传身份只能写 staging，服务器发布前要求有 Ed25519 发布签名，而私钥只在构建机上。
- 后台被攻破时，攻击者只能在已经签名、已经进入 staging 的版本之间选择发布或回滚，塞不进伪造的包；客户端安装前还会用内置公钥再验一次签名和安装包摘要。
- 服务器被攻破时，可以替换 `latest.yml` 或安装包，但拿不到发布私钥，客户端会拒绝安装。它能做的是停止提供更新，或回到旧的已签名版本。
- 授权服务进程设置了 `NoNewPrivileges=true`，不能 sudo。所以后台和 root 发布脚本之间只靠请求文件，规则见上面第 6 条；失败的请求不会自动重试。
- 发布私钥：日常密钥 `release-2026-10-a` 只在 GitHub secret 里，备用密钥 `release-2026-10-b` 离线保存在 U 盘，构建机上不留副本（迁移步骤见[构建机准备](RELEASE_BUILDER_SETUP.md)）。
- 本地 `pnpm verify:release` 打出的候选包没有发布签名，只用于安装验收，服务器会拒绝发布。

<a id="服务器安装命令待用户确认后执行"></a>
### 服务器安装命令（待用户确认后执行）

前提：包含这些文件的提交已在 master 上，授权服务已由 CI 部署到同一提交。所有工具按 git 原始字节安装（不要从 Windows 工作区复制，CRLF 会让摘要不一致），`<提交>` 换成那次提交号。以下命令在管理员 SSH 会话里执行。

在管理员电脑的仓库里导出原始字节，传到服务器：

```bash
out="$(mktemp -d)"
for f in publish-update.py receive-update.py tblink-update-publish.path tblink-update-publish.service tblink-update-publish.timer tblink-release.sshd.conf; do
  git show <提交>:apps/licensing-server/deploy/$f > "$out/$f"
done
git show <提交>:apps/desktop/src/main/link/release-public-keys.json > "$out/release-public-keys.json"
cp <构建机上传公钥文件> "$out/authorized_keys"   # 内容：restrict ssh-ed25519 AAAA... tblink-release-upload
shasum -a 256 "$out"/*
scp -F ~/.config/tblink-remote/ssh_config -r "$out" tblink-server:tblink-release-install
```

然后在服务器上（`cd ~/tblink-release-install`，先用 `sha256sum *` 核对与上面一致）：

```bash

# 上传身份：只能写 staging
sudo useradd --system --home-dir /var/lib/tblink-release --shell /usr/sbin/nologin tblink-release
sudo install -d -o tblink-release -g tblink-release -m 0750 /var/lib/tblink-release /var/lib/tblink-release/staging
sudo install -d -o root -g root -m 0755 /etc/tblink-release
sudo install -o root -g root -m 0644 authorized_keys /etc/tblink-release/authorized_keys   # 构建机上传公钥，行首带 restrict
sudo install -o root -g root -m 0644 receive-update.py /usr/local/libexec/tblink-receive-update.py
sudo install -o root -g root -m 0644 tblink-release.sshd.conf /etc/ssh/sshd_config.d/71-tblink-release.conf
sudo sshd -t && sudo systemctl reload ssh

# 发布脚本、公钥和请求目录
sudo install -o root -g root -m 0644 publish-update.py /opt/tblink-licensing/publish-update.py
sudo install -o root -g root -m 0644 release-public-keys.json /opt/tblink-licensing/release-public-keys.json
sudo install -d -o tblink-license -g tblink-license -m 0750 /var/lib/tblink-licensing/update-release /var/lib/tblink-licensing/update-release/update-requests
sudo install -d -o root -g tblink-license -m 0750 /var/lib/tblink-licensing/update-release/update-results
sudo install -o root -g root -m 0644 tblink-update-publish.path tblink-update-publish.service tblink-update-publish.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now tblink-update-publish.path tblink-update-publish.timer
sudo systemctl start tblink-update-publish.service   # 生成第一份 update-status.json

# 后台开启「软件更新」：服务配置加一行后重启授权服务（约 1 秒中断）
echo 'UPDATE_RELEASE_DIRECTORY=/var/lib/tblink-licensing/update-release' | sudo tee -a /etc/tblink-licensing/service.env
sudo systemctl restart tblink-licensing
```

`publish-update.py` 和 `receive-update.py` 不在 CI 部署工具清单里，改动后不会让自动部署被拒，但要按上面的方式手工重装，并在本节记录安装的提交号和摘要。
