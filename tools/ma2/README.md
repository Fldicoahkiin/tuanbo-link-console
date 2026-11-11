# 编排台 MA2 桥接插件

2026-09-15 新增 LIST 只读目录协议。设置 → 设备连接 → MA2 控台 → 现场节目导入可扫描当前 Show 的已录制时间线、核对 Cue 编号、配对导入并导出现场核对包。需要重新导入并运行本版插件；只更新联动台不够。本机 onPC 3.3.4.3 已通过真实全池扫描，实体控台仍需现场核对。详见 `docs/P1_MA2_PROGRAM_TRANSFER.md`。

## 安装与更新

插件随安装包内置，无需另行下载。进入“设置 → 设备连接 → MA2 控台”，点击页面顶部的“导出控台插件”，选择电脑目录或 U 盘；无需先连接控台。导出的 XML、Lua 文件必须放在同一目录。

在 MA2 插件池选择空闲位置，打开编辑器，通过 Import 选择 `tblink_bridge.xml`。本机 onPC 的文件放在对应版本数据目录的 `plugins` 下，例如 `C:/ProgramData/MA Lighting Technologies/grandma/gma2_V_3.3.4/plugins`。实体控台通过 MA2 识别的 USB 插件目录导入。

更新时先复制两个文件，再重新导入本应用已有的插件位置；随后在插件编辑器点击 **Reload** 并确认，关闭编辑器，运行插件一次。只复制文件或只 Reload 不会更新 Show 内已经导入的代码。本机 3.3.4.3 已验证此流程。不要选择其他插件的位置。

## 连接实体控台

1. 电脑与控台用网线直连或接同一交换机，配置同一局域网。控台打开 Setup → Console → Global Settings → Telnet → Login Enabled。
   登录用户在 Setup → Console → User & Profiles Setup 中查看或由管理员新建，使用这个 Show 用户的密码；未设密码才留空。IP 页面不显示登录账号，账号密码区分大小写。
2. 点击“搜索局域网控台”并选择地址，或手动填写控台 IP。填写登录用户及密码，点击“连接控台”。密码由 Windows 安全存储保管，不写入节目工程。
3. 默认命令端口 **30000**、监视端口 **30001**。两个端口都需可达；Lua 的真实回复来自监视端口，命令回显不能当成成功。Telnet 使用明文传输，请用于受控的演出局域网。
4. 在控台运行插件后，点击“检查 MA2 连接”；出现“插件通信正常”后再读取 Timecode。网络登录成功、插件通信正常、同步核对成功是三个独立状态。
5. 可保存“启动时连接”；启动仅尝试一次，失败由操作员重新连接，不重发同步写入。

只使用本机 onPC 时，可选择“本机 onPC”并填写数据目录，不需要远程登录。

## 编排与同步

选择 Timecode 编号并读取。首次可加入当前节目，或使用空闲编号创建专用 Timecode。关联灯光轨道与执行器后，比较双方修改、处理冲突，再同步。写入前导出目标 Timecode 备份，完成后回读核对；不会覆盖完整 Show、灯具参数或未绑定对象。

播放中禁止写入控台工程。断线、超时、部分失败都显示未完成；先重新读取核对，不能假定失败请求未执行。网络传输未正常释放时，插件保留请求最多 120 秒，避免其他请求抢占。

“设置 → 设备连接 → MA2 控台 → 控台 MIDI 地址”可设置 MSC 设备号（0–127，127 为全部设备），用于直接触发 MA2 Cue。它与网络 IP、灯具 DMX 地址是不同设置；MA2 MSC 执行器格式需要使用 Exec.Page。

音乐驱动时间码仍走 MIDI：在编排台选择 MTC 输出，在 MA2 选择匹配的 MIDI 时间码输入。不要把网络工程同步当成 MTC。Cue、灯具地址、颜色、位置与效果继续在 MA2 内保存和执行。

本机文件桥的请求、响应位于 `temp`；控台导出、备份及回读位于 `importexport`。备份名为 `tblink_backup_<请求编号>.xml`。网络协议不需要 LuaSocket，支持 PING、READ、SNAPSHOT、SCOPE、APPLY、SYNC、CREATE、EXECUTOR；数据每段 256 字节并核对身份，失败不自动重试。

### 网络协议：一步一步做（0.5.9）

一次请求：`begin`（或 `beginsync`，引用插件上一次 SNAPSHOT/SCOPE 留下的完整快照）→ `chunk` × N（每段 256 字节）→ `run` → 按需 `step` → `read` × M → `release`。

