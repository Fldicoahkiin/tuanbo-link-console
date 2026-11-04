# 团播服务与官网自动发布

## 当前状态（2026-09-30）

服务器接收器和专用 `tblink-deploy` 身份已安装，实际 SSH 探测确认公钥认证可用、任意 shell 命令不执行、非法包在部署前被拒绝。现有团播支付配置与业务数据未修改。初始化记录位于 `/var/lib/tblink-licensing/backups/ci-bootstrap-20260930T023247Z/receipt.json`。

GitHub 仓库为 `Fldicoahkiin/tuanbo-link-console`（2026-10-24 从 `Fldicoahkiin/tuanbo-link-console` 转移过来，下文转移前的运行链接由 GitHub 自动重定向；转移后服务器的重装步骤见[仓库转移安装说明](SERVER_INSTALL_REPO_TRANSFER_20261024.md)），生产分支为 `master`。2026-09-30 用户明确授权向 GitHub 保存长期生产部署私钥并启用持续自动部署；两个 Actions Secrets 已写入，`TBLINK_AUTO_DEPLOY=true` 已启用。专用私钥没有进入 Git 文件，没有打印到聊天或日志。启用配置与实际部署验收分别记录如下。

这条链路发布授权服务和官网，不自动发布 Windows Release、不改变商品价格、不启用微信、不创建支付订单或授权。Windows 安装包及 `latest.yml` 的发布仍走已有独立流程。

实现提交 `3d27779a0998fd3788add2d33d4eed2a0f51210e` 的 [CI 36661008165](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/36661008165) 已全部通过：类型检查、支付／授权测试、服务与官网构建、浏览器检查、Python 回归。新增接收器 7 项回归与既有套件合计 62 项在本地通过；CI 同一套件通过。`Confirm production branch is still current` 与 `Deploy verified licensing service and website` 均为 `skipped`，这次不是自动部署成功证明。

启用前的独立服务器复核：生产来源仍为 `fb6e286c4a9c700b9693d566389598ace3ad446d`；API bundle、Nginx 和支付环境摘要保持此前部署值；数据库检查 `ok`，订单 1、收款 0、授权 0。SSH、团播、恢复定时器、Nginx、金河分镜和无忧排班均 active。当时自动发布任务目录为空、尚无 `last-success.json`；该初始化记录不代表后续启用结果。

## 首次启用与修复记录

- [36667188691](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/36667188691)：验证与构建通过，SSH 解析 Secret 中的私钥时报 `error in libcrypto`，未登录服务器。用同一密钥本地复现缺少末尾换行失败、补齐后成功；`3c32a8b` 修正文件末尾换行，回归使用临时生成的无权限测试密钥让实际 `ssh-keygen` 验证解析。
- [36667746831](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/36667746831)：SSH 认证成功，接收阶段的 60 秒 alarm 超时，未创建部署任务。`d52dcc6` 将上传限时设为 300 秒，分块计数并在超时中报告已接收字节数；16 MiB 总量及固定文件约束不变。
- [36668497809](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/36668497809)：1,228,800 字节实际上传用时 55.4 秒，随后服务发布成功、官网探针失败。独立读取确认新静态目录因继承 umask 077 成为 0700，Nginx 无法读取；官网自动恢复旧链接，服务 bundle、支付环境和代理摘要未改变，未记作完整发布成功。
- `7083aa8`：只给公开静态目录显式设置 0755，公开文件保持 0644；私有备份仍为 0700。探针增加 HTTP 失败识别。已在原实现上复现两种旧站状态的权限断言失败，修复后部署套件 64 项通过。

受限接收器修复备份 `/var/lib/tblink-licensing/backups/ci-receiver-20260930T042014Z`，现文件 SHA256 `c26353c444155c7ab8f426f6cda52ea39103dbeafa1e73fc2974e554d9a0d118`；官网发布工具修复备份 `/var/lib/tblink-licensing/backups/ci-publisher-20260930T042946Z`，现文件 SHA256 `3c930130c2cdbcb93c433de2c4e55be0fc6ce9c4bd1c3704b067d36c162eb693`。工具经独立管理员通道校验和安装，CI 上传包不能自行更新它们。

## 首次自动发布验收成功

