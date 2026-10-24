# 服务器安装：SSH 连接的 MSS 钳制（2026-10-24，已安装）

<a id="原因"></a>
## 原因

构建机到服务器的路径 MTU 约 1492（带 DF 的 ping：1472 字节 0/10，1464 字节 8/10），超过的包被丢弃且没有 ICMP 提示。构建机的流量经 Clash（Mihomo）TUN 出去，各网卡 MTU 都是 1500，所以上传 0.5.0 时服务器只收到几 KB 到约 100 KB 就停住。以后 Release Windows 从构建机上传也会卡在这里。

<a id="做了什么"></a>
## 做了什么

只针对 SSH（22 端口），只把大于 1360 的 MSS 改成 1360，其他端口和更小的 MSS（例如 Tailscale 的 1228）不变：

- 规则：`apps/licensing-server/deploy/tblink-mss-clamp.nft`，装在 `/etc/tblink-mss/clamp.nft`（root 0644）。单独的 `inet tblink_mss` 表，不碰 docker 和 iptables 已有的表；服务器上 ufw 未启用，nftables 服务是 disabled。
  - 出站 SYN-ACK：对方发来的段不超过 1360，修上传方向。
  - 入站 SYN：本机发出的段不超过 1360，修下载方向。
- 持久化：`apps/licensing-server/deploy/tblink-mss-clamp.service`，装在 `/etc/systemd/system/`，已 `enable --now`，开机自动加载。

<a id="回退"></a>
## 回退

```bash
sudo systemctl disable --now tblink-mss-clamp.service   # ExecStop 删除 inet tblink_mss 表
```

<a id="安装结果"></a>
## 安装结果

用户在主会话里直接确认「确认服务器改动」后由主会话执行。

- 两个文件的 sha256：`tblink-mss-clamp.nft` `b4883227f03b2e2e5a199de76bb7fe970f177dacb9d1ac666cf1c273cda60b2e`，`tblink-mss-clamp.service` `1cb5224951bc6de988fd4a497a7756944a7210fb5f8e106394e5a82f3fc7b71f`。
- `nft -c -f` 语法检查通过；服务 `active`、`enabled`；`nft list table inet tblink_mss` 显示两条规则。
- 另开 SSH 登录正常；经 Tailscale 的现有连接 MSS 为 1228，未被改动；公网 `/health` 正常。
