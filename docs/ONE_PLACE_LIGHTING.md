# 只有一处实现 · 灯光和 MA2

> 这是 [AGENTS.md](../AGENTS.md)「同一件事只有一处实现」表的细节，2026-11-12 从表里原样挪过来。每一节对应表里的一行：这件事在哪决定、规矩是什么、哪个测试守着。新功能复用这些地方，不另开一条路。
>
> 带日期的是用户定过的或当时定下的，不要悄悄改回去。改了哪一节对应的代码，在同一次提交里把这一节改过来；加了新的“只有一处”，在这里加一节，并在 AGENTS.md 的表里加一行（写明在哪、哪个测试守着）。

## 怎么认控台

网络登录由 `apps/desktop/src/main/link/ma2-telnet.ts` 同时核对对端返回的 MA2 版本与设备类型。Console 和 onPC 可以进入已连接状态。MA 3D 也能响应相同的 Show、版本和 Lua 命令，连到它时显示原因并断开。设备类型缺失时提示核对地址。`apps/desktop/src/main/link/ma2-telnet.test.ts` 覆盖两种拒绝和正常控台登录。

只按编号认，不看 Show 名和 IP（`packages/core/src/ma2-console-identity.ts`）

操作员点「检查版本和时码槽」时，`apps/desktop/src/main/link/ma2-capabilities.ts` 同次读取插件能力和本次连接站点的 MIDI TC 分配。以应答站点的 HOSTIP 在 NetConfig 中定位带该字段的运行中站点，按属性索引读取。缺失或不唯一时提示到接收站检查。切换连接后丢弃旧回答。空闲和播放期间均不会定时调用这项检查。`apps/desktop/src/main/link/ma2-network-manager.test.ts` 覆盖槽位匹配、不匹配、关闭和无法确认。

## 歌和控台时间线怎么配对

核对自建歌曲是否跟随时，先确认已绑定的 MTC 起点与歌曲相同，并检查该歌曲序列最近确认的执行器分配。已从原格位移除的歌曲会提示序列与执行器编号。原格位可能已分配给其他序列，碰巧相同的 Cue 编号无法证明正在跟随。由 `packages/core/src/console-follow.test.ts` 覆盖。

只看时间码节目编号和 MTC 起始码（`packages/core/src/ma2-pairing-state.ts`）

2026-11-16 最新要求：统一「控台时间线」列表入口，手动关联和右键编辑共用 `runtime/ma2-timeline-actions.ts`，移除旧的替换/追加选择页面与重复入口。同 MTC 自动匹配，手动选择先现读、存档，再执行同一条可撤销配对命令；新建立即创建空时间线及序列，占用编号/格位向后顺延，实际结果回填。控台已有时间线的名称/MTC 由 `ma2-timeline-edit.ts` 核对来源、保留所有事件和相对时间后写入并回读。详细规则见 LIGHTING_WORKFLOW.md 开头。

2026-11-14 修复首次配对只显示“对上”、Cue 没进歌曲：完整的控台读取结果与歌曲起始码唯一匹配时，配对步骤就通过原有导入命令把 Cue 放进歌曲。先读控台再改起始码、先有歌曲再读控台都一样，与这次改动一起撤销。已关联的不重复导入，不覆盖本地编辑；目录未读完整、来源未确认、转换失败、起点重复或操作员已解除关联的先不自动导入。导入失败保留原编排和起始码，原因记在对应时间线上，其他编辑不触发重试。回归：`packages/core/src/ma2-timeline-switch.test.ts`。

## MA2 同步

本机文件通信只在文件模式取请求，切换网络连接后由网络请求驱动。配套组件分别回应已知编号的失败请求，并继续受理下一笔操作。32 MiB 的单次通信正文与文件头分开计算。`apps/desktop/src/main/link/ma2-bridge-timers.test.ts` 检查切换通道及损坏请求后的恢复。

手动同步同时检查联动台选曲序列里的 Cue 触发方式。这里的步骤由原生时间线指定，Follow 或 Time 会让控台自行执行下一条选曲或关闭命令。恢复 Go 前核对 Show、插件会话、原生时间线引用，以及选曲时间线和序列的两处所有权标记。写前备份，写后比对序列内容；再次核对通过才显示已同步。`apps/desktop/src/main/link/ma2-sequence-trigger-read.test.ts` 覆盖两处标记不齐、已恢复 Go 和重复核对。

重新连接前若控台目录里找不到工程此前读过的任何一条绑定时间线，保留现有灯光和素材，并显示当前 Show 名及缺少的编号。手动同步当前节目时，用这次控台读到的起点核对配对。上一份目录来自其他 Show、缺少当前歌曲或起点变化时，只补读对应编号。控台与歌曲起点不同就显示两边的实际时间，保留编排。控台删除某个 Cue 后，原时间线可能留下没有目标的 Goto。手动同步应指出轨道、第几个点和所在帧，修正后再次核对。若联动台负责选曲的执行器被设置为禁用 Cue 命令，同步时核对 Show、选曲时间线、序列和当前分配，备份原执行器并恢复命令开关，重新导出确认其余设置没有变化。同次读取不把其他节目的内容标记为已核实。

手动同步还要检查当前歌曲能否由选曲时间线启动、中途定位时能否追到当前 Cue，以及离开歌曲时能否正常释放。若控台导出确认仅歌曲的 AutoStart、Status Call 或 Switch Off 设置偏离，在核对 Show、连接代次、输入槽和时间线编号后，仅备份并修正对应歌曲的设置，保留原轨道和 Cue，再从控台读回。若选曲时间线自身损坏，则走原有选曲准备和复核。检测和修复均由本次手动点击触发。测试见 `ma2-bridge-lua.test.ts`、`ma2-mtc-selection.test.ts` 和 `ma2-network-manager.test.ts`。

