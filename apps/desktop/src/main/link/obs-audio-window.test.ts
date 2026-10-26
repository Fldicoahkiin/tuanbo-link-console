import { describe, expect, it } from 'vitest';
import { selectObsAudioWindow } from './obs-audio-window';

describe('OBS 应用音频窗口', () => {
  it('多个开发实例只选当前标题，不匹配其他 Electron 应用', () => {
    const value = '团播联动台 · 123:Chrome_WidgetWin_1:electron.exe';
    expect(selectObsAudioWindow([
      { itemValue: '团播联动台 · 456:Chrome_WidgetWin_1:electron.exe' },
      { itemValue: '其他应用:Chrome_WidgetWin_1:electron.exe' },
      { itemValue: value, itemEnabled: true }
    ], 'Electron.exe', '团播联动台 · 123')).toBe(value);
  });
  it('按 OBS 转义规则解析冒号和井号，排除失效的历史候选', () => {
    const value = '团播#223A#3A测试:Chrome_WidgetWin_1:app.exe';
    expect(selectObsAudioWindow([{ itemValue: value, itemEnabled: false }, { itemValue: value, itemEnabled: true }], 'app.exe', '团播#3A:测试')).toBe(value);
    expect(() => selectObsAudioWindow([{ itemValue: value, itemEnabled: false }], 'app.exe', '团播#3A:测试')).toThrow('找不到联动台的音频窗口');
  });
  it('无法区分的相同窗口仍拒绝，不用去重掩盖两个真实窗口', () => {
    const item = { itemValue: 'app:Chrome_WidgetWin_1:app.exe' };
    expect(() => selectObsAudioWindow([item, item], 'app.exe', 'app')).toThrow('2 个同名');
    expect(() => selectObsAudioWindow([{ itemValue: 'app:extra:class:app.exe' }], 'app.exe', 'app')).toThrow('找不到联动台的音频窗口');
  });
});