[运行 36669107756](https://github.com/Fldicoahkiin/tuanbo-link-console/actions/runs/36669107756) 由 master 推送自动触发，提交 `7083aa85ccb9f4bde9fbde9d0f1fea6934dc2055`，整体 success，耗时 3 分 3 秒。类型检查、支付／授权回归、构建、官网浏览器检查、部署回归及实际发布步骤均通过。

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

<a id="windows-更新发布打-tag-即上线"></a>
## Windows 更新发布：打 tag 即上线

授权服务和官网的自动部署（见上文）不发布 Windows 安装包。Windows 正式包按下面的链路发布，工位电脑的准备步骤见 [发版中转机准备](RELEASE_BUILDER_SETUP.md)，整条链路的图和排查表见 [README](../README.md#发布与部署链路)。2026-10-24 起，用户决定去掉后台确认：推 `vX.Y.Z` 标签之后全部自动；同日定下安装包在 GitHub 云端构建，工位电脑只负责把它搬到服务器。

1. 发布提交只改根目录和 `apps/desktop` 两个 `package.json` 的版本号，推 master，CI 通过后推 `vX.Y.Z` 标签。Release Windows 只由标签触发。
2. GitHub 云端 Windows（windows-latest）做版本检查（必须高于所有已有标签和线上 `latest.yml`）、类型检查、全量单测和 lint。
3. GitHub 云端 Windows 打包。美颜产物和离线音乐分析运行时不在 git 里，各放在一个 `build-assets-<种类>-<指纹前 12 位>` release 里（压缩后分卷，每卷小于 2 GiB，附 `build-assets.json` 列出各卷的 sha256）；`scripts/build-assets.mjs fetch` 逐卷核对后直接解进 `artifacts/`，afterPack 再按 `tools/obs/beauty/release-pin.json`、`tools/music-analysis/release-pin.json` 核对每个文件，不符就失败。打包后用发布私钥给 `latest.yml` 加签名：私钥存在 GitHub Actions secret `TBLINK_RELEASE_SIGNING_KEY`，只在签名这一步注入环境变量，不写磁盘。然后写 `release-manifest.json`，把安装包、blockmap、`latest.yml` 和清单放进这个标签的草稿 GitHub Release（`scripts/draft-github-release.mjs`；私有仓库的 Actions 产物存储只有 500 MB）。
   接着，搬运脚本 `scripts/relay-release.mjs` 把草稿送到服务器：工位电脑的计划任务每 10 分钟（以及登录、联网时）跑一次，Mac 可以手动跑（`pnpm release:relay`），二选一，重复运行安全。它先用 `ssh tblink-release@… status` 查 staging 里已有的版本和是否有上传正在进行，避免重复上传；否则下载草稿、按清单和标签提交逐个核对，再通过受限身份 `tblink-release` 上传（工位电脑用 Git for Windows 的 ssh，Windows 自带的 ssh.exe 发送大量输入会停住）。服务器的 `status` 写明能拼安装包时（2026-11-04 起，[服务器安装](SERVER_INSTALL_DELTA_UPLOAD_20261029.md)），它不下载、也不上传完整安装包，只从草稿里按范围下载更新源当前版没有的块，打成一份变化部分上传：0.5.4 到 0.5.5 下载 7.4 MB（11 段）、上传 8.4 MB（含 blockmap），原来是各 982 MB。服务器拼不出来，就在同一次运行里改为下载并上传完整安装包。上传私钥只在工位电脑和 Mac 上，各一把，不进 GitHub。见[发版搬运准备](RELEASE_BUILDER_SETUP.md)。
4. 服务器 `receive-update.py` 以 tblink-release 身份运行，不用 sudo。它只把这一份包写进 `/var/lib/tblink-release/staging/<版本>-<提交前 12 位>/`，不能覆盖已有目录，最多保留 5 份，对更新源只读。收到的是变化部分时，它按里面的说明从更新源上的当前版复制其余的块，拼出安装包，再和完整上传一样按 manifest 核对大小和 sha256，对不上就拒收，并告诉搬运脚本可以改传完整安装包。同一时间只接受一份上传，第二份在发送前就被拒绝；`status` 命令只读返回 staging 里已有的版本、是否正在上传和能读的变化部分格式，其他命令一律拒绝。
5. staging 里出现新的一份包后，root 发布脚本自动发布（见第 6 条）：只考虑 staging 里版本最高、高于当前更新源、而且以前没有发布回执的那一份；目录名里的版本必须与 manifest 一致。每份上传按 staging 名称和文件指纹（inode、大小、变更时间）只尝试一次，结果写进 root 的 `/var/lib/tblink-update-publish/auto-publish.json` 和审计日志（操作人 `release-builder（自动发布）`、动作 `auto-publish`），后台「软件更新」显示「最近一次自动发布」。失败的不重试，重新上传才算新的一份。
   后台仍可发起回滚、丢弃和手动发布：经二次验证、填写原因后，后台只往自己的 `/var/lib/tblink-licensing/update-requests/` 写一份请求，内容只有：请求编号、动作（发布 / 回滚 / 丢弃）、staging 名称（发布和丢弃）或回滚目标版本、确认时看到的 manifest sha256（发布）、操作人、原因、请求时间。手动发布用来放回一个被回滚过、自动发布不再接手的版本。
6. root 的 `tblink-update-publish.path` 在请求目录或 staging 变化时触发 `publish-update.py --process-requests`；`tblink-update-publish.timer` 每 2 分钟兜底一次，接住运行期间到达的请求。每次运行先处理后台请求，再看 staging 有没有可以自动发布的新包。脚本路径和参数都写死，每次运行先核对[自己写入和信任的目录](#root-写入和信任判断的路径)整条链都归 root，不符就报错退出。请求目录只读：用 `O_DIRECTORY|O_NOFOLLOW` 打开并核对属主 tblink-license，请求文件用 `O_NOFOLLOW|O_NONBLOCK` 打开，只接受属主为 tblink-license、16 KB 以内的普通文件，字段必须正好是上面几项且格式正确；已有结果的请求视为重复，直接忽略；同一时间只处理一个请求（文件锁）。发布时先把 staging 里的四个文件不跟随链接地复制进 root 的工作目录，之后所有判断都只看这份副本：manifest、各文件 sha256、`latest.yml` 的版本和 sha512、Ed25519 发布签名、请求里的 manifest 摘要（后台手动发布时）、版本高于当前更新源。全部通过才按「安装包先、`latest.yml` 最后」上线，回执（含上一版 `latest.yml`）存进 root 的 `/var/backups/tblink/update-receipts/`。上线后，更新源只保留这个版本和它替换掉的上一版：更早版本的安装包和 blockmap 复制进这次回执的 `archived/`，核对摘要后才从更新源移除（2026-10-24 起，用户要求官网只放最新的包）。2026-11-04 起（[服务器安装](SERVER_INSTALL_BLOCKMAPS_20261029.md)），blockmap 改为每个版本都留在更新源，只移安装包；回滚撤下的版本连 blockmap 一起移出。移出之后，回执目录只保留最近 3 份回执的 `archived/`，更早回执的 `archived/` 被删除，`receipt.json` 和 `previous-latest.yml` 保留，所以发布历史和「发布过的版本不再自动发布」的判断不受影响。开始复制之前，工作目录、更新源和回执所在的磁盘只要有一个余量低于 5 GB，就拒绝发布，结果里写明哪个目录还剩多少；自动发布这样失败后不会自己再试，清出空间后在后台手动发布（2026-10-24 起，避免每版约 1 GB 的归档写满磁盘）。结果写到 `/var/lib/tblink-update-publish/results/`（tblink-license 组只读）给后台显示，同时追加审计 `/var/backups/tblink/update-audit.jsonl`（请求时间、处理时间、操作人、动作、版本、结果、失败原因）。后台读到结果后删除自己的请求文件；结果文件留在 root 目录，同一个请求编号再出现也不会重做。
7. 「回滚到上一版」同样走后台请求，把更新源改回发布当前版本之前的 `latest.yml`。上一版只从 root 的回执目录读取，而且必须有有效的发布签名、安装包仍在、摘要一致，否则拒绝。回滚后，撤下的版本同样移进这次回滚回执的 `archived/`（同样只保留最近 3 份），更新源只剩回到的那个版本，所以只能回滚一步。已经装上新版本的电脑不会自动降级。
8. 上传之后，搬运脚本等更新源换成草稿里的 `latest.yml`（逐字节相同），再把草稿转为正式 Release 并标为 Latest；同一次运行等不到，就由下一次运行完成。Release 转正式会触发 Website Release，它把官网下载信息换成更新源上的版本并部署官网（见[发布步骤](SOFTWARE_UPDATES.md#步骤)）。

<a id="信任边界"></a>
### 信任边界

- 包只能来自 Release Windows：上传身份只在工位电脑和 Mac 上（各一把），只能写 staging；服务器发布前要求有 Ed25519 发布签名，日常私钥只在 GitHub secret 里，由云端 build 作业在签名这一步使用。
- 去掉后台确认之后，同时拿到发布私钥和上传身份的人可以直接让一个新版本上线；以前还要过后台二次验证这一关。用户 2026-10-24 接受这一点，换来打 tag 即上线。客户端照旧只装有有效发布签名的包。
- 后台被攻破时，攻击者只能在已经签名、已经进入 staging 的版本之间选择发布，或回滚到回执里记录的、有签名的上一版，塞不进伪造的包；客户端安装前还会用内置公钥再验一次签名和安装包摘要。
- 授权服务账号 tblink-license 拥有 `/var/lib/tblink-licensing`，可以重命名或替换其中任何一项，包括 root 所有的子目录。所以 root 发布脚本在那里只读请求，不写任何东西；它写入或用来做信任判断的路径全部在 root 所有的目录链上，见[下表](#root-写入和信任判断的路径)。
- 服务器被攻破时，可以替换 `latest.yml` 或安装包，但拿不到发布私钥，0.5.0 起的客户端会拒绝安装。它能做的是停止提供更新，或回到旧的已签名版本。
- 授权服务进程设置了 `NoNewPrivileges=true`，不能 sudo。所以后台和 root 发布脚本之间只靠请求文件，规则见上面第 6 条；失败的请求不会自动重试。
- 发布私钥：日常密钥 `release-2026-10-a` 只在 GitHub secret 里，备用密钥 `release-2026-10-b` 离线保存在 U 盘，工位电脑上不留副本（迁移步骤见[发版中转机准备](RELEASE_BUILDER_SETUP.md)）。
- 本地 `pnpm verify:release` 打出的候选包没有发布签名，只用于安装验收，服务器会拒绝发布。
- 0.4.29 及更早的 `latest.yml` 没有发布签名，后台不能回滚到它们。回滚只能让还没升级的电脑不再收到新版本，而这些旧客户端本身不验签名，允许未签名的回滚目标就等于让伪造的回执生效。真要退回 0.4.29，由管理员通过 SSH 从 `/var/backups/tblink/update-receipts/` 里取出 `previous-latest.yml` 手工替换。

<a id="root-写入和信任判断的路径"></a>
### root 写入和信任判断的路径

`publish-update.py` 以 root 运行。下表列出它创建、写入、重命名进去、删除或读来做信任判断的每个位置。「核对」指每次运行从 `/` 逐级 `lstat`：必须是目录、属主 root、组和其他人不可写，否则报错退出。

| 路径 | root 做什么 | 父目录链的属主 | 访问方式 |
| --- | --- | --- | --- |
| `/srv/tblink-updates/windows/x64/` | 写安装包、blockmap、`latest.yml`（同目录临时名后 rename）；回滚时读安装包算 sha512、读 `latest.yml` | `/`、`srv`、`tblink-updates`、`windows`、`x64` 都是 root:root 0755 | 核对 |
| `/opt/tblink-licensing/release-public-keys.json` | 读公钥验签 | `/`、`opt`、`tblink-licensing` root:root 0755；文件 root:root 0644 | 核对目录链，另核对文件是 root 所有、组和其他人不可写的普通文件 |
| `/var/lib/tblink-update-publish/` | 写 `update-status.json`、`status-source.json`、`publish.lock` | `/`、`var`、`lib` root:root 0755；本目录 root:tblink-license 0750 | 核对 |
| `/var/lib/tblink-update-publish/results/` | 写每个请求的结果（root:tblink-license 0640） | 同上，本目录 root:tblink-license 0750 | 核对 |
| `/var/backups/tblink/update-receipts/` | 写回执，以及移出更新源的旧版本（`archived/`）；回滚时读 `receipt.json` 和 `previous-latest.yml` | `/`、`var`、`backups` root:root 0755；`tblink`、`update-receipts` root:root 0700 | 核对 |
| `/var/backups/tblink/update-audit.jsonl` | 追加审计 | 同上 | 核对 |
| `/var/lib/tblink-update-publish/work/` | 复制候选包、在副本上校验、从副本安装，结束即删；每次运行先清掉上次中断的残留 | 同上，本目录 root:root 0700 | 核对 |
| `/var/lib/tblink-release/staging/<名称>/` | 只读复制四个文件；发布或丢弃成功后删除该条目 | `/`、`var`、`lib`、`tblink-release` root:root 0755；`staging` tblink-release 0750 | 父目录链核对；`staging` 和条目用 `O_DIRECTORY\|O_NOFOLLOW` 打开并核对属主 tblink-release；文件用 `O_NOFOLLOW\|O_NONBLOCK` 打开、必须是普通文件且不超过上限；删除用 `rmtree(dir_fd=…)`，不跟随链接 |
| `/var/lib/tblink-licensing/update-requests/` | 只读请求 | `tblink-licensing` 和 `update-requests` 归 tblink-license，可被它替换 | 见第 6 条；请求内容只用来选 staging 名称或回滚版本，都按格式校验后才使用 |

staging 归 tblink-release，做不到「属主 root」。对应的做法是：root 读来做信任判断的字节，全部来自它刚复制进 `work/` 的副本，不再回头读 staging。

服务单元在 `ProtectSystem=strict` 下只把更新目录、`/var/lib/tblink-update-publish`、`/var/backups/tblink` 和 staging 设为可写，每个都是单独的挂载点。脚本里的每个 `rename` 都在同一目录内（临时名 → 正式名）；跨目录一律复制，不会遇到 `EXDEV`。

timer 每 2 分钟运行一次，为了不每次都复制、哈希所有 staging 安装包，`status-source.json` 记下 staging 里每个文件的 inode、大小和 ctime 以及更新源 `latest.yml` 的同样信息；都没变、本轮也没处理请求时，沿用上一份状态。状态只供显示，发布时总是重新复制、重新校验。

<a id="部署和运维工具的-root-路径"></a>
### 部署和运维工具的 root 路径

2026-10-23 起，部署和运维工具的 root 备份统一放在 `/var/backups/tblink`（root:root 0700，`/`、`var`、`backups` 都是 root:root 0755）。每个工具在写备份前从 `/` 逐级核对这条链，不符就在动任何东西之前退出。

| 工具 | 以 root 写入或做信任判断的位置 | 做法 |
| --- | --- | --- |
| `activate-release.py`（CI 部署） | `/var/backups/tblink/<时间>/`：解包的候选版本、`nginx` 预检配置、`previous.js`、`previous-nginx.conf`、`previous-environment`、数据库副本 | 备份目录核对后才创建；三份 `previous-*` 复制后立即与激活开始时核对过的摘要比对，回滚装回之前再比对一次，不一致就停在维护状态、不装回，等人工处理 |
| `publish-website.py`（CI 部署） | `/var/backups/tblink/<时间>-website/`：校验后复制进公开目录的静态文件、`nginx` 预检配置 | 备份目录核对后才创建 |
| `activate-catalog.py`（手工，一次性开售） | `/var/backups/tblink/<时间>-open-sales-…/` | 同上 |
| `backup-console.py`（root 定时任务，尚未启用） | 配置 `/etc/tblink-backup/backup.json`；本机加密副本 `/var/backups/tblink/console/` | 配置文件和两条目录链都必须归 root、其他人不可写，否则拒绝运行 |
| `payment-exceptions.py`（管理员 sudo 巡检） | 读 `/etc/tblink-licensing/admin-token.txt` | `O_NOFOLLOW` 打开，必须是属主 tblink-license 的普通文件；不跟随服务账号放的链接去读 root 的文件 |

旧的备份仍在 `/var/lib/tblink-licensing/backups/`（root 0700，2026-10-23 时有 76 项），不移动也不删除，文档里引用的历史备份路径继续有效。之后新的备份都不再写进这个目录。

`tblink-licensing.service` 用 `StateDirectory=tblink-licensing`。systemd 发现状态目录顶层的属主和配置不符时，会把整棵目录树递归 chown 给服务账号。root 的备份移出之后，这条行为不再影响任何 root 文件。以后不要在 `/var/lib/tblink-licensing` 或 `/etc/tblink-licensing` 里放 root 需要信任的文件：服务账号拥有这两个目录，可以重命名或替换其中任何一项。

<a id="服务器安装命令待用户确认后执行"></a>
### 服务器安装（待用户确认后执行）

更新发布和 root 备份加固合成一份安装说明，按步骤写明备份、验证和回退：[服务器安装 2026-10-23](SERVER_INSTALL_20261023.md)。上传身份的探测也在那里。

CI 部署会把服务器上已安装的 `activate-release.py`、`publish-website.py`、`publish-console.py`、`receive-release.py` 与本次 CI 清单里的摘要比对，不一致就拒绝部署（`/etc/tblink-deploy/policy.json` 只记录两份 Nginx 配置的摘要，不记录工具）。所以改这四个工具时，要先按 git 原始字节装到服务器，再把提交推上 master。`publish-update.py`、`receive-update.py`、`backup-console.py`、`payment-exceptions.py` 不在这份清单里，改动不会让自动部署被拒，但同样要手工重装。每次安装都在安装说明里记录提交号和摘要。
