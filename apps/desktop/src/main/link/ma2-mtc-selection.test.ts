import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { ma2ObjectDirectorySchema } from '@tb/schema';
import { ma2MtcSelectionCommand, ma2MtcSelections, ma2SongDirectory } from '@tb/core/link';
import { Ma2MtcSelectionService, ma2SelectorXmlLiteral, ma2MtcSelectorCommands, ma2MtcSelectorSequence, ma2MtcSequenceSettings } from './ma2-mtc-selection';
import { emptyMa2SequenceXml, inspectMa2TimecodeXml, ma2MtcPlaybackSettings } from './ma2-timecode-xml';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { Ma2LuaConsole } from './fixtures/ma2-lua-console';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2NetworkWire } from './ma2-network-wire';
import { showRunning, showStopped } from './fixtures/show-gates';
import type { Ma2ReadProgressUpdate } from '@tb/schema';

const network = { host: '127.0.0.1', port: 30000, monitorPort: 30001, username: 'test' };
const native = readFileSync(new URL('./fixtures/ma2-timecode-onpc-3.7-100.xml', import.meta.url), 'utf8');

it('全是其他时码槽时，已确认的 Cue 编辑不重读整个 Show；时码槽改变须重新核对', async () => {
  const console = new Ma2LuaConsole();
  const original = native.replace('index="9906"', 'index="9998"');
  console.set('Timecode 9999', { name: '现场', xml: original });
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(console), showStopped);
  const service = new Ma2MtcSelectionService(showStopped, { record: vi.fn() });
  await expect(service.prepare(console, bridge, network, true)).resolves.toBe(false);
  const source = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  const start = console.lines.length;
  await expect(service.prepare(console, bridge, network, false, [9999], undefined, { ...source, number: 9999, xml: original })).resolves.toBe(false);
  expect(console.lines).toHaveLength(start);
  // An object entering the managed slot must go through the actual selector checks.
  const check = vi.fn(() => { throw new Error('开始重新核对'); });
  await expect(service.prepare(console, bridge, network, false, [9999], undefined, {
    ...source, number: 9999, xml: original.replace('TC Slot 1', 'TC Slot 2')
  }, { onConsoleCheck: check })).rejects.toThrow('开始重新核对');
  expect(check).toHaveBeenCalledOnce();
});

it('30 条时间线共用大序列只检查一次，连接和再次连接不传灯具数据', async () => {
  const console = new Ma2LuaConsole();
  const numbers = Array.from({ length: 30 }, (_, index) => index + 1);
  const name = 'TBLINK_MTC_SELECTION';
  const songs = numbers.map(number => ({ timecode: number, start: number * 600, end: number * 600 + 300 }));
  const points = ma2MtcSelections(songs);
  for (const song of songs) {
    console.set(`Timecode ${song.timecode}`, { name: `Song ${song.timecode}`, xml: ma2MtcPlaybackSettings(ma2SongTimecodeXml(native.replace('index="9906"', `index="${song.timecode - 1}"`), song.timecode,
      { name: `Song ${song.timecode}`, startMs: song.start * 1000 / 30, lengthMs: 10000, executor: '1.101', executorName: 'Songs', sequence: 3, cues: [{ atMs: 1000, cueIndex: 1, number: '1', name: null }] }), false) });
  }
  console.set('Sequence 3', { name: 'Songs', xml: `<MA><Sequ index="2"><Cue index="1"><Number number="1"/><CuePart index="0"><Data>${'x'.repeat(33 * 1024 * 1024)}</Data></CuePart></Cue></Sequ></MA>` });
  console.set('Sequence 9900', { name, label: name, xml: ma2MtcSelectorSequence(9900, '3.7.0.5', points.map(point => ma2MtcSelectionCommand(numbers, point.timecode))) });
  console.set('Timecode 9900', { name, label: name, xml: ma2MtcPlaybackSettings(ma2SongTimecodeXml(native.replace('index="9906"', 'index="9899"'), 9900,
    { name, startMs: 0, executor: '1000.190', executorName: `${name} 1000.190`, sequence: 9900, automatic: true,
      cues: points.map((point, index) => ({ atMs: point.at * 1000 / 30, cueIndex: index + 1, number: String(index + 1), name: null })) }), true) });
  console.lua(`for _,a in ipairs({'Sequence 9900','Timecode 9900'}) do FAKE.objects[a].properties={Info='TBLINK_MTC_SELECTOR_V1'} end
    local original=gma.cmd;gma.cmd=function(command)
      local name=command:match('^Export Sequence 3 "([%w_]+)" /o$')
      if name then FAKE.log[#FAKE.log+1]=command;FAKE.files['/fake/importexport/'..name..'.xml']=FAKE.objects['Sequence 3'].xml else original(command) end
    end`);
  const header = '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0">';
  console.set('Page 1000', { name: 'Songs', xml: `${header}<Page index="999">${'<Exec xsi:nil="true"/>'.repeat(189)}<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>9900</No></Assignment></Exec></Page></MA>` });
  console.set('Executor 1000.190', { name, label: name, xml: `${header}<Exec offset_from_first="0"><Assignment name="${name}"><No>25</No><No>1</No><No>9900</No></Assignment></Exec></MA>` });
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(console), showStopped);
  const service = new Ma2MtcSelectionService(showStopped, { record: vi.fn() });
  for (let run = 0; run < 2; run += 1) {
    const before = console.lines.length;
    const progress: Ma2ReadProgressUpdate[] = [];
    await expect(service.prepare(console, bridge, network, true, [], undefined, undefined, { report: value => progress.push(value) })).resolves.toBe(false);
    const sent = console.lines.slice(before);
    expect(sent.filter(line => line.includes("'SEQGO',3,"))).toHaveLength(1);
    expect(sent.some(line => line.includes("'SEQUENCE',3,"))).toBe(false);
    expect(sent.filter(line => numbers.some(number => line.includes(`'READ',${number},`)))).toHaveLength(0);
    expect(sent.filter(line => line.includes("'TCRANGES',1,"))).toHaveLength(2);
    expect(sent.length).toBeLessThan(300);
    expect(progress.at(-1)).toMatchObject({ completed: 30, total: 30, detail: '控台选曲检查完成' });
    expect(progress.some(value => value.detail.includes('检查序列 3'))).toBe(true);
  }
  expect(console.commands().every(command => command.startsWith('Export'))).toBe(true);
}, 60_000);

