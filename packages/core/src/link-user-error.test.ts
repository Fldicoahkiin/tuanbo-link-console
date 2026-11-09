import { expect, it } from 'vitest';
import { toUserErrorMessage, toUserErrorReason } from './link-user-error';
it('OBS 密码与配置错误直接说明原因，而非要求先导出诊断', () => {
  expect(toUserErrorMessage(new Error('OBS WebSocket 连接失败：Authentication failed'))).toContain('OBS 需要密码，或者密码不对');
  expect(toUserErrorMessage(new Error('连接配置校验失败：profile.obs.webSocketUrl：Invalid URL'))).toContain('profile.obs.webSocketUrl');
});
it('OBS 来源缺失时不把包含中文场景名的英文异常直接展示', () => {
  expect(toUserErrorMessage("SetCurrentProgramScene: No source was found by the name of '团播联动台·叠加·123' within the canvas 'Main'.")).toBe('OBS 中找不到需要的场景或来源。请重新同步素材后再播放。');
});
it('跨隔离上下文传来的异常保留中文原因，不依赖 Error 原型', () => {
  expect(toUserErrorMessage({ message: "Error invoking remote method 'link:midi-recheck': Error: MIDI 设备检测未通过" })).toBe('MIDI 设备检测未通过');
});
it('中文处理说明中的 Windows 不能被误判为系统错误代码', () => {
  const message = 'MIDI 设备检测未通过。请检查 Windows MIDI 服务和设备连接，再到“音频与 MIDI”重新检测。';
  expect(toUserErrorMessage(new Error(message))).toBe(message);
  expect(toUserErrorMessage(new Error('操作失败 UNKNOWN_NATIVE_CODE'))).toContain('操作未能完成');
});
it('移除 Electron 包装和英文异常前缀，保留明确中文原因', () => {
  expect(toUserErrorMessage(new Error("Error invoking remote method 'link:ma2-connect': Error: 控台远程登录未开启"))).toBe('控台远程登录未开启');
});
it('原始系统异常与未知英文错误转为可读中文', () => {
  expect(toUserErrorMessage(new Error('connect ECONNREFUSED'))).toContain('连不上目标设备');
  expect(toUserErrorMessage(new Error('Something unexpected happened'))).toContain('操作未能完成');
});
it('音频线路丢失时不泄露设备 ID 或英文底层异常', () => {
  expect(toUserErrorMessage(new Error('AudioContext.setSinkId: failed: the device 12345 is not found'))).toBe('选择的音频输出设备已断开。请在音频输出设置里重新选择设备，或改用 Windows 默认设备。');
});
it('音频解码错误带底层错误码时仍说明音频问题，不退回笼统提示', () => {
  expect(toUserErrorMessage(new Error('音频解码或读取失败：DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer')))
    .toBe('无法读取这个音频。请检查文件是否损坏、格式是否支持，换一个音频文件后重新播放。');
});
it('无法归类的异常显示原文第一行，重复翻译不叠加前缀', () => {
  // 2026-10-16 现场：播放准备失败的原文，第二行起是 FFmpeg 的英文输出。
  const raw = "Error invoking remote method 'link:obs-media-scenes-prepare': Error: FFmpeg 生成编辑代理失败（退出码 4294967274）：[ffv1 @ 000001794eaed500] Specified pixel format argb is not supported by the ffv1 encoder.\n[vost#0:0/ffv1 @ 000001794eaed000] Error while opening encoder";
  const message = toUserErrorMessage(new Error(raw));
  expect(message).toBe('操作未能完成：FFmpeg 生成编辑代理失败（退出码 4294967274）：[ffv1 @ 000001794eaed500] Specified pixel format argb is not supported by the ffv1 encoder.');
  expect(toUserErrorMessage(new Error(message))).toBe(message);
});
it('文件不存在时指出具体路径或程序', () => {
  expect(toUserErrorMessage(new Error("ENOENT: no such file or directory, stat 'D:\\工程\\assets\\reference-audio\\a.wav'")))
    .toBe('所需文件或程序不存在：D:\\工程\\assets\\reference-audio\\a.wav。请重新选择正确的位置后再试。');
  const spawn = toUserErrorMessage(new Error('素材没有可解码的音轨：D:\\x.mp4：FFmpeg 启动失败：spawn C:\\Program Files\\ffmpeg.exe ENOENT'));
  expect(spawn).toBe('所需文件或程序不存在：C:\\Program Files\\ffmpeg.exe。请重新选择正确的位置后再试。');
  expect(toUserErrorMessage(new Error(spawn))).toBe(spawn);
});
it('工程结构校验错误显示第一条问题，而不是 JSON 的第一行“[”', () => {
  // 2026-10-19 现场：打开工程失败只显示“操作未能完成：[”。
  const raw = "Error invoking remote method 'link:open-project': Error: [\n  {\n    \"code\": \"custom\",\n    \"message\": \"OBS 显示 Cue“显示来源”尚未分配视觉图层\",\n    \"path\": [\"rundown\", 1]\n  }\n]";
  expect(toUserErrorMessage(new Error(raw))).toBe('操作未能完成：OBS 显示 Cue“显示来源”尚未分配视觉图层（字段 rundown.1）');
});
it('只有“Invalid input”的校验错误同时写出被拒绝的字段，联合类型取外层字段', () => {
  // 2026-10-24 现场：灯光同步只显示“Invalid input”，看不出是哪一项。
  const refine = "Error invoking remote method 'link:ma2-sync-song': Error: [\n  {\n    \"code\": \"custom\",\n    \"path\": [\n      \"binding\",\n      \"executor\"\n    ],\n    \"message\": \"Invalid input\"\n  }\n]";
  expect(toUserErrorMessage(new Error(refine))).toBe('操作未能完成：Invalid input（字段 binding.executor）');
  const union = "Error: [\n  {\n    \"code\": \"invalid_union\",\n    \"errors\": [\n      [\n        {\n          \"code\": \"invalid_type\",\n          \"path\": [],\n          \"message\": \"Invalid input: expected string\"\n        }\n      ]\n    ],\n    \"path\": [\n      \"points\",\n      3\n    ],\n    \"message\": \"Invalid input\"\n  }\n]";
  expect(toUserErrorMessage(new Error(union))).toBe('操作未能完成：Invalid input（字段 points.3）');
});

