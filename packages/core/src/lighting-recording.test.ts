import { expect, it } from 'vitest';
import { LightingRecorder } from './lighting-recording';

const msc = (command: number, data: string): number[] => [0xf0, 0x7f, 0x7f, 2, 1, command, ...[...data].map((char) => char.charCodeAt(0)), 0xf7];
it('保留输入音符的释放力度，录制中断不伪造释放数据', () => {
  const recorder = new LightingRecorder(1, 10000);
  recorder.receive([0x90, 60, 90], 0);
  recorder.receive([0x80, 60, 71], 1000);
  recorder.receive([0x90, 62, 91], 2000);
  const events = recorder.finish(3000);
  expect(events[0]).toMatchObject({ velocity: 90, releaseVelocity: 71, duration: 1000 });
  expect(events[1]).toMatchObject({ note: 62, velocity: 91, duration: 1000 });
  expect(events[1]).not.toHaveProperty('releaseVelocity');
});
it('暂停和定位结束正在录制的音符，不将空白跨度算进音长', () => {
  const recorder = new LightingRecorder(1, 10000);
  recorder.receive([0x90, 60, 100], 1000);
  recorder.advance(2000);
  recorder.interrupt(2000);
  recorder.receive([0x80, 60, 0], 7000);
  recorder.receive([0x90, 62, 100], 7500);
  recorder.advance(8000);
  recorder.interrupt(8000);
  recorder.advance(500);
  expect(recorder.finish(1000)).toEqual([
    expect.objectContaining({ note: 60, at: 1000, duration: 1000 }),
    expect.objectContaining({ note: 62, at: 7500, duration: 500 })
  ]);
});
it('无后续 MIDI 消息时仍按音乐位置推进，并在音频结尾收住长音符', () => {
  const recorder = new LightingRecorder(1, 10000);
  recorder.receive([0x90, 60, 100], 7000);
  recorder.advance(9000);
  expect(recorder.finish(1000)[0]).toMatchObject({ at: 7000, duration: 2000 });
  recorder.receive([0x90, 62, 100], 5000);
  recorder.advance(11000);
  expect(recorder.finish(11000)[0]).toMatchObject({ at: 5000, duration: 5000 });
});
it('MA2 反馈按已知执行器绑定录成 Cue，保持小数编号和音乐时间', () => {
  const recorder = new LightingRecorder(1, 10000, [{ executor: '1.5', sequence: 23 }]);
  recorder.receive(msc(1, '37.200\0' + '5.1'), 1250);
  recorder.receive(msc(0x0b, '0.000\0' + '5\0' + '1'), 2500);
  const events = recorder.finish(3000);
  expect(events).toEqual([
    expect.objectContaining({ kind: 'ma2', at: 1250, executor: '1.5', sequence: 23, cue: '37.200', action: 'goto' }),
    expect.objectContaining({ kind: 'ma2', at: 2500, executor: '1.5', action: 'off', label: '关闭执行器 1.5' })
  ]);
  expect(events[1]).not.toHaveProperty('cue');
  expect(events[1]).not.toHaveProperty('sequence');
});
it('未知执行器、冲突绑定、默认执行器及未支持指令保留完整原始消息', () => {
  const recorder = new LightingRecorder(1, 10000, [{ executor: '1.5', sequence: 1 }, { executor: '1.5', sequence: 2 }]);
  const messages = [msc(1, '1.000\0' + '5.1'), msc(1, '1.000\0' + '9.1'), msc(1, '1.000'), msc(2, '0.000\0' + '5.1')];
  messages.forEach((bytes, index) => recorder.receive(bytes, index * 100));
  const events = recorder.finish(1000);
  expect(events.map((event) => event.kind === 'raw' ? event.bytes : null)).toEqual(messages);
});
it('不把损坏的 MSC 反馈解码成看似有效的灯光点', () => {
  const recorder = new LightingRecorder(1, 1000, [{ executor: '1.5', sequence: 23 }]);
  expect(() => recorder.receive(msc(1, '1.000\0' + '5.1').slice(0, -1), 100)).toThrow();
  expect(recorder.finish(200)).toEqual([]);
});

it('录制保持长音符、通道过滤并在停止时结束未释放音符', () => {
  const recorder = new LightingRecorder(2, 10000);
  recorder.receive([0x90, 64, 90], 50);
  recorder.receive([0x91, 60, 100], 100);
  recorder.receive([0xb1, 7, 99], 500);
  const events = recorder.finish(5000);
  expect(events).toHaveLength(2);
  expect(events[0]).toMatchObject({ kind: 'note', at: 100, duration: 4900, velocity: 100 });
  expect(events[1]).toMatchObject({ kind: 'cc', at: 500, value: 99 });
  expect(recorder.finish(6000)).toEqual([]);
});
it('循环回跳将未结束音符留在前一段，不跨越回跳点', () => {
  const recorder = new LightingRecorder(1, 10000);
  recorder.receive([0x90, 60, 100], 7000);
  recorder.receive([0xb0, 7, 100], 8000);
  recorder.receive([0x90, 62, 90], 1000);
  const events = recorder.finish(2000);
  expect(events.filter((event) => event.kind === 'note')).toEqual([
    expect.objectContaining({ at: 1000, duration: 1000, note: 62 }),
    expect.objectContaining({ at: 7000, duration: 1000, note: 60 })
  ]);
});
