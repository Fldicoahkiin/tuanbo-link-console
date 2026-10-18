import { expect, it } from 'vitest';
import { toUserErrorMessage } from './link-user-error';
it('OBS 密码与配置错误直接说明原因，而非要求先导出诊断', () => {
  expect(toUserErrorMessage(new Error('OBS WebSocket 连接失败：Authentication failed'))).toContain('OBS 要求认证或拒绝了密码');
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
  expect(toUserErrorMessage(new Error('connect ECONNREFUSED'))).toContain('无法连接');
  expect(toUserErrorMessage(new Error('Something unexpected happened'))).toContain('操作未能完成');
});
it('音频线路丢失时不泄露设备 ID 或英文底层异常', () => {
  expect(toUserErrorMessage(new Error('AudioContext.setSinkId: failed: the device 12345 is not found'))).toBe('所选音频输出设备已断开。请在音频输出设置中选择当前设备或 Windows 默认设备。');
});
it('音频解码错误带底层错误码时仍说明音频问题，不退回笼统提示', () => {
  expect(toUserErrorMessage(new Error('音频解码或读取失败：DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer')))
    .toBe('无法读取或解码音频。请检查音频文件是否损坏、格式是否支持；修复或更换音频后重新播放。');
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
    .toBe('所需文件或程序不存在：D:\\工程\\assets\\reference-audio\\a.wav。请重新选择有效路径后重试。');
  const spawn = toUserErrorMessage(new Error('素材没有可解码的音轨：D:\\x.mp4：FFmpeg 启动失败：spawn C:\\Program Files\\ffmpeg.exe ENOENT'));
  expect(spawn).toBe('所需文件或程序不存在：C:\\Program Files\\ffmpeg.exe。请重新选择有效路径后重试。');
  expect(toUserErrorMessage(new Error(spawn))).toBe(spawn);
});