手动核对当前节目时，先从控台导出核对已绑定的时间线是否使用歌曲的 TC Slot 2。已经从其他时码槽导入用于编辑的时间线，若该轨仍使用已确认的槽位，则照常读写其轨道和 Cue，并核对当前 Show。编辑这种时间线不会触发歌曲选曲表的准备。内容经读回确认后，侧栏提示「编排已同步 · 播放需换槽」，详情列出这条时间线当前使用的时码槽。原先走歌曲时码槽的绑定被改到其他槽位时保留原工程和控台设置，指出具体编号、实际槽位和应恢复的槽位。恢复后重新读回并核对选曲。其他节目的槽位不参与这项判断。见 `ma2-network-relogin.test.ts`。

手动核对当前节目时，TCRANGES 在当前歌曲的活动轨道上把每个 Goto 的序列号与执行器的实际分配逐项对照。控台更换或移除执行器后可能仍导出旧 Cue。缺少执行器或目标不符时，保留工程和控台内容，指出轨道或步骤及其目标；修正后再次读回。一次请求内复用同一执行器的导出。回归见 `ma2-bridge-lua.test.ts`，带灯实测见 `docs/LIGHTING_LIVE_AUDIT_20261119.md`。

自建歌曲的同步回读先核对原生 Goto 引用的序列。换掉执行器时，MA2 可能连带改写原有点的全部引用。出现其他序列时保留时间线和工程点位，提示新旧序列，由操作者核对后再点同步。真实删除的点、移动与新增的点仍按双方上次确认的位置合并。由 `apps/desktop/src/main/link/ma2-song-console-edits.test.ts` 覆盖。

手动切换同步节目后，先前请求的目录结果和错误均不能改动新请求的状态。目录检查以发起时的工程、节目、绑定和同步请求为准。这条规则由 `apps/desktop/src/renderer/src/link/runtime/ma2-realtime-session.test.ts` 的切歌后迟到错误用例验证。

歌曲同步在读取状态、等待存档和提交控台写入之间也要核对这次手动选择。等待中改为同步另一首，原歌曲保留待核对状态，尚未提交的写入随之结束。`apps/desktop/src/renderer/src/link/runtime/ma2-realtime-session.test.ts` 覆盖存档期间切换的情形。

逐首手动同步在 `apps/desktop/src/renderer/src/link/runtime/ma2-realtime-session.ts` 核对已关联 Timecode 的在场情况。现场目录同时提供本次 Show 身份。只有目标编号在场才更新本地素材目录并开始内容同步。换 Show 或删除目标后停止本次请求，保留原工程的 Cue 和素材。恢复编号后从同一按钮继续。缺少编号的原因只归到当前歌曲。同一 Show 中其他歌曲的有效确认保留；读到控台换 Show 时，旧确认要在新 Show 上重新取得。`apps/desktop/src/renderer/src/link/runtime/ma2-realtime-session.test.ts` 覆盖同名和异名 Show 缺少编号及恢复后的核对。同一次手动核对会读取当前 Show 的实际 MTC 时段，检查与当前歌曲有关的重叠。即使连接和 Show 始终相同，控台单独移动另一条时间线也在检查范围内。修正起点时可选择工程外的冲突对象，保存时复核其当前身份、起点和名称，处理后重新核对原歌曲。手动同步时同一次控台目录读取还要检查选曲时间线能否自动开始，以及执行器是否仍指向选曲序列。歌曲首尾的 Goto 和选曲命令使用 ma2-mtc-selection.ts 中的同一套规则复核。同次核对也检查起点以外是否有额外的原生 Goto 选回这首歌。这类残留会在播放其他歌曲时重启当前歌曲。发现失配时只在该次手动请求内准备选曲，并在同一个 Show 重新读取，才能确认当前节目。

首次手动读取目录或素材期间，如果当前歌曲正在等待配对，按同步也会留下这一次单曲请求。现有同步流程在读取空闲后复核该歌。手动核对当前节目的时段时，还要留意其他时间线引用的序列。原生 Cue 可以独立监听同一时码槽，辅助选曲和歌曲区间即使都正确，另一条执行器也可能亮起。只在操作员点同步后核对。若其他序列有落在本曲时段内的原生时间触发，显示序列、Cue 和引用它的 Timecode；操作员可以核对对应节目或在控台修改。只读这项冲突，当前节目写入不改其他节目的 Cue。准备选曲时，如果连续两遍从控台读到该序列的每个 Cue 都是 Go，则不用导出整份灯具数据。原生零号占位可以是空的，其他位置读不清、空序列及自动触发仍需用完整文件核对。见 `ma2-bridge-lua.test.ts` 和 `ma2-network-relogin.test.ts`。

目录确认和时间线读回之间，控台仍可能切换 Show 或删除目标。首次读回以及写入前再次核对同一个 Timecode 时，如果控台明确报告它已不存在，就结束本次请求，保留本地 Cue，显示缺少的编号。核对 Show 并恢复原时间线后可再次点同步。如果操作员已切歌或改绑，只把旧检查退回待核对。对应路径在 `ma2-console-reading.ts`，回归测试在 `ma2-bound-song-sync.test.ts`。

核对选曲辅助序列或歌曲的执行器时，`ma2-song-executor.ts` 先读取已指定的执行器页并校验 Show 身份。控台报告缺页时用目录复核，目标页已满时用目录查找后续位置。写后重新读取分配结果。测试见 `ma2-song-executor.test.ts` 和 `ma2-layout-service.test.ts`。

当前节目的读回同时记录主进程连接编号。侧栏、编辑器和同步详情共用 `apps/desktop/src/renderer/src/link/view-models/ma2-workbench-sync-status.ts` 判断确认是否仍属于本次连接。断线、换控台、重连和手动核对都有独立状态。重新登录本身不能恢复上次的绿色确认。测试见 `apps/desktop/src/renderer/src/link/view-models/ma2-workbench-sync-status.test.ts`。