it('两个不同编号带有选曲标记时，先报告冲突，避免覆盖已有序列或时间线', async () => {
  const console = new Ma2LuaConsole();
  console.set('Sequence 9998', { name: '已有序列' });
  console.set('Timecode 9999', { name: '已有时间线', xml: native.replace('index="9906"', 'index="9998"') });
  console.lua("for _,a in ipairs({'Sequence 9998','Timecode 9999'}) do FAKE.objects[a].properties={Info='TBLINK_MTC_SELECTOR_V1'} end");
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(console), showStopped);
  const service = new Ma2MtcSelectionService(showStopped, { record: vi.fn() });
  await expect(service.prepare(console, bridge, network, true)).rejects.toThrow('多组选曲对象');
  expect(console.commands().every(cmd => cmd.startsWith('Export'))).toBe(true);
});

it.each([false, true])('只移歌曲内的点复用当次读回；末点越过曲尾时更新选曲截止帧；原生清空解除执行器=%s', async detachExecutor => {
  const console = new Ma2LuaConsole();
  const song = (ms: number) => ma2SongTimecodeXml(native.replace('index="9906"', 'index="2"'), 3,
    { name: 'Song', startMs: 10000, lengthMs: 10000, executor: '1.101', executorName: 'Song 1.101', sequence: 3, cues: [{ atMs: ms, cueIndex: 1, number: '1', name: null }] });
  const points = ma2MtcSelections([{ timecode: 3, start: 300, end: 600 }]);
  const name = 'TBLINK_MTC_SELECTION';
  const commands = points.map(point => ma2MtcSelectionCommand([3], point.timecode));
  const selector = ma2SongTimecodeXml(native.replace('index="9906"', 'index="9899"'), 9900,
    { name, startMs: 0, executor: '1000.190', executorName: `${name} 1000.190`, sequence: 9900, automatic: true,
      cues: points.map((point, index) => ({ atMs: point.at * 1000 / 30, cueIndex: index + 1, number: String(index + 1), name: null })) });
  const sequence = emptyMa2SequenceXml(3, '3.7.0.5');
  console.set('Sequence 3', { name: 'Song', xml: sequence });
  console.set('Timecode 3', { name: 'Song', xml: song(1000) });
  console.set('Sequence 9900', { name, label: name, xml: ma2MtcSelectorSequence(9900, '3.7.0.5', commands) });
  console.set('Timecode 9900', { name, label: name, xml: selector });
  console.lua("for _,a in ipairs({'Sequence 9900','Timecode 9900'}) do FAKE.objects[a].properties={Info='TBLINK_MTC_SELECTOR_V1'} end");
  const header = '<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0">';
  console.set('Page 1000', { name: 'Songs', xml: `${header}<Page index="999">${'<Exec xsi:nil="true"/>'.repeat(189)}<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>9900</No></Assignment></Exec></Page></MA>` });
  console.set('Executor 1000.190', { name, label: name, xml: `${header}<Exec offset_from_first="0"><Assignment name="${name}"><No>25</No><No>1</No><No>9900</No></Assignment></Exec></MA>` });
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(console), showStopped);
  const service = new Ma2MtcSelectionService(showStopped, { record: vi.fn() });
  await service.prepare(console, bridge, network);
  const source = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  const before = console.lines.length;
  await expect(service.prepare(console, bridge, network, false, [3], { number: 3, xml: sequence }, { number: 3, xml: song(2000), ...source })).resolves.toBe(false);
  expect(console.lines).toHaveLength(before);
  await expect(service.prepare(console, bridge, network, false, [3], undefined, { number: 3, xml: song(2000), ...source, goSequences: [3] })).resolves.toBe(false);
  expect(console.lines).toHaveLength(before);
  // Evidence about a different Sequence cannot confirm this song's Go triggers.
  await expect(service.prepare(console, bridge, network, false, [3], undefined, { number: 3, xml: song(2000), ...source, goSequences: [7] })).resolves.toBe(false);
  expect(console.lines.slice(before).some(line => line.includes("'SEQGO',3,"))).toBe(true);
  const queuedAt = console.lines.length;
  const confirmed = { number: 3, xml: song(2000), ...source, goSequences: [3] };
  const prepare = () => service.prepare(console, bridge, network, false, [3], undefined, confirmed);
  expect(await Promise.all([prepare(), prepare()])).toEqual([false, false]);
  expect(console.lines.slice(queuedAt).some(line => line.includes("'READ',3,"))).toBe(true);
  if (detachExecutor) console.lua(`local original=gma.cmd;local assignedPage=FAKE.objects['Page 1000'].xml;gma.cmd=function(command)
    original(command)
    if command:match('^Delete Sequence 9900 Cue ') then
      FAKE.objects['Executor 1000.190']=nil
      FAKE.objects['Page 1000'].xml=EMPTY_PAGE
    end
    local file=command:match('^Import ([%w_]+%.xml) At Sequence 9900 ')
    if file then FAKE.objects['Sequence 9900'].xml=assert(FAKE.files['/fake/importexport/'..file]) end
    if command=='Assign Sequence 9900 At Executor 1000.190 /nc' then FAKE.objects['Page 1000'].xml=assignedPage end
  end`, { EMPTY_PAGE: `${header}<Page index="999"/></MA>` });
  if (detachExecutor) console.set('Timecode 4', { name: 'Second song', xml: song(1000).replace('index="2"', 'index="3"').replace('offset="300"', 'offset="700"').replace('lenght="300"', 'lenght="100"') });
  console.set('Timecode 3', { name: 'Song', xml: song(12000) });
  await expect(service.prepare(console, bridge, network, false, [3], { number: 3, xml: sequence }, { number: 3, xml: song(12000), ...source })).resolves.toBe(true);
  const written = inspectMa2TimecodeXml(await bridge.request('READ', 9900)).timecodes[0]!;
  expect(written.tracks[0]!.subtracks[0]!.events.at(-1)!.attributes.time).toBe(detachExecutor ? '800' : '661');
  if (detachExecutor) expect(console.commands()).toContain('Assign Sequence 9900 At Executor 1000.190 /nc');
});

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

it('57 首歌的辅助选曲序列只传一次重复内容，在控台还原后与写前和写后使用的 XML 逐字节相同', () => {
  const numbers = Array.from({ length: 57 }, (_, index) => 100 + index);
  const xml = ma2MtcSelectorSequence(9900, '3.3.4.3', numbers.map(number => ma2MtcSelectionCommand(numbers, number)));
  const lua = new Ma2LuaConsole();
  const literal = ma2SelectorXmlLiteral(xml);
  const [result] = lua.lua(`local function unhex(h)return (h:gsub('..',function(x)return string.char(tonumber(x,16))end))end;return ${literal}`);
  expect(result).toEqual(Buffer.from(xml));
  expect(literal.length).toBeLessThan(Buffer.byteLength(xml));
});
