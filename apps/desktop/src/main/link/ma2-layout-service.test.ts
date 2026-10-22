import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ma2LayoutService } from './ma2-layout-service';
import type { Ma2NewCueRequest, Ma2SongSyncRequest } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import { editMa2SongSequence, emptyMa2SequenceXml, inspectMa2CueData, inspectMa2SequenceXml, emptyMa2LayoutXml, inspectMa2LayoutXml } from './ma2-timecode-xml';
import { planMa2SongSync } from './ma2-song-plan';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source={show:'test',generation:'one',version:'3.7.0.5'};
function songRequest():Ma2SongSyncRequest{return {network:{host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'},expectedSource:source,projectId:randomUUID(),itemId:'song',requestId:randomUUID(),settings:{layout:999,name:'歌曲',nextSequence:9000,columns:8,executorPage:1000},name:'歌曲',points:[]};}
function request():Ma2NewCueRequest{return {network:{host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'},expectedSource:source,projectId:randomUUID(),requestId:randomUUID(),settings:{layout:999,name:'专用布局',nextSequence:9000,columns:8},name:'位置',content:{kind:'programmer',use:'Active'}};}
it('rejects an occupied Sequence and changed Show before sending any native command',async()=>{
  const command=vi.fn<Ma2Telnet['command']>();
  const bridge={request:vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify({...source,entries:[{target:9000,name:'用户已有灯光'}]}))};
  const service=new Ma2LayoutService('unused.json',()=>false);
  await expect(service.create({command},bridge,request())).rejects.toThrow('已占用');expect(command).not.toHaveBeenCalled();
  bridge.request.mockResolvedValue(JSON.stringify({...source,show:'different',entries:[]}));
  await expect(service.create({command},bridge,request())).rejects.toThrow('Show');expect(command).not.toHaveBeenCalled();
});
it('blocks active playback and invalid payloads without network work',async()=>{
  const command=vi.fn<Ma2Telnet['command']>(),bridge={request:vi.fn<Ma2OnpcBridge['request']>()};
  await expect(new Ma2LayoutService('unused.json',()=>true).create({command},bridge,request())).rejects.toThrow('停止播放');
  await expect(new Ma2LayoutService('unused.json',()=>false).create({command},bridge,{...request(),name:'invalid";Delete Sequence 1'})).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();expect(bridge.request).not.toHaveBeenCalled();
});
it('empty destinations carry no Programmer values or selected fixtures',()=>{
  const xml=emptyMa2SequenceXml(9000,'3.7.0.5');expect(inspectMa2SequenceXml(xml).sequences[0]?.number).toBe(9000);expect(inspectMa2CueData(xml,1).size).toBe(0);
  expect(inspectMa2LayoutXml(emptyMa2LayoutXml(999,'3.7.0.5'),999)).toMatchObject({items:[],omittedFixtures:0});
});
it('rejects a full song executor page before importing or renaming any Sequence', async () => {
  const base = request();
  const song: Ma2SongSyncRequest = { network: base.network, expectedSource: source, projectId: base.projectId, itemId: 'song', requestId: base.requestId, settings: { ...base.settings, executorPage: 1000 }, name: '歌曲', points: [{ id: 'cue', name: '起点', atMs: 0, cues: [] }] };
  const full = `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0" tblink_show="test" tblink_generation="one" tblink_version="3.7.0.5"><Page index="999">${'<Exec xsi:nil="true"/>'.repeat(100)}${'<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>1</No></Assignment></Exec>'.repeat(90)}</Page></MA>`;
  const command = vi.fn<Ma2Telnet['command']>();
  const bridge = { request: vi.fn<Ma2OnpcBridge['request']>().mockImplementation(op => {
    if (op === 'LISTSEQ') return Promise.resolve(JSON.stringify({ ...source, entries: [] }));
    if (op === 'PAGES') return Promise.resolve(JSON.stringify({ ...source, buttonPage: 1000, faderPage: 1, pages: [{ page: 1000, name: '已有灯光' }] }));
    if (op === 'PAGE') return Promise.resolve(full);
    throw new Error(`Unexpected ${op}`);
  }), exchange: vi.fn<Ma2OnpcBridge['exchange']>(op => Promise.reject(new Error(`Unexpected ${op}`))) };
  await expect(new Ma2LayoutService(`unused-${randomUUID()}.json`, () => false).syncSong({ command }, bridge, song)).rejects.toThrow('已经放满');
  expect(command).not.toHaveBeenCalled();
  expect(bridge.request.mock.calls.map(([op]) => op)).toEqual(['LISTSEQ', 'PAGES', 'PAGE']);
});

/** In-memory console for syncSong: emulates only the script shapes that path sends. */
function songConsole(sequences: Map<number, string>, slowRead?: { target: number; ms: number }) {
  const files = new Map<string, Buffer>(); const lines: string[] = []; const ops: string[] = []; const slow = { done: false };
  const pending = new Map<string, Buffer[]>();
  const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();
  const run = (script: string): string => {
    const writer = /(TBLINK_W_[a-f0-9]{24})=function/.exec(script)?.[1];
    const opened = /importexport\/(\w+)\.xml';local f=assert\(io\.open\(p,'wb'\)\)/.exec(script);
    if (writer && opened) { files.set(opened[1]!, Buffer.alloc(0)); writers.set(writer, opened[1]!); return 'prepared'; }
    let match = /importexport\/(\w+)\.xml','wb'\)/.exec(script);
    if (match) { files.set(match[1]!, Buffer.alloc(0)); return 'prepared'; }
    match = /importexport\/(\w+)\.xml','ab'\)\);f:write\(unhex\('([a-f0-9]*)'\)\)/.exec(script);
    if (match) { files.set(match[1]!, Buffer.concat([files.get(match[1]!)!, Buffer.from(match[2]!, 'hex')])); return 'prepared'; }
    match = /gma\.cmd\('Import (\w+)\.xml At Sequence (\d+) \/o \/nc'\)/.exec(script);
    if (match) {
      const target = Number(match[2]);
      const check = /read\('(\w+)'\)==read\('\w+_check'\)/.exec(script);
      if (check && canonical(files.get(check[1]!)!.toString('utf8')) !== canonical(sequences.get(target)!)) return 'ERR:Sequence changed during write';
      if (script.includes('Delete Sequence')) throw new Error('测试未覆盖删除');
      sequences.set(target, files.get(match[1]!)!.toString('utf8')); return 'written';
    }
    throw new Error(`假控台未识别的脚本：${script.slice(0, 200)}`);
  };
  const writers = new Map<string, string>();
  const command = vi.fn<Ma2Telnet['command']>((line, match) => {
    lines.push(line);
    const body = /^Lua "(.*)"$/.exec(line)![1]!;
    const chunk = /^if (TBLINK_W_[a-f0-9]{24}) then \1\((\d+),'([a-f0-9]*)'(,1)?\)/.exec(body);
    if (chunk) {
      const file = writers.get(chunk[1]!);
      if (!file) return Promise.resolve(match(`${chunk[1]}:${chunk[2]}:ERR:missing\r\n`)!);
      files.set(file, Buffer.concat([files.get(file)!, Buffer.from(chunk[3]!, 'hex')]));
      if (chunk[4]) writers.delete(chunk[1]!);
      return Promise.resolve(match(`${chunk[1]}:${chunk[2]}:OK\r\n`)!);
    }
    let script = body; let prefix = /TBLINK_LAYOUT_[a-f0-9]{24}:/.exec(body)?.[0];
    const key = /(TBLINK_LAYOUT_[a-f0-9]{24})=\{\}/.exec(body)?.[1];
    if (key) { pending.set(key, []); return Promise.resolve(match(`${prefix}READY\r\n`)!); }
    const part = /(TBLINK_LAYOUT_[a-f0-9]{24})\[#\1\+1\]=unhex\('([a-f0-9]+)'\)/.exec(body);
    if (part) { pending.get(part[1]!)!.push(Buffer.from(part[2]!, 'hex')); return Promise.resolve(match(`${prefix}READY\r\n`)!); }
    const assembled = /local s=table\.concat\((TBLINK_LAYOUT_[a-f0-9]{24})\)/.exec(body)?.[1];
    if (assembled) { script = Buffer.concat(pending.get(assembled)!).toString('utf8'); pending.delete(assembled); prefix = /TBLINK_LAYOUT_[a-f0-9]{24}:/.exec(script)?.[0]; }
    const result = run(script);
    return Promise.resolve(match(`${prefix}${result.startsWith('ERR:') ? result : `OK:${result}`}\r\n`)!);
  });
  const page = `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0" tblink_show="test" tblink_generation="one" tblink_version="3.7.0.5"><Page index="999">${'<Exec xsi:nil="true"/>'.repeat(100)}<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>9000</No></Assignment></Exec></Page></MA>`;
  const exchange = vi.fn<Ma2OnpcBridge['exchange']>(async (operation, target, expected, _desired, _signal, progress) => {
    ops.push(`${operation} ${target}`);
    if (slowRead && operation === 'SEQUENCE' && target === slowRead.target && ops.filter(op => op === `SEQUENCE ${target}`).length === 1) {
      for (let elapsed = 0; elapsed < slowRead.ms; elapsed += 5000) { await new Promise(resolve => setTimeout(resolve, 5000)); progress?.(); }
      slow.done = true;
    }
    const requestId = randomUUID().replaceAll('-', '');
    if (operation === 'LISTSEQ') return Promise.resolve({ requestId, response: JSON.stringify({ ...source, entries: [...sequences.keys()].map(number => ({ target: number, name: `S${number}` })) }) });
    if (operation === 'SEQUENCE') { const xml = sequences.get(target)!; if (expected === 'keep') files.set(`tblink_library_${requestId}`, Buffer.from(xml)); return Promise.resolve({ requestId, response: xml }); }
    if (operation === 'SEQCUES') {
      const xml = sequences.get(target)!; files.set(`tblink_library_${requestId}`, Buffer.from(xml));
      const wanted = new Set(expected!.split(',').map(Number));
      const cues = [...xml.matchAll(/<Cue\s[^>]*[^/]>[\s\S]*?<\/Cue>/g)].map(value => value[0]).filter(cue => {
        const tag = /<Number\s[^>]*>/.exec(cue)?.[0] ?? '';
        return wanted.has(Number(/\snumber="(\d+)"/.exec(tag)?.[1]) + Number(/sub_number="(\d+)"/.exec(tag)?.[1] ?? 0) / 1000);
      });
      return Promise.resolve({ requestId, response: `${/^[\s\S]*?<Sequ\s[^>]*>/.exec(xml)![0]}\n${cues.join('\n')}\n</Sequ></MA>` });
    }
    if (operation === 'PAGES') return Promise.resolve({ requestId, response: JSON.stringify({ ...source, buttonPage: 1000, faderPage: 1, pages: [{ page: 1000, name: '歌曲' }] }) });
    if (operation === 'PAGE') return Promise.resolve({ requestId, response: page });
    return Promise.reject(new Error(`Unexpected ${operation}`));
  });
  return { files, lines, ops, writers, slow, connection: { command }, bridge: { exchange, request: async (...args: Parameters<Ma2OnpcBridge['exchange']>) => (await exchange(...args)).response } };
}
function boundSong() {
  const attributes = readFileSync(new URL('./fixtures/ma2-cue-attributes-3.7.xml', import.meta.url), 'utf8');
  const sourceNumber = inspectMa2SequenceXml(attributes).sequences[0]!.number;
  const points = Array.from({ length: 8 }, (_, index) => ({ id: `point-${index}`, name: `段落 ${index + 1}`, atMs: index * 1000, cues: [] as Ma2SongSyncRequest['points'][number]['cues'] }));
  const base: Ma2SongSyncRequest = { ...songRequest(), points };
  const plan = planMa2SongSync(base, null);
  // A song an earlier version wrote: its Sequence and Cue names are still the Chinese originals.
  const xml = editMa2SongSequence(emptyMa2SequenceXml(9000, '3.7.0.5'), base.name, plan.points.map((point, index) => ({ cue: point.cue, name: points[index]!.name, sources: [] })), []);
  const song: Ma2SongSyncRequest = { ...base, binding: { endpoint: '192.0.2.1:30000', show: source.show, layout: null, executor: '1000.101', sequence: 9000, name: base.name, baselineXml: xml, points: plan.points },
    points: points.map((point, index) => ({ ...point, cues: index === 0 ? [{ sequence: sourceNumber, cue: '1.000', delayMs: 0 }] : [{ sequence: 9000, cue: plan.points[index]!.cue, delayMs: 0 }] })) };
  return { song, sourceNumber, sequences: new Map([[9000, xml], [sourceNumber, attributes]]) };
}
it('一次大读取持续超过 90 秒但每批都有回包时不判为无进展', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const { song, sequences } = boundSong();
    const fake = songConsole(sequences, { target: 9000, ms: 100000 });
    const directory = await mkdtemp(join(tmpdir(), 'tblink-song-'));
    const sync = new Ma2LayoutService(join(directory, 'layouts.json'), () => false).syncSong(fake.connection, fake.bridge, song);
    let settled = false; void sync.finally(() => { settled = true; }).catch(() => undefined);
    // Fake time runs only during the slow read; the service also waits on real file I/O.
    for (let step = 0; step < 200 && !settled && !fake.slow.done; step++) { await new Promise(resolve => setImmediate(resolve)); await vi.advanceTimersByTimeAsync(1000); }
    vi.useRealTimers();
    expect(fake.slow.done).toBe(true);
    await expect(sync).resolves.toMatchObject({ changed: true });
  } finally { vi.useRealTimers(); }
});
it('已绑定歌曲换一个 Cue 的内容：控台已有的序列不再整份传回控台，写前比对用控台读取时的原导出', async () => {
  const { song, sourceNumber, sequences } = boundSong();
  const fake = songConsole(sequences);
  const directory = await mkdtemp(join(tmpdir(), 'tblink-song-'));
  const result = await new Ma2LayoutService(join(directory, 'layouts.json'), () => false).syncSong(fake.connection, fake.bridge, song);
  console.info(JSON.stringify({ commands: fake.lines.length, bytes: fake.lines.reduce((total, line) => total + Buffer.byteLength(line), 0), ops: fake.ops }));
  expect(result.changed).toBe(true);
  expect([...fake.files.keys()].some(name => name.endsWith('_before'))).toBe(false);
  expect(result.backupFile).toMatch(/^tblink_library_[a-f0-9]{32}\.xml$/);
  expect(fake.files.has(result.backupFile.replace(/\.xml$/, ''))).toBe(true);
  expect(fake.lines.every(line => Buffer.byteLength(line) <= 900)).toBe(true);
  expect(fake.lines.length).toBeLessThanOrEqual(64); expect(fake.writers.size).toBe(0);
  expect(fake.ops.filter(op => op.startsWith('SEQUENCE ') && op !== 'SEQUENCE 9000')).toEqual([]);
  expect(fake.ops.filter(op => op === `SEQCUES ${sourceNumber}`)).toHaveLength(2);
});
it('控台上已有的中文名默认不改写：只换一个 Cue 的内容时其余名称保持原样', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false);
  const result = await service.syncSong(fake.connection, fake.bridge, song);
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.name).toBe('歌曲');
  expect(written.cues.map(cue => cue.name)).toEqual(Array.from({ length: 8 }, (_, index) => `段落 ${index + 1}`));
  const again = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: result.binding,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: result.binding.points[index]!.cue, delayMs: 0 }] })) });
  expect(again.changed).toBe(false); expect(again.conflicts).toEqual([]);
});
it('只改名字时写入拼音；新歌和新 Cue 直接写拼音', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false);
  const renamed = { ...song, points: song.points.map((point, index) => index === 1 ? { ...point, name: '新副歌' } : point) };
  await service.syncSong(fake.connection, fake.bridge, renamed);
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues.map(cue => cue.name).slice(0, 3)).toEqual(['段落 1', 'XinFuGe', '段落 3']);
});
it('显式要求时把控台上软件写过的中文名改为拼音，用回读结果再次同步不再判为改名', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false);
  const first = await service.syncSong(fake.connection, fake.bridge, { ...song, rewriteLegacyNames: true });
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.name).toBe('GeQu');
  expect(written.cues.map(cue => cue.name)).toEqual(Array.from({ length: 8 }, (_, index) => `DuanLuo ${index + 1}`));
  const again = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: first.binding,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: first.binding.points[index]!.cue, delayMs: 0 }] })) });
  expect(again.changed).toBe(false); expect(again.conflicts).toEqual([]);
});