2026-11-21，工作台启动时保持空闲。编辑后只标出当前节目待同步。点「同步当前节目」开始一次双向核对并打开详情，核对期间再点可查看进度。原先保存的实时同步开关在重新启动后失效。工作台和时间线列表共用当前节目的状态，只有控台读回确认才显示「已同步」。设置里的合并、覆盖及控台改动处理方式继续保存在本机。见 `ma2-sync-modes.spec.ts` 和 `ma2-workbench-sync-status.test.ts`。

2026-11-20，在同一控台和 Show 恢复已绑定的零步骤序列时，MA2 保存后可能只留下原执行器的默认按键。歌曲使用之前确认的格位，在写入前单独导出核对原格，分配后读回序列号。格位已有对象、自定义按键或者是新节目的目标时，沿用原先的选位规则。回归见 `ma2-song-executor.test.ts`，onPC 重开记录见 `docs/LIGHTING_LIVE_AUDIT_20261119.md`。

超过 32 MiB 的原生歌曲序列按 Cue 记录灯具数据的位置。改名、插入和删除时保留未编辑的原生数据，复制素材时单独展开需要的 Cue。写后核对先比较每个保留 Cue 的完整原生数据和命名空间，遇到编码、名称表示或内部步号差异时仍按原来的内容规则核对。大序列的同步回执带回灯具编号、属性名称和效果标记，单 Cue 的详细数值仍可按需读取。回归见 `ma2-timecode-xml.test.ts` 和 `ma2-layout-service.test.ts`。MA2 以 `macro_text` 保存的 Cue 命令由 `ma2-cue-attributes.test.ts` 检查，含命令的 Cue 保留。

多个客户端共用控台时，控台确认还没接收请求，工作台才会排队。控台用固定长度的回执关联当时的 Show。长中文名称的节目与短名称走同一流程。轮到本次请求时，控台再次核对当前 Show 与组件会话，确认一致才开始。由 `ma2-bridge-lanes.test.ts` 和 `ma2-network-wire.test.ts` 验证。

时间线已经写成后，如果后续单独读取确认时通道被占用，同一次同步会保留写入回执和备份，只排队读取结果。网络控台在等待后重新核对 Show。换了 Show、读取已发送但结果未知、读回与修改不符时保留备份供核对。回归见 `ma2-apply-service.test.ts`。

本机请求队列已满时，会告知同步器这笔请求尚未提交。在排队时取消某次操作，或正常取消已开始的后台读取，下一笔同步保留自己的位置。控台支持写入回执时，写入前用实际备份和刚导出的序列核对整份快照。写入后再导出实际时间线和引用的序列。现场换了引用时重新读取实际对象。只要控台已确认执行 Import，后续读回出错也要保留备份并核对结果，避免重复写入。回归见 `ma2-bridge-lanes.test.ts`、`ma2-bridge-lua.test.ts`、`ma2-apply-service.test.ts`。

写完时间线后的回读、MIDI 选曲检查共用同一条等待规则。控台请求明确尚未提交且队列已满时，在同一次同步里等待一个位置。选曲流程保留已完成的步骤、已取得的备份和已读的 Show 身份，等到位置后继续当前步骤。操作取消、开始播放或换 Show 时重新检查条件。回执未知的写入保留给读回核对。回归见 `ma2-apply-service.test.ts`、`ma2-mtc-selection.test.ts`。

旧版请求记录可能属于仍在使用的另一份联动台。新版从自己的进程标记确认请求归属，旧版记录即使只写了一半，也能继续连接。回归见 `ma2-request-journal.test.ts`。

两份联动台同时使用同一台控台时，每份只释放本进程的遗留请求，或已确认退出的进程留下的请求。旧记录没有进程身份时由控台租约到期释放。首次读取遇到另一份软件正在读取或升级组件，在同一 Show 中等待；另一份已装好相同版本时直接使用。切换 Show、断开连接或开始播放时重新核对连接状态。写入回执丢失仍须读回核对。回归见 `ma2-request-journal.test.ts`、`ma2-network-wire.test.ts` 和 `ma2-bridge-lua.test.ts`。

现场素材只选一条 Cue 且只取该步保存的值时，桥接插件按序列号和小数 Cue 号直接导出原生 Cue 两次，核对 Show、编号和内容。选择包含前面继承的值时仍由控台计算 Tracking。同步前的本机存档确认数据与索引写好后即可继续，用户打开存档列表时再读取目录。回归见 `ma2-bridge-lua.test.ts` 和 `project-archives.test.ts`。

2026-11-19，已绑定歌曲沿用工程本次连接核实的 Show 和组件会话。控台在写入前比对原生时间线和所用序列，导入后重新导出。短时间线可以把这次完整读回放进写入回执。正在导入时碰到播放或取消，已经导入的操作继续完成读回。第一轨原来只有推杆时，在同一轨内补按钮子轨；其他时码槽原有的自动启动、状态追踪和停止方式原样保留。测试见 `ma2-apply-service.test.ts`、`ma2-bridge-lua.test.ts`、`ma2-event-write.test.ts`、`ma2-console-backups.test.ts`。

灯具数值通过 `ma2-cue-attributes.ts` 读取，节目内的修改随素材走现有第一轨或歌曲序列同步。明确选择修改原素材时才单独写入指定 Cue。两条路径使用 `tblink_bridge.lua` 中相同的按灯具、属性和 Part 匹配的数值修改逻辑。

同一个点改回此前确认过的值，可以再次引用原先为这个点保存的节目 Cue。单次复用时，对小于等于 4 MiB 的已保存 Cue 直接从控台导出这一条，将 Part、命令和灯具数据与上次确认的完整内容比较。内部步序号可随其他 Cue 的插入改变，显示编号和内容仍须一致。批量写入及更大的 Cue 继续用序列导出核对。回归见 `ma2-bridge-lua.test.ts`。

