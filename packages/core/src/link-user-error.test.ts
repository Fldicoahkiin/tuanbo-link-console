import { expect, it } from 'vitest';
import { toUserErrorMessage } from './link-user-error';
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
