# 团播服务与官网自动发布

## 当前状态（2026-09-30）

服务器接收器和专用 `tblink-deploy` 身份已安装，实际 SSH 探测确认公钥认证可用、任意 shell 命令不执行、非法包在部署前被拒绝。现有团播支付配置与业务数据未修改。初始化记录位于 `/var/lib/tblink-licensing/backups/ci-bootstrap-20260930T023247Z/receipt.json`。

GitHub 仓库为 `JinHe9527/tuanbo-link-console`，生产分支为 `master`。自动发布开关及两个 Secrets **尚未写入**；自动审批要求用户明确批准“保存长期生产部署密钥并使后续 master 提交自动部署”这项持续权限变更。工作流在配置缺失时只做验证，不会尝试生产部署。专用私钥没有进入 Git 仓库，没有打印到聊天或日志。

这条链路发布授权服务和官网，不自动发布 Windows Release、不改变商品价格、不启用微信、不创建支付订单或授权。Windows 安装包及 `latest.yml` 的发布仍走已有独立流程。

实现提交 `3d27779a0998fd3788add2d33d4eed2a0f51210e` 的 [CI 36661008165](https://github.com/JinHe9527/tuanbo-link-console/actions/runs/36661008165) 已全部通过：类型检查、支付／授权测试、服务与官网构建、浏览器检查、Python 回归。新增接收器 7 项回归与既有套件合计 62 项在本地通过；CI 同一套件通过。`Confirm production branch is still current` 与 `Deploy verified licensing service and website` 均为 `skipped`，这次不是自动部署成功证明。

配置后的独立服务器复核：生产来源仍为 `fb6e286c4a9c700b9693d566389598ace3ad446d`；API bundle、Nginx 和支付环境摘要保持此前部署值；数据库检查 `ok`，订单 1、收款 0、授权 0。SSH、团播、恢复定时器、Nginx、金河分镜和无忧排班均 active。自动发布任务目录为空，尚无 `last-success.json`。服务器接收器 SHA256 `d3b2c44162bc378994ac3e80e16439d778ca68d1795db727dec81d0fae8a6759`、官网发布脚本 SHA256 `f532a3f37cde08a20c02d7a1c2a5c7fa08458f5ea7db5c4f41135e03d74078ed`，均与本仓库文件一致。

## 验证与发布顺序

1. `.github/workflows/verify-licensing-server.yml` 在匹配路径的 master push、PR 或手动触发时，使用锁文件安装依赖，执行类型检查、支付／授权测试、服务和官网构建、浏览器检查、Python 发布恢复回归。
2. 只有正式仓库、master 分支、非 PR 事件，且仓库变量 `TBLINK_AUTO_DEPLOY=true` 时进入部署判断。确认远端 master 仍与本次构建 SHA 一致；已被新提交取代的运行跳过部署并写入 Actions summary。若新提交只改文档、不触发本工作流，需在当前 master 手动运行一次。
3. `deploy-from-ci.py` 再核对 Git HEAD、仓库、分支及跟踪文件无修改，将服务 JS、固定六个官网文件与来源／摘要清单打成无压缩包。固定 SSH 目标与主机公钥校验；私钥只在 runner 的受限临时目录使用，用后清空。
4. 服务器接收器最多读取 16 MiB，每个成员不超过 2,000,000 字节。拒绝额外文件、重复成员、软链接、目录穿越、摘要不一致和不支持的元数据。CI 不能上传环境文件、Nginx 配置、Python 部署工具或数据库。
5. 验证后的包写入 root 所有、0700 的任务目录；通过 systemd transient service 执行，SSH 断开不会直接终止发布。工作流不取消进行中的运行，服务器文件锁再次限制并发；已完成或更旧的 run ID／attempt 被拒绝。
6. 服务器核对已安装的三项部署工具与本次源码的摘要一致，并核对 Nginx 与操作员批准的摘要一致。需要修改部署工具或代理时，必须先单独检查并安装它们，不能借上传包获得任意 root 脚本执行能力。
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

用户批准后，在此仓库的 Actions Secrets 中配置：

- `TBLINK_DEPLOY_SSH_KEY`：专用部署私钥，不使用管理员登录密码或既有个人 SSH 密钥。
- `TBLINK_DEPLOY_KNOWN_HOSTS`：经独立核对的服务器主机公钥记录，不用运行时 `ssh-keyscan` 的未核实结果替代。

然后将仓库变量 `TBLINK_AUTO_DEPLOY` 设为 `true`，手动运行当前 master 的 `Verify Licensing Server` 做首次端到端验收。需要核对 Actions success、服务器回执中的相同 SHA、生产服务与官网摘要及健康状态，才能标记自动部署成功。

关闭后续自动发布：将变量设为 `false`。这不会中断已启动的 systemd 发布任务。撤销部署身份还需移除其公钥或停用对应 SSH 规则；不要靠删除本地私钥副本撤销服务器访问权。具备仓库写权限的人能够修改工作流使用该 Secret，因此应在团队范围内管理写权限。当前账号没有仓库管理权限，尚未配置分支保护或 Environment 审批规则。

## 失败处理与回退

接收校验失败不会开始部署。服务端或官网失败会保留该任务目录；`runtime-result.json` 表示服务已更新，`result.json` 表示服务和官网均完成，`failure.json` 只记录失败类型。详细进程错误在服务器 root 可读的 systemd journal 中。

服务发布失败沿用现有旧代码／环境／代理回退，不用旧数据库覆盖期间产生的新业务写入。官网发布失败沿用旧官网链接；如果服务已经成功，则保留兼容的新服务及 `runtime-result.json`，不能宣称整次部署成功。先检查实际状态，再选择修复后的新运行或重跑 attempt，不盲目重复提交。

这条通道只支持现有工具允许的兼容、增量数据库变更。修改既有表内容或删除字段不应直接进入自动发布。根权限部署工具、Nginx 路由、支付密钥、价格与发码操作不在构建包接口范围内。

依据：[GitHub Secrets 权限](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)、[GitHub 部署并发](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)、[OpenSSH 服务端配置](https://man.openbsd.org/sshd_config)。实现与实际机器的有效配置共同作为验收依据。