// 修复前：关灯失败的红字把整句 toUserErrorMessage 当原因，这里自己加的下一步（“请检查目标程序……”）和“操作未能完成：”也跟了
// 进去，一句话里出现两个“怎么办”。只要原因时只给原因；整句照旧。
it('只要原因时不带这里自己加的下一步和“操作未能完成：”；整句照旧', () => {
  expect(toUserErrorReason(new Error('MA2 telnet timeout'))).toBe('操作超时了');
  expect(toUserErrorMessage(new Error('MA2 telnet timeout'))).toBe('操作超时了。请检查目标程序是否正常运行，处理后再试。');
  expect(toUserErrorReason(new Error('connect ECONNREFUSED 192.0.2.1:30000'))).toBe('连不上目标设备');
  expect(toUserErrorReason(new Error('Invalid URL'))).toBe('OBS 地址格式不正确');
  expect(toUserErrorMessage(new Error('Invalid URL'))).toBe('OBS 地址格式不正确，请填写完整地址，例如 ws://127.0.0.1:4455。');
  expect(toUserErrorReason(new Error("ENOENT: no such file or directory, stat 'D:\\a.wav'"))).toBe('所需文件或程序不存在：D:\\a.wav');
  expect(toUserErrorReason(new Error('socket hang up'))).toBe('socket hang up');
  expect(toUserErrorReason(new Error(toUserErrorMessage(new Error('socket hang up'))))).toBe('socket hang up');
  expect(toUserErrorReason(new Error("Error invoking remote method 'link:ma2-play-cue': Error: 关灯指令没有发送：控台连接变了"))).toBe('关灯指令没有发送：控台连接变了');
});

// 修复前：「」里的歌名也参加判断。歌名有 5 个以上连续大写字母（「HAPPY」）时，写好的中文提示被当成技术报错，前面多了
// “操作未能完成：”；歌名像英文报错（「Timeout」）时，整句被换成“操作超时了……”。
it('「」里的名字（歌名、接口名）不参加判断：写好的中文提示原样显示；名字以外的技术报错照旧换成日常说法', () => {
  for (const written of ['「HAPPY」的起始码改成了 MTC 01:00:00:00，但 Cue 没有换过来：原因见这条时间线',
    '「HAPPY」：同步失败，没有自动重试：控台上的时间线没有读回来。修改保留在本地，处理好后点“刷新同步”',
    '「Timeout」的起始码改成了 MTC 01:00:00:00，现在用 Timecode 3 跑灯', '「Fatal Error」的灯光没能完全关闭，控台上可能还亮着。原因：控台正忙。请在控台上关掉这首歌的执行器。',
    'MIDI 接口「USB MIDI INTERFACE」已断开，插回后会自动恢复']) {
    expect(toUserErrorMessage(new Error(written))).toBe(written);
    expect(toUserErrorReason(new Error(written))).toBe(written);
  }
  expect(toUserErrorMessage(new Error('「HAPPY」同步失败 UNKNOWN_NATIVE_CODE'))).toBe('操作未能完成：「HAPPY」同步失败 UNKNOWN_NATIVE_CODE');
  expect(toUserErrorMessage(new Error('「开场」：connect ECONNREFUSED 192.0.2.1:30000'))).toBe('连不上目标设备。请确认程序已经打开、连接服务已开启，并检查地址和端口。');
  expect(toUserErrorMessage(new Error('「HAPPY」没有播放：Exception in native module'))).toBe('操作未能完成：「HAPPY」没有播放：Exception in native module');
});