修改当前节目时，后台对这首歌的只读检查可在两次控台操作之间结束。同一批中重复引用第一轨上已有的一个 Cue 时，控台核对一次，每个触发位置分别写入。跨执行器复制、组合、属性筛选及空 Cue 各自保留写入记录。控台收到 Import 后重新导出，只有读回中完全相同的序列字节可从上一次确认的数据恢复。两端共同支持较短的传输格式时才使用。延迟从鼠标松开计到控台确认，记录在[现场规模验收](./LIGHTING_LIVE_AUDIT_20261119.md#正式模式的工作台与原生控台读回)。

已绑定歌曲的写入直接查询目标序列编号，写入后按同一编号确认。为临时复制检查的首选位置被占用时，才读取完整序列目录寻找空位。歌曲同步的回执只更新该曲序列的目录记录，其他素材及分类沿用上次完整读取。回归见 `ma2-layout-service.test.ts` 和 `ma2-cue-attributes.test.ts`。

2026-11-19，第一轨写入需要补收回执时，由 `tools/ma2/tblink_bridge.lua` 重新确认目标 Cue 的原生内容。控台在该 Cue 前面插入新 Cue 导致内部顺序变化时仍能认回，改过原 Cue 的内容或命令时则保留现场的修改并报告差异。由 `ma2-bridge-lua.test.ts` 和隔离 onPC 的组合 Cue 实测验证。跟踪值、空 Cue、播放与同步的现场检查见[直播灯光检查](./LIGHTING_LIVE_AUDIT_20261119.md)。

2026-11-18，已有歌曲移动 Cue 时，同次写后快照中能核实的 Go 触发设置交给选曲服务。歌曲区间、所用序列的触发方式或 Show 有变化时仍重新核对。工作台切歌或编辑当前歌曲后，正在进行的歌曲先完成读回，再按新顺序同步。当前歌曲在停止播放时，上次读回经过 300 毫秒即可在下一轮半秒检查中复查；控台同时编辑的等待间隔仍为 2 秒。由 `ma2-apply-service.test.ts`、`ma2-mtc-selection.test.ts` 和 `ma2-realtime-session.test.ts` 验证。

2026-11-18，0.5.16 现场修复。绑定时间线的写后选曲核对使用发起该次同步的连接目标，连接已更换时停止。某首歌失败后只由本曲编辑或操作员刷新唤起，其他歌曲读回和素材检查点不触发该曲重写。编辑提交直接唤起同一个逐首同步；一次写入未结束时接着改，等它完成后按最新修改再核对。周期核对询问 Show、版本和组件会话，来源改变时再取序列目录；遇到播放显示等待。单曲预览只查实际引用的序列，读不全不确认。普通连接逐项核对工程保存的时间线、素材目录并保留历史读取时间，手动更新仍完整读取。由 `ma2-network-manager.test.ts`、`ma2-bound-song-sync.test.ts`、`ma2-realtime-session.test.ts`、`ma2-editing-session.test.ts` 和 `ma2-read-recovery.test.ts` 验证。

2026-11-17 重启占用修复：`ma2-request-journal.ts` 在请求开始前把本端请求编号保存在本机，正常释放后移除。`ma2-network-manager.ts` 重新登录同一控台时读取并只释放这些编号；不重放读写或按键，不清除其他客户端请求。覆盖退出和 begin 回答丢失，避免重启后要等插件两分钟过期。`ma2-request-journal.test.ts`、`ma2-network-wire.test.ts` 验证持久归属、丢失回答后的释放以及未能保存记录时不发送。

方式 1、方式 2 和改名走同一个逐首同步、同一份状态（`runtime/ma2-song-sync.ts`、`stores/ma2-sync-store.ts`）

2026-11-17 同步速度回归：`ma2-layout-service.ts` 新增空 Cue 只上传空结构，导入已确认空闲的临时序列后在控台 Copy；同曲 Cue 参与组合时从本次写前导出取原内容，不从已部分改写的序列复制，也不上传整首数据。原内容备份、并发检查、未改 Cue 指纹和新增 Cue 内容核对保留。复查已确认序列和执行器均未变时复用该次执行器位置；已知 Timecode 编号只检查该对象是否存在，同次合并读回交给写入作为并发比较的基线，不再重复遍历目录和读取。`ma2-timecode-xml.ts` 的只读检查按完整 XML 复用解析结果，上限两份、合计 8 MiB 输入；大序列只留小的派生结果（编号/指纹各八份，属性/灯具各两份），返回独立对象，编辑始终独立解析，不缓存控台是否变化。`ma2-mtc-selection.ts` 复用同次同步刚确认的歌曲序列和 Timecode；只移动区间内的点不重建选曲，末点、静音、起始码或歌曲长度改变选择区间时仍更新。测试在 `ma2-layout-service.test.ts`、`ma2-timecode-xml.test.ts`、`ma2-mtc-selection.test.ts`。点击 Cue 的小于 3 px 指针抖动不作为拖动，避免吸附意外挪点，由 `WaveformCuePoints.test.ts` 守住。

2026-11-16 同步速度：`ma2-network-wire.ts` 在同一请求协议中处理批量响应和本机临时文件响应，只有明确的回环地址启用本机文件，远程仍按网络传输；请求身份、完整长度、写入后读回确认都保留。`ma2-layout-service.ts` 新建序列原生复制不再重复下载来源，目标完整读回负责发现来源在复制期间变化。`ma2-network-wire.test.ts`、`ma2-bridge-lua.test.ts`、`ma2-layout-service.test.ts` 守着；实际速度和协议见 `tools/ma2/README.md`。

2026-11-16：控台时间线页的新建与“将当前编排写入控台”调用 `syncMa2Once(itemId)`，手动只处理当前歌曲，失败后重试不添加 Cue；实时同步开启时仍逐首处理工程。每次写入读取歌曲中已编辑的位置，不经过初始间隔展开。`ma2-realtime-session.test.ts` 守住指定歌曲的范围，`packages/core/src/ma2-song-sequence.test.ts` 守住编辑时间及重复读回不增加点。

本机 onPC 3.7 实测修复：Lua 的 `assert(value, message)` 成功时返回两个值，不能嵌在 MA 原生 `getobj.amount` 的参数中。`tools/ma2/tblink_bridge.lua` 先取 Timecode 池句柄，再单参数枚举，避免连接成功但 TCRANGES 失败、无法分配起始码。`ma2-bridge-lua.test.ts` 校验原生参数个数；`ma2-hardware.test.ts` 的只读诊断实测目录与占用区间编号一致。

2026-11-16：原自有序列请求返回时若歌曲已改为其他控台时间线，不把旧序列重新挂回；等待存档后执行工程命令时也校验，撤销历史不为已关联歌曲重新补自有序列。手动“同步一次”只有本次读回确认或明确失败、暂停才结束，断线等待不因尝试过就结束。测试：`runtime/ma2-realtime-session.test.ts`。

2026-11-16 本机 onPC 连接链路修复：设置里的“本机 onPC”是明确选择本机地址 127.0.0.1，经 `stores/ma2-connection-store.ts` 的 `connectLocalMa2` 使用现有网络管理器登录并核对设备类型和版本，成功后保存为网络连接；不再用只检查文件插件、却进不了逐首同步的连接入口。复用本机已保存的登录，失败不搜索或改连其他控台。需要 onPC 已开启 Telnet（Login Enabled），不需要网线。设置页和顶部一键连接都只登录。操作员点读取时才调用 `runtime/ma2-editing-session.ts` 的 `prepareMa2Editing`，依次读取、按起始码导入 Cue、准备素材。测试：`stores/ma2-connection-store.test.ts`、`view-models/connect-devices.test.ts`、`runtime/ma2-editing-session.test.ts`。

2026-11-14：新歌写入位置统一取 `ma2-song-sync.ts` 的 `ma2SongSyncSettings`，两个界面入口共用 `Ma2SongDestination.tsx` 保存工程里的按钮页和起始序列编号。同步等待的原因由 `prepareMa2RealtimeSession` 给出，不能无提示返回；手动同步也展示原因及控台确认后的实际序列、Timecode 和按钮位置。测试：`ma2-realtime-session.test.ts`、`apps/desktop/test-e2e/editor-transport.browser.spec.ts`。

歌曲序列在中间插入 Cue 后，MA2 会同步调整关联 Timecode 的 Goto 步号。按写入前后读到的序列，用 Cue 编号核对这些变化，再按控台的最新原文写入。触发时间、执行器、目标 Cue 或其他节目内容被现场编辑时重新合并。序列确认到时间线确认之间记录点位与编号，重开后从该位置继续。由 `apps/desktop/src/main/link/ma2-song-timecode.test.ts` 和 `apps/desktop/src/main/link/ma2-layout-service.test.ts` 守着。

## 执行器按键和推杆走哪条通道

`apps/desktop/src/main/link/ma2-executor-channel.ts`（2026-11-11）：推杆和推杆页的按键走网页遥控；执行器页 Button 区（101–190）的按键默认走控台插件，和 0.5.8 一样，这时对控台不多连、不多读。操作员在 Button 栏的小菜单里选了网页遥控（每台电脑记住，`runtime/ma2-realtime-preference.ts`）才去试读 Button 区，读回的格号和请求的一致才走网页遥控，否则照旧走插件并写明原因；1–90 和 191 以后的按键一直走插件。通道只因为操作员改选择或重新连接而变，出错不换，演出中也一样（`ma2-channel-rules.test.ts` 守着）。两条通道上松开都会取消还在路上的按下。别处不再自己判断按键走哪条

## 控台页显示什么、能做什么

`apps/desktop/src/renderer/src/link/view-models/ma2-console-page.ts`（2026-11-11）：页结构、网页遥控读回、节目状态和时间码在用的执行器合起来，定每一格显示什么、能不能操作。能不能操作一律问 `showGate`：按键任何时候都能按，改执行器、刷新页面在时间码走的时候等；节目不在停着时横幅一直在。在跑和当前 Cue 只信读回，3 秒没读到新的就算旧的。Button 区的实时状态只在按键走网页遥控时经 `Ma2LiveService.buttonLive` 读（`buttonRead` 的 1 秒缓存、`peek`，只读有执行器的行，窗口在后台不读，不为它登录）；推杆区只在这次运行里点过「连接网页遥控」以后读，没点就对控台什么都不多连。按键先显示按下，失败只红这一格、不重发（`stores/ma2-key-feedback-store.ts`）；推杆 1.5 秒没读回只标黄、照常发。等节目的请求在运行日志里记成等待，不记错误（`link-main.ts` 的 `recordMa2Failure`）

## 网页遥控断了自动重新登录

`apps/desktop/src/main/link/ma2-web-remote-relogin.ts`（2026-11-12）：控台页推杆区和 Button 区两条网页遥控连接，这次运行里连上过、又自己断了的才重新登录，只用存过的用户；等多久和上限只在 `output-recovery.ts`（`MA2_RELOGIN_DELAYS_MS`、`ma2.webRemote.relogin`），节奏和停下的规矩和控台那条线共用 `ma2-relogin.ts`（见下一行）。控台拒绝登录、没存用户、安全存储打不开、Show 变了马上停并写明原因；手动连接让路并清零，换控台或 Show、按键改回控台插件就停；不重发按键和推杆值、不改按键通道、不重新试读 Button 区，“控台在不在跟”那条连接不碰。重新登录期间页脚和格子标黄写第几次，到上限或要人处理才标红；界面只每秒问主进程 `link:ma2-web-remote-state`，自己不重试、不登录（`ma2-web-remote-relogin.test.ts` 守着）

## 演出中控台连接断了自动重新登录

`apps/desktop/src/main/link/ma2-network-manager.ts` 的 `loginOnly`（2026-11-12）：节目不在停着时，联动台和控台之间那条 Telnet 线自己断了，用保存的登录重新登；只登操作员这次运行连上、没自己断开的那台控台。节奏和停下的规矩只在 `ma2-relogin.ts`，网页遥控的两条连接也用它；等多久、上限只在 `output-recovery.ts`（`MA2_RELOGIN_DELAYS_MS`、`ma2.relogin`，一次断线 5 分钟）。登上以后只做登录、释放上次断线留下的插件请求和两条短核对（Show 变没变、插件在不在），不读控台、不同步；演出中不装插件，插件不见了或是旧的记成等待，停了再装（`installDeferred`），这期间关灯和网页遥控照常，走插件的按键、同步和读取等着。控台没开远程登录、保存的密码读不出来、控台软件版本或 Show 变了马上停并写明原因；登录只是没等到回应就接着试（控台可能还在启动）。演出中操作员点连接只限这台控台、只登录，盖过自动的、次数清零；换控台、改连接设置照旧等停止。停着时断了照旧按原来的办法恢复。重新登录时状态标黄写第几次，到上限或要人处理才标红（`view-models/connection-status.ts` 的 `ma2NetworkWaitStatus`），每次都记运行日志。别处不再自己重连控台（`ma2-network-relogin.test.ts` 和 `output-rules.test.ts` 规则 6 守着）

## 欠着的关灯

操作员手动登录后，在首次启用读取之前保留待补发的关灯。已经启用读取的会话在演出中自动恢复后仍按原规则处理。

节目、试听或 P1 接管执行器后，上一首仍在排队的 Off 撤销。读取连接状态后和写入控台连接前均核对执行器及本次请求编号，只发送仍由原节目负责的关灯请求。这个顺序由 `apps/desktop/src/main/link/lighting-off-service.test.ts` 的切歌排队用例覆盖。

2026-11-19 用户指定工作台两个停止按钮都要停整台控台。手动指令经 ma2-audition-service.ts 取消试听队列，ma2-pool-playback.ts 按停止优先级停止时间码、序列和各页在跑的执行器，回读后返回。自动结束、换歌和其他工作区沿用下面的关灯规则。

规则在 `packages/core/src/lighting-off-ledger.ts`（2026-11-11）：停止关这首歌的执行器，换歌只关上一首独有的，正在用的绝不关。全应用一张清单，主人是主进程 `apps/desktop/src/main/link/lighting-off-service.ts`：节目、试听（`link:lighting-off`）、退出时的询问和演出状态都经它；没发出去的留着，控台重新连上后补发 1 次（次数在 `output-recovery.ts`），再按停止全部重发；关灯不过授权。控台确认以后按轮读回灯关了没有（2026-11-11）：只在已经连着的网页遥控会话上读，1–90 只用“控台在不在跟”那条会话，Button 区只在按键选了网页遥控时用 Button 会话，不在推杆页自己的会话上读，不为读回登录；等几秒、读几次只写在 `output-recovery.ts` 的 `LIGHTING_OFF_READ_BACK`；还在运行的标黄不标红，再按停止才重发，没读的不写日志、界面照旧。同一条网页遥控会话上的请求排队轮流发（`ma2-live-playback.ts` 的 `turn`），借别人的会话读只用 `peek`、`peekButtons`：看不懂的回答不关会话。别处不再自己发 Off、不另记“还欠着”

## 整套 Cue 的首次放置

2026-11-17：首次从素材放入一个控台 Cue（2026-11-19）或整套序列经 `packages/core/src/ma2-new-timeline.ts` 的 `addMa2SequenceCommand` 同时保留完整编排并预留控台目标，调用现有 `syncMa2Once(itemId)`；已有绑定不换位置。目标占用仍在同一新建分配规则内顺延，MTC 仍由逐首同步分配。素材点击和拖入都传入歌曲实际拍点，后续同步只取已编辑的 Cue 时间。`ma2-new-timeline.test.ts` 与 `lighting-sequence-placement.test.ts` 覆盖首次创建、重复添加、撤销、时间保留和真实入口触发同步。

`packages/core/src/lighting-template-steps.ts` 统一展开整套序列，默认每步 1 拍；用户编辑后不再经过这个展开步骤。素材组合保留成员已编辑的相对时间。`apps/desktop/src/renderer/src/link/components/lighting-sequence-placement.test.ts` 检查完整展开、组合时间、逐步编辑和歌曲范围。

## 轨道是否参与灯光

onPC 原生轨道的播放箭头读写 `Track.muted`，省略表示参与播放。同步保留独立的 `active` 编辑选择。核对歌曲执行器分配时检查所有参与播放的轨道；用于选歌的辅助轨必须能够播放。已有工程的旧轨道基线仍可用来合并，控台本次读回按播放箭头判断。`ma2-timecode-conversion.test.ts`、`ma2-mtc-selection.test.ts` 和 `ma2-bridge-lua.test.ts` 覆盖这些读写。

`packages/core/src/lighting-track-state.ts` 统一判断轨道静音与独奏；新歌保留禁用的 Cue 内容，只取消触发，已有时间线使用同一判断。`packages/core/src/ma2-song-sequence.test.ts` 与 `apps/desktop/src/main/link/ma2-layout-service.test.ts` 检查禁用、恢复和读回。

## 新增轨道写到哪里

工作台拖入控台 Cue 会核对实际写入的执行器。同一素材、复制范围和时间已存在于同一位置时沿用已有点。移动或添加点只检查这次涉及的冲突，独奏和静音遵循轨道参与规则。原时间线上的第一轨和控台保留的并行轨分开判断。一个组合内可以把同一执行器上的两份素材合为一个 Cue。两个独立点真的竞争同一执行器时，提示列出时间、执行器或序列、两步动作。相关回归见 `packages/core/src/lighting-cue-placement.test.ts` 和 `packages/core/src/lighting-music.test.ts`。

复制范围由操作员选择。每份素材可以只复制本步写入的灯光，也可以带上从前面步骤继承的灯光。两者分别使用 MA2 原生命令的 `/status=false` 和 `/status=true`。写回时逐份使用同一顺序，按控台回读核对灯具内容。成员的选择随工程和收藏保存。新节目的延迟素材写在对应时间的下一点，已确认点再次编辑可看到原来使用的来源。原序列丢失、需要从已确认的完整快照恢复继承值时，由控台在未分配给执行器的临时序列计算。`packages/core/src/ma2-song-sequence.test.ts` 和 `packages/core/src/ma2-track-routing.test.ts` 验证组内次序、时间及来源保留。

2026-11-19 现场修订。原 Timecode 有轨道时，工作台新增点进入第一轨。firstTrackCuePlan 确定新增点，FIRSTCUES 在控台核对第一轨与实际分配，在原序列末尾创建空 Cue 或复制来源，返回实际编号。素材已在目标序列时直接引用。applyFirstTrackCues 保留时间与点位身份，触发由现有 Timecode 合并流程写回。下面的独立分配适用于还没有原轨的情况。 同一个点里同时亮的素材合成一个 Cue，原素材保留。

2026-11-19，`ma2-track-routing.ts` 收集原时间线上的空 Cue，逐首同步通过原有歌曲序列写入流程确认实际 Cue 和执行器，再通过同一时间线写入流程提交触发。只有原生序列和 Timecode 都读回后才确认。本曲下次打点继续引用已确认的 Cue。更换组合里的执行器时，实际触发随素材进入对应的轨道。`ma2-track-routing.test.ts` 和 `lighting-cue-composer.test.ts` 检查连续打点与跨执行器替换。

`packages/core/src/ma2-track-routing.ts` 决定已有绑定内新增轨道的去向，唯一目标登记待写入。在一条已关联时间线上首次放入仅有序列号和 Cue 号的控台素材时，逐首同步通过 ASSIGNSEQ 在工程专用页复用或分配空执行器，读回实际序列和名称后再写入该时间线；旧工程中尚未写出的素材沿用同一流程。多个目标或缺少可识别的 Cue 时明确提示。无需分配时返回原灯光对象，实时同步省去整首灯光数据的复制和比较。`packages/core/src/ma2-track-routing.test.ts` 检查归属与未同步统计。

未关联轨道没有 Timecode 归属，不能伪造为第一条绑定的差异。`ma2PendingChanges` 只比较已绑定内容；`ma2TrackRoutingIssue` 在歌曲状态和同步前置检查中说明未关联轨道，仍阻止把遗漏的 Cue 确认为已同步。`ma2-pending-changes.test.ts`、`song-lighting-status.test.ts` 和 `runtime/ma2-bound-song-sync.test.ts` 守住计数不重复、问题可见、未关联内容不误确认。

## 灯光编号换新

`packages/core/src/lighting-ids.ts` 的 `withNewLightingIds`（2026-11-12）：复制歌曲、把灯光导入空白歌曲、追加导入都经同一张编号表换新，轨道、片段、点、组合、标记、段落、控台绑定和基线、控台点一起换，引用跟着换；素材库模板和素材引用不换。配对、待同步和 MTC 区间提示和换之前一样（`lighting-ids.test.ts` 守着）

## 控台连接插件任务的生命周期（2026-11-16）

网络桥空闲时不启动常驻 Lua 定时任务。只有按住 Flash、Temp、Swop 等需要断线自动松开的按键时，`tools/ma2/tblink_bridge.lua` 才启动单次看门任务；有按键仍按住才继续下一次，松开、租约过期、桥换代或停止时释放按键并退出。文件桥的请求轮询同样使用单次任务，停止或换代后不续行。正常的 Go/Goto、同步和读取不新增常驻任务。旧版无限任务的现场清理由诊断确认目标后单独处理，自动连接流程不发送全局 Off、Off Plugin 或 ReloadPlugins，不能影响其他插件。测试：`apps/desktop/src/main/link/ma2-bridge-timers.test.ts`。

## MIDI 选曲隔离

2026-11-25 起，点击登录、读取目录和「用控台上的」均保留现有选曲设置。操作员明确执行写入或同步时才会准备选曲。过程见 [灯光工作流](./LIGHTING_WORKFLOW.md)。

核对选曲时也逐步核对原生选曲表里启动的时间线和启动位置。已清空、删除或移走的歌曲不可留有启动步骤。`tools/ma2/tblink_bridge.lua` 在读取时间范围时一并核对各时码槽有事件的轨道与自有选曲执行器的实际地址。发现其他时间线直接调用该执行器时，同步详情列出具体的时间线、轨号和格位。操作员可以关闭这一轨的播放。如该时间线正在原生控台播放或录制，须先停止这条时间线。写入前复核来源、分配和旧轨数据，控台备份该时间线，写入后比对整条时间线并复核调用关系。新安装选曲器时避开已经被有事件的轨道引用的格位。上述检查随手动同步运行。回归见 `apps/desktop/src/main/link/ma2-mtc-selection.test.ts`、`apps/desktop/src/main/link/ma2-song-executor.test.ts`。

选曲执行器属于原生 Show，联动台退出后，外部 MTC 仍可启动它。手动同步当前节目和重建选曲表时都核对实际分配的执行器。若它开了 Chaser 或禁用了 Cmd，`apps/desktop/src/main/link/ma2-selector-executor.ts` 核对 Show、连接会话、时间线和序列的所有权标记、轨道地址和执行器分配。更改前导出原执行器，恢复为普通 Cue 列表并启用命令，随后核对控台导出。用户其他执行器保留自己的追逐设置。回归见 `apps/desktop/src/main/link/ma2-mtc-selection.test.ts`。

2026-11-23，已实测同槽歌曲的结束续跑。选曲、手动同步、起始码输入和保存前复核共用 `packages/core/src/ma2-mtc-selection.ts` 的间隔规则。按接收槽 AfterRoll 加半秒再向上取整秒，操作员须调整间隔不足的时段，正常播放开始时复用最近确认的时段检查。由 `packages/core/src/ma2-mtc-selection.test.ts` 和 `packages/core/src/program-start.test.ts` 核对。

播放时读取执行器之前和收到回执以后，都按播放器的当前位置确认本次要核对的灯光点。读取期间已经换步、停发时码或播过控台时间线末尾，上一点的回执不能证明当前的灯光状态。回归见 `apps/desktop/src/renderer/src/link/runtime/console-follow-monitor.test.ts`。

手动同步先读控台目录，再单独读选曲时间线与选曲序列。判断本曲可以跟随时，按后一次原生时间线的实际起点、时码槽和播放设置核对。目录读取后这些值仍可能被控台修改。回归见 `apps/desktop/src/main/link/ma2-mtc-selection.test.ts`。

修改歌曲起点或整首同步后，后续的选曲准备使用同一请求的 Show、连接会话和控台版本。在同一 Show 内重建公共选曲表时，从控台重新取得各歌曲当前的起点与终点。上次的时段只用于缩小需要复核播放设置的歌曲范围。控台上独立移过的歌曲也按新位置选曲。写完选曲表后重新核对控台上各歌曲的选曲边界。如果操作期间边界发生变化，在同一 Show 内按最新边界重算一次；重算期间再次变化时返回未确认，保留已写入的歌曲，待操作员再次同步。空闲时不扫描。由 `ma2-network-manager.test.ts`、`ma2-mtc-selection.test.ts` 验证。

首次核对发现没有歌曲使用 TC Slot 2 时，也保留这次按 Show 和组件会话确认的区间。单曲写后读回表明它仍在原来的其他时码槽时，移动它的 Cue 不会改变选曲器。移入或移出 Slot 2、切换 Show、会话更换，以及主动重新连接时仍走原有核对。由 `ma2-mtc-selection.test.ts` 验证。

2026-11-18，0.5.16 现场修复。明确连接仍做选曲核对。第二次导出时间线时，可识别且播放属性已就绪的时间线只回传当前区间与序列引用。其他时间线取完整 XML；修改、备份及序列触发的读回照常执行。辅助选曲 XML 传输中重复的标签和编号列表只传一份，在控台原样还原后比较和写入。`ma2-mtc-selection.test.ts` 覆盖重复连接和无损还原。

2026-11-18 现场再次反馈后的补充：SEQGO 对 CueDatas 按原始字节块读取比较，外围元数据解析与完整比较分批执行；`ma2-network-wire.ts` 仅接受 SEQGO 的只读确认阶段标志，已经写入后继续读回，不重发 Assign。MA 内部协程短暂停顿合并到有处理量和时间上限的批次；取消、失败和释放关闭扫描文件。`ma2-sequence-trigger-read.test.ts`、`ma2-network-wire.test.ts` 覆盖密集灯具、4096 Cue、标签跨块、内部暂停、取消前后、非法阶段标志和文件关闭。实际耗时见专项记录。

2026-11-18 连接读取回退修复：`ma2-mtc-selection.ts` 不再为检查歌曲触发方式通过网络取回完整 Sequence。`tools/ma2/tblink_bridge.lua` 的 SEQGO 在控台内流式读取完整导出，确认编号，第二次导出比较；需要修改时保留原完整备份、原位 Assign Trigger、再次导出逐字比较除直接 Cue Trigger 和导出时间戳外的内容，只返回是否修改与 Cue 数。每次明确连接重新核对，同次共用序列去重，不缓存跨次的“已确认”。手动同步也检查当前节目引用序列的原生 Cue 触发方式。控台改为 Follow 或 Time 后，即使时间线上没有改点，也要在写前再次确认当前歌曲仍引用该序列，只修其触发方式并读回。准备任务复用 `ma2ReadProgress` 和取消通道，切换工程取消，任何退出都释放任务。`ma2-sequence-trigger-read.test.ts`、`ma2-mtc-selection.test.ts`、`runtime/ma2-editing-session.test.ts` 覆盖大序列、30 条时间线、并发变动和取消；实体 3.3.4.3 验收仍与本机 3.7 分开记录。

2026-11-17 本机联调补充：重写辅助选曲序列的全部 Cue 时，onPC 会解除原执行器关联。因此执行器位置必须在序列写入并读回后重新检查，不能沿用写入前的“已分配”判断；否则辅助时间线的 Object 引用变空，读回校验失败且歌曲不会按 MTC 启动。由 `ma2-mtc-selection.ts` 复用原执行器分配规则处理，`ma2-mtc-selection.test.ts` 模拟清空后解除关联并检查重新分配。

2026-11-17：用户要求播放继续使用 MIDI MTC，只运行当前歌曲，前后定位和共用执行器切歌不串灯。时间区间及原生选曲命令只在 `packages/core/src/ma2-mtc-selection.ts` 编译；辅助 Timecode/Sequence 的创建、备份、复用、读回只在 `apps/desktop/src/main/link/ma2-mtc-selection.ts`。明确连接编辑与两种歌曲同步共用这个服务，播放端不发送网络选曲或逐 Cue 命令。内部目录保留占用编号，但不参与配对、歌曲列表或素材试听。完整规则见 LIGHTING_WORKFLOW.md「2026-11-17 MIDI 播放只选择当前歌曲」。测试由 `packages/core/src/ma2-mtc-selection.test.ts`、`apps/desktop/src/main/link/ma2-mtc-selection.test.ts`、`apps/desktop/src/main/link/ma2-bridge-lua.test.ts` 守住。