- 插件把请求排成一张步骤表，挂在这次请求上（不是全局唯一），**每一步最多在控台上做一次 Export 或 Import**。写入那一步不拆：APPLY、SYNC 是“备份导出 → 和预览比对 → 写文件 → Import”整体，CREATE 是“写文件 → Import”整体，改名是“备份导出 → 核对 → Label”整体，自动关联是“新建页 → 核对 → Assign”整体；写后的读回导出是下一步。
- 联动台发 `run` 带 `'steps'`：插件做完第一步就回 `STEP:1`；之后每条 `step` 做一步，回 `STEP:<已做几步>`，最后一步回 `DONE:<回答长度>`。只有一步的请求（PING、READ、目录、改名等）`run` 直接回 `DONE`。每条 `step` 都是单独的一条 Telnet 命令，所以关灯（停止档）、单击 Cue 试听（播放档）在两步之间就能发出去，不用等整件事做完。
- 每条命令都给这次请求续期，停在半路的请求仍是 120 秒后才让别人开始，和以前一样。一步出错时整件请求结束，回答和以前一次做完时出错一样（`ERROR` 加原因），`release` 后下一次 `begin` 照常开始。没有在等的步时 `step` 报 `No step pending`，什么都不做。
- 不带 `'steps'` 的 `run`（分步以前的联动台，以及联动台升级插件时对旧插件的核对）把所有步一次做完再回 `DONE`，和以前的插件完全一样；本机文件桥也一样一次做完。分步以前的插件不认 `'steps'`，`run` 直接回 `DONE`，新联动台照常走完。
- `PING` 的回答是控台版本，分步的插件在后面另起一行 `steps=1`。
- 节目开始走时联动台在两步之间停下（`apps/desktop/src/main/link/ma2-onpc-bridge.ts` 的 `ma2StepGate`，按 `showGate` 定）：不再发下一条 `step`，马上发 `release`，`release` 不等节目。写入那一步（APPLY、CREATE 是第 1 步，SYNC 是第 `2×序列数+3` 步，`ma2WriteStep`）和它后面的读回不停，所以停下的请求一定还没写入。`PING`、`DISCARD` 任何时候都发。这一条插件本身没有改；两条道上各自按这条停。
- 每一步里执行的控台命令、先后顺序、核对和回答都和分步以前一样，由 `apps/desktop/src/main/link/ma2-bridge-lua.test.ts` 在 Lua 5.3 解释器里跑插件原文核对。**未在实体控台和 onPC 上验证。**

### 两条道：前台只读、后台同步（0.5.9，M4）

- 插件里同时最多两件请求：后台道 `bg` 一件（同步、改名、自动关联、读时间线和序列、快照），前台道 `fg` 一件（只读）。`begin` 在最后多带一个道名：`TBLINK_NET(token,'begin',id,op,target,size,'bg'|'fg')`，认道名的插件回 `ACK:lanes`，分道以前的插件不认这个参数，照旧回 `ACK`，联动台由此知道只有一条道，所有请求都走一条（`Ma2NetworkWire.lanes`）。后面的 `chunk`、`run`、`step`、`read`、`release` 按请求编号找到自己那条道，不带道名。
- 前台道只收 `PING`、`PAGES`、`PAGE`、`LIST`、`LISTSEQ`、`EXECUTOR`，别的一律回 `Operation not allowed on the foreground lane`：会写控台的（APPLY、SYNC、CREATE、LABEL、ASSIGNSEQ）、会删文件的（DISCARD）、会给后面的请求留快照的（SNAPSHOT、SCOPE，`beginsync` 只在后台道）都不行；长的读取（READ、SEQUENCE、SEQCUES、TCRANGES）也留在后台。
- 联动台这边（`ma2-onpc-bridge.ts` 的 `ma2Lane`）：后台道每走一步之前，先等那时已经排着的前台请求整个做完，再发下一步；写入那一步后面紧跟的读回不等。前台请求只读、临时导出文件名带自己的请求编号，所以在两步之间做完不改变后台请求看到的任何东西。一条道上的请求出错只取消这条道上排着的请求；等待（节目在走）谁都不取消。
- 两条道各自 120 秒过期，一条过期不影响另一条；`release` 只放自己那条。不带道名的 `begin`（分道以前的联动台、升级插件时的核对）占后台道，并且要两条道都空着，和以前“只有一件请求”一样。
- 本机文件桥一次做完一个请求文件，没有道，不变。`PING` 的回答不变（仍是版本加 `steps=1`），有没有两条道看 `begin` 的回答。
- 已知：SYNC 的预检快照现在分成多步，一个 Sequence 在它自己的两次导出核对之后、写入那一步之前被改，写入那一步只再比对 Timecode，拦不住；以前整件事在一次 Lua 调用里做完，这段时间几乎为零。

