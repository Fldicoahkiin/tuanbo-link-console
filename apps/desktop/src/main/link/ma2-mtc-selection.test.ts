import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ma2MtcSelectionCommand, ma2SongDirectory } from '@tb/core/link';
import { Ma2MtcSelectionService, ma2MtcSelectorCommands, ma2MtcSelectorSequence, ma2MtcSequenceSettings } from './ma2-mtc-selection';
import { inspectMa2TimecodeXml, ma2MtcPlaybackSettings } from './ma2-timecode-xml';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2NetworkWire } from './ma2-network-wire';
import { showRunning, showStopped } from './fixtures/show-gates';

const network = { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'test' };
const native = readFileSync(new URL('./fixtures/ma2-timecode-onpc-3.7-100.xml', import.meta.url), 'utf8');

it('时间线接管 Time/Follow 触发，保留灯具、渐变、延迟和命令', () => {
  const base = ma2MtcSelectorSequence(3, '3.7.0.5', ['Go Timecode 3', 'Off Timecode 3']);
  const xml = base.replace('<CuePart index="0">', '<Trigger type="Time" data_f="0.5"/><CuePart index="0" basic_fade="0.6" basic_delay="0.2">').replace('<Cue index="2">', '<Cue index="2"><Trigger type="Follow" data_f="2"/>');
  const result = ma2MtcSequenceSettings(xml);
  expect(result.cues).toEqual(['1.000', '2.000']);
  expect(result.xml).not.toContain('<Trigger');
  expect(result.xml).toContain('basic_fade="0.6" basic_delay="0.2"');
  expect(result.xml).toContain('Go Timecode 3');
  expect(ma2MtcSequenceSettings(result.xml).cues).toEqual([]);
});

it('选曲准备只改播放设置，保留原生轨道、动作、引用与相对时间', () => {
  const before = inspectMa2TimecodeXml(native).timecodes[0]!;
  const song = ma2MtcPlaybackSettings(native, false);
  const after = inspectMa2TimecodeXml(song).timecodes[0]!;
  expect(after.tracks).toEqual(before.tracks);
  expect(after.attributes.offset).toEqual(before.attributes.offset);
  expect(after.attributes.m_autostart).toBeUndefined();
  expect(after.attributes.no_status_call).toBeUndefined();
  expect(after.attributes.no_switch_off).toBeUndefined();
  expect(ma2MtcPlaybackSettings(song, false)).toBe(song);
  expect(inspectMa2TimecodeXml(ma2MtcPlaybackSettings(song, true)).timecodes[0]!.attributes.m_autostart).toBe('true');
});

it.each(['3.3.4.3', '3.7.0.5'])('空选曲序列能读回指令，拒绝夹带灯具、时间和其他命令 %s', version => {
  const commands = [ma2MtcSelectionCommand([3, 100], null), ma2MtcSelectionCommand([3, 100], 3)];
  const xml = ma2MtcSelectorSequence(9900, version, commands);
  expect(ma2MtcSelectorCommands(xml)).toEqual(commands);
  expect(() => ma2MtcSelectorCommands(xml.replace('</CuePart>', '<CueDatas /></CuePart>'))).toThrow('其他内容');
  expect(() => ma2MtcSelectorCommands(xml.replace('<Cue index="1"', '<Cue delay="10" index="1"'))).toThrow('被修改');
  expect(() => ma2MtcSelectorCommands(xml.replace('Off Timecode 3 + 100', 'Off Executor Thru'))).toThrow('其他指令');
});

it('内部对象不参与歌曲配对和素材试听，原目录仍记录占用编号', () => {
  const raw = { entries: [{ target: 3 }, { target: 9900, internal: true as const }] };
  expect(ma2SongDirectory(raw).entries).toEqual([{ target: 3 }]);
  expect(raw.entries).toHaveLength(2);
});

it('时间码在走时不读取或修改控台', async () => {
  const console = new Ma2LuaConsole();
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(console), showRunning);
  const service = new Ma2MtcSelectionService(showRunning, { record: vi.fn() });
  await expect(service.prepare(console, bridge, network)).rejects.toThrow();
  expect(console.lines).toEqual([]);
});

it('时间区间重叠时写入前拒绝，不修改已有歌曲', async () => {
  const console = new Ma2LuaConsole();
  for (const number of [3, 100]) console.set(`Timecode ${number}`, { name: `Song ${number}`, xml: `<MA><Timecode index="${number - 1}" slot="TC Slot 2" offset="300" lenght="100"><Track><SubTrack><Event index="0" command="Goto" /></SubTrack></Track></Timecode></MA>` });
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(console), showStopped);
  const service = new Ma2MtcSelectionService(showStopped, { record: vi.fn() });
  const results = await Promise.allSettled([service.prepare(console, bridge, network), service.prepare(console, bridge, network)]);
  for (const result of results) {
    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') expect(String(result.reason)).toContain('重叠');
  }
  expect(console.commands().every(command => command.startsWith('Export '))).toBe(true);
});