## 验证范围

2026-09-11：已在本机 onPC 3.3.4.3 验证双端口输出方向、新版 Lua 网络入口和 PING 的开始、执行、分段回读、结束响应。另通过监视端口完整回读 1385 字节的执行器 XML，6 个数据块与声明长度一致；512 字节大块会被原生监视输出截断，已改成 256 字节。本机文件桥的读取与连续交接已回归。远程登录后的自动网络同步、实体控台与真实 MIDI 演出闭环尚未验收；模拟服务测试不能代替实机测试。

开发测试对象为 Timecode / Sequence 9901–9904 及本应用专属执行器，相关脚本不用于生产 Show。完整进度见仓库 `docs/LIGHTING_MA2_IMPLEMENTATION.md`。

官方参考：[Telnet Remote](https://help.malighting.com/grandMA2/en/help/key_remote_control_telnet.html) · [Edit Plugins](https://help.malighting.com/grandMA2/en/help/key_plugins_edit.html)

## 多台控台和版本检测

可以保存最多 128 个控台连接；“已保存控台”选择后点击连接，启动仅连接最后保存的目标。切换地址会清除尚未提交的密码和旧读取预览，不会把账号尝试到所有搜索结果上。每台保留独立参数，密码按 IP、远程端口和用户隔离。旧单台配置自动读取，首次保存转换为列表。

搜索只接收远程端口横幅，不发送登录或控台操作；开放端口但未识别 MA2 的设备标为“待确认设备”。默认搜索本机、最多 8 个网卡的所在 /24 范围以及已保存地址，每次最多 24 个并行探测，可取消。小于 /24 的子网按实际掩码收窄；更大的网段不会整网穷举，界面显示范围，范围外地址可手动加入。Telnet 未开启、设备不回横幅或防火墙拦截可能无法自动识别。

“检测版本兼容性”读取当前版本、Lua 引擎、插件入口、对象与文件接口；没有硬编码版本白名单。基础接口可用不代表 XML 或工程同步已经通过；仍需目标 Timecode 的读取、差异检查和写入回读。缺少对象/文件接口时禁止工程交换，不把异常降级为成功。

**目前不能承诺所有历史 MA2 版本完整兼容。** 3.3.4.3 已有本机真实测试；其他版本需要对应运行环境和实际 XML 样例。MA 官方说明 3.1 起使用 Lua 5.3，跨版本插件可能需要修改。模拟不同版本字符串仅验证分支行为，不能替代这些版本的实测。网络连接还需要真实 Show 用户登录，自动发现不能获得密码或开启控台权限。

参考：[MA2 Telnet](https://help.malighting.com/grandMA2/en/help/key_remote_control_telnet.html)、[3.3 发布说明（Lua 版本说明）](https://help2.malighting.com/grandMA2/en/help/release_notes/key_rn_v3_3.html)、[插件跨版本说明](https://help.malighting.com/grandMA2/en/help/key_keyword_reloadplugins.html)。
# 效果库扫描

2026-09-15：灯光工作台「读取控台」新增 LISTSEQ / SEQUENCE 只读操作，读取所有序列的实际 Cue 编号与已记录 Fixture ID。请从新版联动台重新导出插件并在控台重新加载运行。扫描不执行 Cue、不写灯具参数、不删除控台对象。此新增全 Cue 池协议尚需现场版本验证；时间线 LIST 验收不能代替本功能验收。

## 只接 MIDI 时使用 Cue

仅 MIDI 连接不需要本插件、网线或登录账号。在“音频与 MIDI”配置“灯光动作输出”，在灯光工作台选择“MIDI · 直接触发 Cue”。手工添加控台已有序列、Cue 和执行器引用后即可编排触发；它不会读取或生成 Cue 内的灯具参数。

控台 Setup → Console → Midi Show Control：MSC In Mode 选 MIDI，Command 选 General Light 或 All，Exec 选 Exec.Page；设备号与联动台一致（联动台 127 表示全部设备）。联动台填写页.执行器，发送时转换为 MA2 的 Exec.Page 顺序。

若控台已有录好的 Timecode，选择“MTC · 控台时间线播放”，由控台执行时间线，不重复发送 Cue 指令。若要自动读取控台 Cue 列表或双向修改控台工程，再启用网络连接和插件。
