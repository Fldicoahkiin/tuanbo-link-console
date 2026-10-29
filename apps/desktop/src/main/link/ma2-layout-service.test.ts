import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Ma2LayoutService } from './ma2-layout-service';
import type { Ma2NewCueRequest, Ma2SongSyncRequest, Ma2SongSyncResult } from '@tb/schema';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import type { Ma2Telnet } from './ma2-telnet';
import type { Ma2ConsoleBackups } from './ma2-console-backups';
import { editMa2SongSequence, emptyMa2SequenceXml, inspectMa2CueData, inspectMa2SequenceXml, inspectMa2TimecodeXml, emptyMa2LayoutXml, inspectMa2LayoutXml } from './ma2-timecode-xml';
import { planMa2SongSync } from './ma2-song-plan';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source={show:'test',generation:'one',version:'3.7.0.5'};
const noBackups = { record: vi.fn<Ma2ConsoleBackups['record']>(() => Promise.resolve()) };
function songRequest():Ma2SongSyncRequest{return {network:{host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'},expectedSource:source,projectId:randomUUID(),itemId:'song',requestId:randomUUID(),settings:{layout:999,name:'歌曲',nextSequence:9000,columns:8,executorPage:1000},name:'歌曲',points:[]};}
function request():Ma2NewCueRequest{return {network:{host:'192.0.2.1',port:30000,monitorPort:30001,username:'test'},expectedSource:source,projectId:randomUUID(),requestId:randomUUID(),settings:{layout:999,name:'专用布局',nextSequence:9000,columns:8},name:'位置',content:{kind:'programmer',use:'Active'}};}
it('rejects an occupied Sequence and changed Show before sending any native command',async()=>{
  const command=vi.fn<Ma2Telnet['command']>();
  const bridge={request:vi.fn<Ma2OnpcBridge['request']>().mockResolvedValue(JSON.stringify({...source,entries:[{target:9000,name:'用户已有灯光'}]}))};
  const service=new Ma2LayoutService('unused.json', () => false, noBackups);
  await expect(service.create({command},bridge,request())).rejects.toThrow('已占用');expect(command).not.toHaveBeenCalled();
  bridge.request.mockResolvedValue(JSON.stringify({...source,show:'different',entries:[]}));
  await expect(service.create({command},bridge,request())).rejects.toThrow('Show');expect(command).not.toHaveBeenCalled();
});
it('blocks active playback and invalid payloads without network work',async()=>{
  const command=vi.fn<Ma2Telnet['command']>(),bridge={request:vi.fn<Ma2OnpcBridge['request']>()};
  await expect(new Ma2LayoutService('unused.json', () => true, noBackups).create({command},bridge,request())).rejects.toThrow('停止播放');
  await expect(new Ma2LayoutService('unused.json', () => false, noBackups).create({command},bridge,{...request(),name:'invalid";Delete Sequence 1'})).rejects.toThrow();
  expect(command).not.toHaveBeenCalled();expect(bridge.request).not.toHaveBeenCalled();
});
it('empty destinations carry no Programmer values or selected fixtures',()=>{
  const xml=emptyMa2SequenceXml(9000,'3.7.0.5');expect(inspectMa2SequenceXml(xml).sequences[0]?.number).toBe(9000);expect(inspectMa2CueData(xml,1).size).toBe(0);
  expect(inspectMa2LayoutXml(emptyMa2LayoutXml(999,'3.7.0.5'),999)).toMatchObject({items:[],omittedFixtures:0});
});
it('按钮第 1000 页起连续 10 页都放满时，不导入也不改名任何序列（满页本身顺延到下一页，见 ma2-song-executor.test）', async () => {
  const base = request();
  const song: Ma2SongSyncRequest = { network: base.network, expectedSource: source, projectId: base.projectId, itemId: 'song', requestId: base.requestId, settings: { ...base.settings, executorPage: 1000 }, name: '歌曲', points: [{ id: 'cue', name: '起点', atMs: 0, cues: [] }] };
  const full = (page: number): string => `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0" tblink_show="test" tblink_generation="one" tblink_version="3.7.0.5"><Page index="${page - 1}">${'<Exec xsi:nil="true"/>'.repeat(100)}${'<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>1</No></Assignment></Exec>'.repeat(90)}</Page></MA>`;
  const command = vi.fn<Ma2Telnet['command']>();
  const bridge = { request: vi.fn<Ma2OnpcBridge['request']>().mockImplementation((op, page) => {
    if (op === 'LISTSEQ') return Promise.resolve(JSON.stringify({ ...source, entries: [] }));
    if (op === 'PAGES') return Promise.resolve(JSON.stringify({ ...source, buttonPage: 1000, faderPage: 1, pages: Array.from({ length: 10 }, (_, index) => ({ page: 1000 + index, name: '已有灯光' })) }));
    if (op === 'PAGE') return Promise.resolve(full(page));
    throw new Error(`Unexpected ${op}`);
  }), exchange: vi.fn<Ma2OnpcBridge['exchange']>(op => Promise.reject(new Error(`Unexpected ${op}`))) };
  await expect(new Ma2LayoutService(`unused-${randomUUID()}.json`, () => false, noBackups).syncSong({ command }, bridge, song)).rejects.toThrow('第 1000–1009 页的 101–190 都已放满');
  expect(command).not.toHaveBeenCalled();
  expect(bridge.request.mock.calls.map(([op]) => op)).toEqual(['LISTSEQ', 'PAGES', ...Array<string>(10).fill('PAGE')]);
});

/** In-memory console for syncSong: emulates only the script shapes that path sends. */
function songConsole(sequences: Map<number, string>, slowRead?: { target: number; ms: number }) {
  const files = new Map<string, Buffer>(); const lines: string[] = []; const ops: string[] = []; const slow = { started: false, done: false };
  const timecodes = new Map<number, string>();
  const pending = new Map<string, Buffer[]>(); const copies = new Map<string, Array<{ xml: string; cue: string }>>(); const keeps: string[] = [];
  const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();
  const run = (script: string): string => {
    const writer = /(TBLINK_W_[a-f0-9]{24})=function/.exec(script)?.[1];
    const opened = /importexport\/(\w+)\.xml';local f=assert\(io\.open\(p,'wb'\)\)/.exec(script);
    if (writer && opened) { files.set(opened[1]!, Buffer.alloc(0)); writers.set(writer, opened[1]!); return 'prepared'; }
    let match = /importexport\/(\w+)\.xml','wb'\)/.exec(script);
    if (match) { files.set(match[1]!, Buffer.alloc(0)); return 'prepared'; }
    match = /importexport\/(\w+)\.xml','ab'\)\);f:write\(unhex\('([a-f0-9]*)'\)\)/.exec(script);
    if (match) { files.set(match[1]!, Buffer.concat([files.get(match[1]!)!, Buffer.from(match[2]!, 'hex')])); return 'prepared'; }
    // The song check's console export copied as the write-before export, without reading the Sequence.
    const copied = /io\.open\(p\.\.'(tblink_watch_[a-f0-9]{16})\.xml','rb'\)\);local s=f:read\('\*a'\);f:close\(\);local o=assert\(io\.open\(p\.\.'(tblink_library_[a-f0-9]{32})\.xml','wb'\)\)/.exec(script);
    if (copied) { files.set(copied[2]!, files.get(copied[1]!)!); return 'copied'; }
    // Copy /o replaces the Cue with its source, /merge adds the source's rows; names come from Label.
    const song = (target: number) => inspectMa2SequenceXml(sequences.get(target)!).sequences[0]!;
    // Keeping a combined Cue's attributes: later /merge copies rebuild its data from the sources alone.
    const kept = /_attrs\.xml'[\s\S]*Copy Sequence \d+ Cue [\d.]+ At Sequence (\d+) Cue ([\d.]+) \/o \/nc/.exec(script);
    if (kept) { copies.set(`${kept[1]}/${Number(kept[2])}`, []); keeps.push(`${kept[1]}/${Number(kept[2])}`); return 'kept'; }
    const copy = /gma\.cmd\('Copy Sequence (\d+) Cue ([\d.]+) At Sequence (\d+) Cue ([\d.]+) \/(o|merge) \/nc'\)/.exec(script);
    if (copy) {
      const [, from, cue, to, at, mode] = copy; const key = `${to}/${Number(at)}`;
      copies.set(key, [...mode === 'merge' ? copies.get(key) ?? [] : [], { xml: sequences.get(Number(from))!, cue: cue! }]);
      const target = song(Number(to));
      sequences.set(Number(to), editMa2SongSequence(sequences.get(Number(to))!, target.name ?? '', [{ cue: at!, name: target.cues.find(value => Number(value.number) === Number(at))?.name ?? '', sources: copies.get(key)! }], []));
    }
    for (const [, hex] of script.matchAll(/gma\.cmd\(unhex\('([a-f0-9]+)'\)\)/g)) {
      const label = /^Label Sequence (\d+)(?: Cue ([\d.]+))? "(.*)"$/.exec(Buffer.from(hex!, 'hex').toString('utf8'));
      if (!label) continue;
      const [, to, at, name] = label; const target = song(Number(to));
      sequences.set(Number(to), at ? editMa2SongSequence(sequences.get(Number(to))!, target.name ?? '', [{ cue: at, name: name! }], []) : editMa2SongSequence(sequences.get(Number(to))!, name!, [], []));
    }
    if (copy) return 'copied';
    if (script.includes("return 'labelled'")) return 'labelled';
    const assign = /gma\.cmd\('Assign Sequence (\d+) At Executor 1000\.(\d+) \/nc'\)/.exec(script);
    if (assign) {
      if (executors.has(Number(assign[2]))) return 'ERR:Executor became occupied';
      executors.set(Number(assign[2]), Number(assign[1])); return 'assigned';
    }
    // A new song's write refuses a number someone took on the console after it was chosen.
    const free = /assert\(not gma\.show\.getobj\.handle\('Sequence (\d+)'\),'Sequence occupied'\)/.exec(script);
    if (free && sequences.has(Number(free[1]))) return 'ERR:Sequence occupied';
    // A full clear imports the emptied snapshot first; the last Import is what the Sequence ends up holding.
    match = [...script.matchAll(/gma\.cmd\('Import (\w+)\.xml At Sequence (\d+) \/o \/nc'\)/g)].at(-1) ?? null;
    if (!match && /read\('\w+'\)==read\('\w+_check'\)/.test(script)) {
      const [, before, target] = /read\('(\w+)'\)==read\('\w+_check'\)/.exec(script)!.concat(/Export Sequence (\d+) /.exec(script)![1]!);
      if (canonical(files.get(before!)!.toString('utf8')) !== canonical(sequences.get(Number(target))!)) return 'ERR:Sequence changed during write';
      const deleted = [...script.matchAll(/Delete Sequence \d+ Cue ([\d.]+) \/nc/g)].map(value => value[1]!);
      if (deleted.length) sequences.set(Number(target), editMa2SongSequence(sequences.get(Number(target))!, song(Number(target)).name ?? '', [], deleted));
      return 'written';
    }
    if (match) {
      const target = Number(match[2]);
      const check = /read\('(\w+)'\)==read\('\w+_check'\)/.exec(script);
      if (check && canonical(files.get(check[1]!)!.toString('utf8')) !== canonical(sequences.get(target)!)) return 'ERR:Sequence changed during write';
      sequences.set(target, files.get(match[1]!)!.toString('utf8')); return 'written';
    }
    throw new Error(`假控台未识别的脚本：${script.slice(0, 120)} … ${script.slice(-260)}`);
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
    let script = body; let prefix = /TBLINK_(?:LAYOUT|CUE)_[a-f0-9]{24}:/.exec(body)?.[0];
    const key = /(TBLINK_(?:LAYOUT|CUE)_[a-f0-9]{24})=\{\}/.exec(body)?.[1];
    if (key) { pending.set(key, []); return Promise.resolve(match(`${prefix}READY\r\n`)!); }
    const part = /(TBLINK_(?:LAYOUT|CUE)_[a-f0-9]{24})\[#\1\+1\]=unhex\('([a-f0-9]+)'\)/.exec(body);
    if (part) { pending.get(part[1]!)!.push(Buffer.from(part[2]!, 'hex')); return Promise.resolve(match(`${prefix}READY\r\n`)!); }
    const assembled = /local s=table\.concat\((TBLINK_(?:LAYOUT|CUE)_[a-f0-9]{24})\)/.exec(body)?.[1];
    if (assembled) { script = Buffer.concat(pending.get(assembled)!).toString('utf8'); pending.delete(assembled); prefix = /TBLINK_(?:LAYOUT|CUE)_[a-f0-9]{24}:/.exec(script)?.[0]; }
    const result = run(script);
    return Promise.resolve(match(`${prefix}${result.startsWith('ERR:') ? result : `OK:${result}`}\r\n`)!);
  });
  // Button page 1000: slot 101 holds Sequence 9000; assignments add slots after it.
  const executors = new Map<number, number>([[101, 9000]]);
  const page = (): string => `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" major_vers="3" minor_vers="7" stream_vers="0" tblink_show="test" tblink_generation="one" tblink_version="3.7.0.5"><Page index="999">${Array.from({ length: Math.max(...executors.keys()) }, (_, index) => executors.has(index + 1) ? `<Exec offset_from_first="0"><Assignment><No>25</No><No>1</No><No>${executors.get(index + 1)}</No></Assignment></Exec>` : '<Exec xsi:nil="true"/>').join('')}</Page></MA>`;
  const exchange = vi.fn<Ma2OnpcBridge['exchange']>(async (operation, target, expected, _desired, _signal, progress) => {
    ops.push(`${operation} ${target}`);
    if (slowRead && operation === 'SEQUENCE' && target === slowRead.target && ops.filter(op => op === `SEQUENCE ${target}`).length === 1) {
      slow.started = true;
      for (let elapsed = 0; elapsed < slowRead.ms; elapsed += 5000) { await new Promise(resolve => setTimeout(resolve, 5000)); progress?.(); }
      slow.done = true;
    }
    const requestId = randomUUID().replaceAll('-', '');
    if (operation === 'LISTSEQ') return Promise.resolve({ requestId, response: JSON.stringify({ ...source, entries: [...sequences.keys()].map(number => ({ target: number, name: `S${number}` })) }) });
    if (operation === 'SEQUENCE') {
      const xml = sequences.get(target)!; if (expected === 'keep') files.set(`tblink_library_${requestId}`, Buffer.from(xml));
      // The wire reports each 8 KB batch of a response as it arrives.
      const size = Buffer.byteLength(xml);
      for (let completed = Math.min(8192, size); ; completed = Math.min(completed + 8192, size)) { progress?.({ completed, total: size }); if (completed === size) break; }
      return Promise.resolve({ requestId, response: xml });
    }
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
    // Timecode shows: the song's own show is created empty, read, and replaced only from what was read.
    if (operation === 'LIST') return Promise.resolve({ requestId, response: JSON.stringify({ ...source, entries: [...timecodes.keys()].map(number => ({ target: number, name: `TC${number}` })) }) });
    if (operation === 'CREATE') { if (timecodes.has(target)) return Promise.reject(new Error('Timecode already exists')); timecodes.set(target, _desired!); return Promise.resolve({ requestId, response: _desired! }); }
    if (operation === 'READ') return Promise.resolve({ requestId, response: timecodes.get(target)! });
    if (operation === 'APPLY') {
      if (canonical(timecodes.get(target)!) !== canonical(expected!)) return Promise.reject(new Error('Timecode changed after preview'));
      timecodes.set(target, _desired!); files.set(`tblink_backup_${requestId}`, Buffer.from(expected!)); return Promise.resolve({ requestId, response: _desired! });
    }
    if (operation === 'EXECUTOR') return Promise.resolve({ requestId, response: `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Exec offset_from_first="0" tblink_executor_name="GeQu ${target}.${expected}"><Assignment name="GeQu"><No>25</No><No>1</No><No>${executors.get(Number(expected)) ?? 9000}</No></Assignment></Exec></MA>` });
    if (operation === 'PAGE') return Promise.resolve({ requestId, response: page() });
    return Promise.reject(new Error(`Unexpected ${operation}`));
  });
  return { files, lines, ops, writers, slow, keeps, timecodes, connection: { command }, bridge: { exchange, request: async (...args: Parameters<Ma2OnpcBridge['exchange']>) => (await exchange(...args)).response } };
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
    const sync = new Ma2LayoutService(join(directory, 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, song);
    let settled = false; void sync.finally(() => { settled = true; }).catch(() => undefined);
    // Fake time runs only during the slow read; before it starts the service waits on real file I/O,
    // which takes more event-loop turns when the machine is busy.
    for (let step = 0; step < 20000 && !settled && !fake.slow.done; step++) { await new Promise(resolve => setImmediate(resolve)); if (fake.slow.started) await vi.advanceTimersByTimeAsync(1000); }
    vi.useRealTimers();
    expect(fake.slow.done).toBe(true);
    await expect(sync).resolves.toMatchObject({ changed: true });
  } finally { vi.useRealTimers(); }
});
it('已绑定歌曲换一个 Cue 的内容：在控台内 Copy，不上传歌曲 XML，写前比对用控台读取时的原导出', async () => {
  const { song, sourceNumber, sequences } = boundSong();
  const fake = songConsole(sequences);
  const directory = await mkdtemp(join(tmpdir(), 'tblink-song-'));
  const reported: string[] = [];
  const result = await new Ma2LayoutService(join(directory, 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, song, value => reported.push(`${value.phase} ${value.completed}/${value.total} ${value.detail}`));
  console.info(JSON.stringify({ commands: fake.lines.length, bytes: fake.lines.reduce((total, line) => total + Buffer.byteLength(line), 0), ops: fake.ops }));
  // Whole-Sequence reads say how much has arrived, before and after the write.
  const size = Buffer.byteLength(sequences.get(9000)!);
  expect(reported).toContain(`verification ${size}/${size} 读取序列 9000 · ${Math.ceil(size / 1024)}/${Math.ceil(size / 1024)} KB`);
  expect(reported.some(line => line.startsWith('connecting ') && line.includes('读取控台序列 9000 · '))).toBe(true);
  expect(result.changed).toBe(true);
  expect([...fake.files.keys()].some(name => name.endsWith('_before'))).toBe(false);
  expect(result.backupFile).toMatch(/^tblink_library_[a-f0-9]{32}\.xml$/);
  expect(fake.files.has(result.backupFile.replace(/\.xml$/, ''))).toBe(true);
  // Without a song check to take it over, the post-write export joins the rotation too.
  expect(noBackups.record).toHaveBeenLastCalledWith(fake.bridge, { console: '192.0.2.1:30000', object: 'Sequence 9000', files: [result.backupFile.replace(/\.xml$/, ''), expect.stringMatching(/^tblink_library_[a-f0-9]{32}$/)] });
  expect(fake.lines.every(line => Buffer.byteLength(line) <= 900)).toBe(true);
  expect(fake.lines.length).toBeLessThanOrEqual(20); expect(fake.writers.size).toBe(0);
  expect([...fake.files.keys()].some(name => name.startsWith('tblink_song_'))).toBe(false);
  const copied = fake.lines.map(line => Buffer.from(line).toString('utf8')).filter(line => line.includes(`Copy Sequence ${sourceNumber} Cue 1.000 At Sequence 9000 Cue`));
  expect(copied).toHaveLength(1);
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues.map(cue => cue.name)).toEqual(Array.from({ length: 8 }, (_, index) => `段落 ${index + 1}`));
  expect(fake.ops.filter(op => op.startsWith('SEQUENCE ') && op !== 'SEQUENCE 9000')).toEqual([]);
  expect(fake.ops.filter(op => op === `SEQCUES ${sourceNumber}`)).toHaveLength(1);
});
it('复查确认控台仍等于本地基线时，写前不再整读本曲序列：在控台上复制复查导出作写前守卫和备份', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const baseline = 'tblink_watch_0123456789abcdef';
  fake.files.set(baseline, Buffer.from(sequences.get(9000)!));
  noBackups.record.mockClear();
  const result = await new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, song, undefined, undefined, { consoleBaseline: baseline });
  expect(result.changed).toBe(true);
  expect(fake.ops.filter(op => op === 'SEQUENCE 9000')).toHaveLength(1);
  expect(result.backupFile).toMatch(/^tblink_library_[a-f0-9]{32}\.xml$/);
  expect(fake.files.get(result.backupFile.replace(/\.xml$/, ''))?.toString('utf8')).toBe(fake.files.get(baseline)?.toString('utf8'));
  expect(noBackups.record).toHaveBeenCalledWith(fake.bridge, expect.objectContaining({ object: 'Sequence 9000', files: [result.backupFile.replace(/\.xml$/, ''), expect.stringMatching(/^tblink_library_[a-f0-9]{32}$/)] }));
  await expect(new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID() }, undefined, undefined, { consoleBaseline: "x');os.remove('a" })).rejects.toThrow('基线文件名无效');
});
it('写后回读交给复查接管时不进备份轮转；接管方拿到这次回读的控台文件和带指纹的结果', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  noBackups.record.mockClear();
  const adoptReadback = vi.fn<(exportFile: string, result: Ma2SongSyncResult) => Promise<boolean>>(() => Promise.resolve(true));
  const result = await new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, song, undefined, undefined, { adoptReadback });
  const [exportFile, handed] = adoptReadback.mock.calls[0]!;
  expect(exportFile).toMatch(/^tblink_library_[a-f0-9]{32}$/);
  expect(fake.files.get(exportFile)?.toString('utf8')).toBe(sequences.get(9000));
  expect(handed.remoteRevision).toBe(result.remoteRevision);
  expect(noBackups.record).toHaveBeenCalledWith(fake.bridge, expect.objectContaining({ files: [result.backupFile.replace(/\.xml$/, '')] }));
});
it('没有改动的同步：写前读到的控台导出直接交给复查当基线，不进备份轮转，执行器页和目录各只读一次', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const written = await service.syncSong(fake.connection, fake.bridge, song);
  fake.ops.length = 0; noBackups.record.mockClear();
  const adoptReadback = vi.fn<(exportFile: string, result: Ma2SongSyncResult) => Promise<boolean>>(() => Promise.resolve(true));
  const unchanged = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: written.binding,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: written.binding.points[index]!.cue, delayMs: 0 }] })) }, undefined, undefined, { adoptReadback });
  expect(unchanged.changed).toBe(false);
  expect(fake.ops).toEqual(['LISTSEQ 1', 'PAGES 1', 'PAGE 1000', 'SEQUENCE 9000']);
  const [exportFile, handed] = adoptReadback.mock.calls[0]!;
  expect(exportFile).toMatch(/^tblink_library_[a-f0-9]{32}$/);
  expect(fake.files.get(exportFile)?.toString('utf8')).toBe(sequences.get(9000));
  expect(handed.remoteRevision).toBe(unchanged.remoteRevision);
  expect(noBackups.record).not.toHaveBeenCalled();
  // A copy of the check's own baseline already is one: nothing is handed over and the copy joins the rotation.
  adoptReadback.mockClear();
  const baseline = 'tblink_watch_0123456789abcdef';
  fake.files.set(baseline, Buffer.from(sequences.get(9000)!));
  const copied = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: unchanged.binding,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: unchanged.binding.points[index]!.cue, delayMs: 0 }] })) }, undefined, undefined, { consoleBaseline: baseline, adoptReadback });
  expect(copied.changed).toBe(false);
  expect(adoptReadback).not.toHaveBeenCalled();
  expect(noBackups.record).toHaveBeenCalledWith(fake.bridge, expect.objectContaining({ object: 'Sequence 9000', files: [expect.stringMatching(/^tblink_library_[a-f0-9]{32}$/)] }));
});
it('带起始码同步时在序列之后写本曲时间码节目；改时间后重写；控台上被改过时按时间线重写并留备份；不带起始码不碰时间码', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const plain = await service.syncSong(fake.connection, fake.bridge, song);
  expect(plain.binding.timecode).toBeUndefined(); expect(fake.timecodes.size).toBe(0);
  noBackups.record.mockClear();
  const first = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: plain.binding, timecodeStartMs: 480000,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: plain.binding.points[index]!.cue, delayMs: 0 }] })) });
  expect(first.binding.timecode).toMatchObject({ number: 9000, offset: 14400, slot: 'TC Slot 2' });
  expect(first.binding.points.map(point => point.atMs)).toEqual(song.points.map(point => point.atMs));
  const show = inspectMa2TimecodeXml(fake.timecodes.get(9000)!).timecodes[0]!;
  expect(show.tracks[0]!.executorAddress).toEqual(['30', '1', '1000', '101']);
  const report = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(show.tracks[0]!.subtracks[0]!.events.map(event => [event.attributes.time ?? '0', event.cueAddress[2]])).toEqual(first.binding.points.map((point, index) => [String(index * 30), String(report.cues.find(cue => Number(cue.number) === Number(point.cue))!.index)]));
  expect(noBackups.record).toHaveBeenCalledWith(fake.bridge, expect.objectContaining({ object: 'Timecode 9000' }));
  const later = song.points.map((point, index) => ({ ...point, atMs: point.atMs + 500, cues: [{ sequence: 9000, cue: first.binding.points[index]!.cue, delayMs: 0 }] }));
  const second = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: first.binding, timecodeStartMs: 480000, points: later });
  expect(second.binding.timecode!.number).toBe(9000); expect(second.binding.timecode!.revision).not.toBe(first.binding.timecode!.revision);
  expect(inspectMa2TimecodeXml(fake.timecodes.get(9000)!).timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.attributes.time).toBe('45');
  fake.timecodes.set(9000, fake.timecodes.get(9000)!.replace('name="GeQu', 'name="控台改过 GeQu'));
  noBackups.record.mockClear();
  const third = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: second.binding, timecodeStartMs: 480000, points: later.map(point => ({ ...point, atMs: point.atMs + 100 })) });
  expect(third.binding.timecode!.number).toBe(9000);
  expect(fake.timecodes.get(9000)).not.toContain('控台改过');
  expect(inspectMa2TimecodeXml(fake.timecodes.get(9000)!).timecodes[0]!.tracks[0]!.subtracks[0]!.events[1]!.attributes.time).toBe('48');
  expect(noBackups.record).toHaveBeenCalledWith(fake.bridge, expect.objectContaining({ object: 'Timecode 9000' }));
}, 20000);
it('控台上挪了、删了本曲时间码节目里的触发：同步读回联动台，挪动不重写节目，删掉的点的 Cue 留在序列里（2026-10-26 双向）', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const plain = await service.syncSong(fake.connection, fake.bridge, song);
  const timed = (binding: Ma2SongSyncResult['binding'], points = song.points): Ma2SongSyncRequest => ({ ...song, requestId: randomUUID(), binding, timecodeStartMs: 480000,
    points: points.map(point => ({ ...point, cues: [{ sequence: 9000, cue: binding.points.find(value => value.id === point.id)!.cue, delayMs: 0 }] })) });
  const first = await service.syncSong(fake.connection, fake.bridge, timed(plain.binding));
  // The operator moves the second point from frame 30 to 45 on the console.
  fake.timecodes.set(9000, fake.timecodes.get(9000)!.replace(/(<Event\b[^>]*\btime=")30(")/, '$145$2'));
  noBackups.record.mockClear(); let ops = fake.ops.length;
  const moved = await service.syncSong(fake.connection, fake.bridge, timed(first.binding));
  expect(moved.consoleEdits).toEqual({ moved: [{ id: 'point-1', atMs: 1500 }], removed: [], added: [] });
  expect(moved.binding.points[1]).toMatchObject({ id: 'point-1', atMs: 1500 });
  expect(moved.binding.timecode!.revision).not.toBe(first.binding.timecode!.revision);
  expect(fake.ops.slice(ops)).not.toContain('APPLY 9000');
  expect(noBackups.record).not.toHaveBeenCalledWith(fake.bridge, expect.objectContaining({ object: 'Timecode 9000' }));
  // The software now holds the console's time; syncing it again changes nothing.
  const local = song.points.map(point => point.id === 'point-1' ? { ...point, atMs: 1500 } : point);
  ops = fake.ops.length;
  const again = await service.syncSong(fake.connection, fake.bridge, timed(moved.binding, local));
  expect(again.consoleEdits).toBeUndefined(); expect(again.changed).toBe(false); expect(fake.ops.slice(ops)).not.toContain('APPLY 9000');
  // The operator deletes the third point's trigger: the point leaves the timeline, its Cue stays in the Sequence.
  const full = fake.timecodes.get(9000)!;
  const trigger = /<Event\b[^>]*\btime="60"[^>]*>[\s\S]*?<\/Event>/.exec(full)![0];
  fake.timecodes.set(9000, full.replace(trigger, ''));
  const removed = await service.syncSong(fake.connection, fake.bridge, timed(again.binding, local));
  expect(removed.consoleEdits).toEqual({ moved: [], removed: ['point-2'], added: [] });
  expect(removed.binding.points.map(point => point.id)).not.toContain('point-2');
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues).toHaveLength(8);
  expect(inspectMa2TimecodeXml(fake.timecodes.get(9000)!).timecodes[0]!.tracks[0]!.subtracks[0]!.events).toHaveLength(7);
  // The operator fires that Cue again from the show: it comes back as a new point, nothing is written.
  fake.timecodes.set(9000, full);
  const kept = local.filter(point => point.id !== 'point-2');
  ops = fake.ops.length;
  const added = await service.syncSong(fake.connection, fake.bridge, timed(removed.binding, kept));
  expect(added.consoleEdits).toMatchObject({ moved: [], removed: [], added: [{ atMs: 2000, cue: first.binding.points[2]!.cue }] });
  expect(added.binding.points.map(point => [point.cue, point.atMs])).toContainEqual([first.binding.points[2]!.cue, 2000]);
  expect(fake.ops.slice(ops)).not.toContain('APPLY 9000');
}, 20000);
it('新建本曲节目后写入失败：编号已记进同步记录，重试读回同一编号重写，不另建；导入了一半的节目也在同一编号重写', async () => {
  for (const imported of [false, true]) {
    const { song, sequences } = boundSong();
    const fake = songConsole(sequences);
    const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
    const plain = await service.syncSong(fake.connection, fake.bridge, song);
    // The project never received a Timecode record: every attempt sends the binding without one.
    const timed = (): Ma2SongSyncRequest => ({ ...song, requestId: randomUUID(), binding: plain.binding, timecodeStartMs: 480000,
      points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: plain.binding.points[index]!.cue, delayMs: 0 }] })) });
    const exchange: Ma2OnpcBridge['exchange'] = async (...args) => {
      if (args[0] !== 'APPLY') return await fake.bridge.exchange(...args);
      if (imported) fake.timecodes.set(args[1], args[3]!.replace('name="GeQu', 'name="回读不一致 GeQu'));
      throw new Error('MA2 响应超时，操作没有确认，不会自动重试');
    };
    const failing = { exchange, request: async (...args: Parameters<Ma2OnpcBridge['exchange']>) => (await exchange(...args)).response };
    await expect(service.syncSong(fake.connection, failing, timed())).rejects.toThrow('MA2 响应超时');
    expect([...fake.timecodes.keys()]).toEqual([9000]);
    expect((await service.syncSong(fake.connection, fake.bridge, timed())).binding.timecode).toMatchObject({ number: 9000, offset: 14400 });
    expect(fake.timecodes.get(9000)).not.toContain('对不上');
    expect([...fake.timecodes.keys()]).toEqual([9000]);
  }
}, 30000);
it('新歌（2026-10-26 第 7 点）：序列与时间码节目用同一个两边都空的编号；写前控台上有人占了这个号时不写、不认领，下次顺延', async () => {
  const sequences = new Map<number, string>();
  const fake = songConsole(sequences);
  // Someone's own show already sits on the first number; the song moves on to the next number free in both pools.
  fake.timecodes.set(9000, '<MA/>');
  const file = join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json');
  const service = new Ma2LayoutService(file, () => false, noBackups), projectId = randomUUID();
  const song = (): Ma2SongSyncRequest => ({ ...songRequest(), projectId, requestId: randomUUID(), timecodeStartMs: 480000,
    points: [{ id: 'a', name: '前奏', atMs: 0, cues: [] }, { id: 'b', name: '副歌', atMs: 2000, cues: [] }] });
  const plain = fake.bridge.exchange.getMockImplementation()!;
  let taken = false;
  fake.bridge.exchange.mockImplementation(async (...args) => {
    const response = await plain(...args);
    // The operator stores a Sequence on that number on the console after the software chose it.
    if (args[0] === 'PAGE' && !taken) { taken = true; sequences.set(9001, emptyMa2SequenceXml(9001, '3.7.0.5')); }
    return response;
  });
  await expect(service.syncSong(fake.connection, fake.bridge, song())).rejects.toThrow('控台同时在改：序列 9001 在控台上刚被占用');
  expect(sequences.get(9001)).toBe(emptyMa2SequenceXml(9001, '3.7.0.5'));
  // Nothing was written, so no half-written record is left that a retry could resume into the operator's Sequence.
  expect(JSON.parse(await readFile(`${file}.songs.json`, 'utf8'))).toEqual([]);
  const result = await service.syncSong(fake.connection, fake.bridge, song());
  expect(result.binding).toMatchObject({ sequence: 9002, executor: '1000.102', timecode: { number: 9002, offset: 14400 } });
  expect(sequences.get(9001)).toBe(emptyMa2SequenceXml(9001, '3.7.0.5'));
  expect(fake.timecodes.get(9000)).toBe('<MA/>');
}, 20000);
it('已绑定歌曲写前发现控台上刚改过本曲序列：不写入、不留续写记录，下次读控台新内容再写', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const file = join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json');
  const service = new Ma2LayoutService(file, () => false, noBackups);
  const first = await service.syncSong(fake.connection, fake.bridge, song);
  const journal: unknown = JSON.parse(await readFile(`${file}.songs.json`, 'utf8'));
  // A new empty point: the song's snapshot is imported, behind the guard that compares the console with what was read.
  const edited = [...song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: first.binding.points[index]!.cue, delayMs: 0 }] })), { id: 'added', name: '新点', atMs: 9000, cues: [] }];
  const plain = fake.bridge.exchange.getMockImplementation()!;
  let changed = false;
  fake.bridge.exchange.mockImplementation(async (...args) => {
    const response = await plain(...args);
    // The operator relabels the Sequence on the console right after the software read it.
    if (args[0] === 'SEQUENCE' && args[1] === 9000 && !changed) { changed = true; sequences.set(9000, editMa2SongSequence(sequences.get(9000)!, '控台改名', [], [])); }
    return response;
  });
  await expect(service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: first.binding, points: edited })).rejects.toThrow('控台同时在改：序列 9000 在控台上刚被改过');
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.name).toBe('控台改名');
  expect(JSON.parse(await readFile(`${file}.songs.json`, 'utf8'))).toEqual(journal);
  await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: first.binding, points: edited });
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues).toHaveLength(9);
}, 20000);
it('Copy 路径不再二次读取来源：来源在读取后被改，回读校验报出是哪个来源，结果待核对，写前备份保留且不进轮转', async () => {
  const { song, sourceNumber, sequences } = boundSong();
  const fake = songConsole(sequences);
  const read = fake.bridge.exchange;
  fake.bridge.exchange = vi.fn<Ma2OnpcBridge['exchange']>(async (operation, target, ...rest) => {
    const result = await read(operation, target, ...rest);
    // The operator edits the source on the console right after the program read it.
    if (operation === 'SEQCUES' && target === sourceNumber) sequences.set(sourceNumber, sequences.get(sourceNumber)!.replace('<Value>70</Value>', '<Value>71</Value>'));
    return result;
  });
  fake.bridge.request = async (...args: Parameters<Ma2OnpcBridge['exchange']>) => (await fake.bridge.exchange(...args)).response;
  noBackups.record.mockClear();
  const sync = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, song);
  await expect(sync).rejects.toThrow(/写入结果需要确认[\s\S]*tblink_library_[a-f0-9]{32}\.xml 已保留[\s\S]*来源 序列 \d+ · Cue 1\.000[\s\S]*控台上的来源可能在同步期间被改过/);
  expect(fake.ops.filter(op => op === `SEQCUES ${sourceNumber}`)).toHaveLength(1);
  const backup = [...fake.files.keys()].find(name => name.startsWith('tblink_library_'));
  expect(backup).toBeDefined();
  expect(noBackups.record).not.toHaveBeenCalled();
});
it('已绑定歌曲把已有 Cue 换成两个来源的组合：先用控台导出复原该 Cue 自身属性，两个来源都 /merge', async () => {
  const { song, sequences } = boundSong();
  // Sources whose Parts carry nothing but data: static merging (the expected read-back) accepts them.
  sequences.set(9800, `<MA xmlns="http://schemas.malighting.de/grandma2/xml/MA" major_vers="3" minor_vers="7" stream_vers="0"><Sequ index="9800"><Cue index="1"><Number number="1" sub_number="0"/><CuePart index="0"/><CueDatas><CueData><Channel fixture_id="1" attribute_name="DIM"/><Value>70</Value></CueData></CueDatas></Cue><Cue index="2"><Number number="2" sub_number="0"/><CuePart index="0"/><CueDatas><CueData><Channel fixture_id="1" attribute_name="PAN"/><Value>40</Value></CueData></CueDatas></Cue></Sequ></MA>`);
  const sourceNumber = 9800;
  const fake = songConsole(sequences);
  const both = [{ sequence: sourceNumber, cue: '1.000', delayMs: 0 }, { sequence: sourceNumber, cue: '2.000', delayMs: 0 }];
  const result = await new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge,
    { ...song, points: song.points.map((point, index) => index === 0 ? { ...point, cues: both } : point) });
  expect(result.changed).toBe(true);
  expect(fake.keeps).toEqual(['9000/1']);
  const copies = fake.lines.filter(line => line.includes(`Copy Sequence ${sourceNumber} Cue`) && line.includes('At Sequence 9000 Cue 1.000'));
  expect(copies).toHaveLength(2); expect(copies.every(line => line.includes('/merge /nc'))).toBe(true);
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues[0]!;
  expect([...inspectMa2CueData(sequences.get(9000)!, written.index).keys()].map(key => /":attribute_name","(\w+)"/.exec(key)?.[1]).sort()).toEqual(['DIM', 'PAN']);
  expect([...fake.files.keys()].some(name => name.startsWith('tblink_song_'))).toBe(false);
});
it('已绑定歌曲新增一个点位：Copy 直接建出新 Cue 编号；清空一个 Cue 时控台上没有可 Copy 的内容，仍整首导入', async () => {
  const { song, sourceNumber, sequences } = boundSong();
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const first = songConsole(sequences);
  const added = await service.syncSong(first.connection, first.bridge, { ...song, points: [...song.points, { id: 'point-new', name: '新段落', atMs: 9000, cues: [{ sequence: sourceNumber, cue: '1.000', delayMs: 0 }] }] });
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.cues).toHaveLength(9); expect(written.cues.at(-1)!.name).toBe('XinDuanLuo');
  expect(first.lines.some(line => line.includes(`At Sequence 9000 Cue ${written.cues.at(-1)!.number}`))).toBe(true);
  expect([...first.files.keys()].some(name => name.startsWith('tblink_song_'))).toBe(false);
  expect(added.binding.points.at(-1)).toMatchObject({ id: 'point-new', cue: written.cues.at(-1)!.number });
  const fake = songConsole(sequences);
  const self = (index: number) => [{ sequence: 9000, cue: added.binding.points[index]!.cue, delayMs: 0 }];
  await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: added.binding,
    points: [...song.points, { id: 'point-new', name: '新段落', atMs: 9000, cues: self(8) }].map((point, index) => ({ ...point, cues: index === 1 ? [] : self(index) })) });
  expect([...fake.files.keys()].some(name => name.startsWith('tblink_song_'))).toBe(true);
  expect(fake.lines.some(line => line.includes('Copy Sequence'))).toBe(false);
  expect(inspectMa2CueData(sequences.get(9000)!, inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues[1]!.index).size).toBe(0);
}, 20000);
it('控台上整条本曲序列被删掉：不再整读，按上次确认的内容和时间线重建同一序列', async () => {
  const { song, sourceNumber, sequences } = boundSong();
  sequences.delete(9000);
  const fake = songConsole(sequences);
  const result = await new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, song);
  expect(fake.ops).not.toContain('SEQUENCE 9000 keep');
  expect(fake.ops.filter(op => op === 'SEQUENCE 9000')).toHaveLength(1);
  const rebuilt = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(rebuilt.cues.map(cue => cue.number)).toEqual(song.binding!.points.map(point => point.cue));
  expect(inspectMa2CueData(sequences.get(9000)!, rebuilt.cues[0]!.index)).toEqual(inspectMa2CueData(sequences.get(sourceNumber)!, 1));
  expect(result.binding).toMatchObject({ sequence: 9000, executor: '1000.101' });
}, 20000);
it('时间线全删后重新加同样多的 Cue：控台删掉旧 Cue 并在原编号写新内容，数量不叠加', async () => {
  // 2026-10-24 现场：30 个 Cue 删除后重加，控台上变成 65 个。
  const { song, sourceNumber, sequences } = boundSong();
  const fake = songConsole(sequences);
  const again = song.points.map((point, index) => ({ ...point, id: `again-${index}`, name: `新加 ${index + 1}`, cues: [{ sequence: sourceNumber, cue: '1.000', delayMs: 0 }] }));
  const result = await new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups).syncSong(fake.connection, fake.bridge, { ...song, points: again });
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.cues).toHaveLength(8);
  expect(written.cues.map(cue => cue.name)).toEqual(again.map((_, index) => `XinJia ${index + 1}`));
  expect(result.binding.points.map(point => point.cue)).toEqual(song.binding!.points.map(point => point.cue));
}, 20000);
it('已绑定歌曲新增 Cue 的 Copy 已执行但回包丢失：再次同步从中断记录续上，不重复新建', async () => {
  const { song, sourceNumber, sequences } = boundSong();
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const request = { ...song, points: [...song.points, { id: 'point-new', name: '新段落', atMs: 9000, cues: [{ sequence: sourceNumber, cue: '1.000', delayMs: 0 }] }] };
  const fake = songConsole(sequences); const send = fake.connection.command; let dropped = false;
  fake.connection.command = vi.fn<Ma2Telnet['command']>(async (line, match, ...rest) => {
    const reply = await send(line, match, ...rest);
    if (!dropped && line.includes('At Sequence 9000 Cue 9.000')) { dropped = true; throw new Error('连接中断'); }
    return reply;
  });
  await expect(service.syncSong(fake.connection, fake.bridge, request)).rejects.toThrow('连接中断');
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues).toHaveLength(9);
  const resumed = await service.syncSong(fake.connection, fake.bridge, { ...request, requestId: randomUUID() });
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.cues).toHaveLength(9); expect(written.cues.at(-1)).toMatchObject({ number: '9.000', name: 'XinDuanLuo' });
  expect(resumed.binding.points.at(-1)).toEqual({ id: 'point-new', cue: '9.000' });
}, 20000);
it('控台上已有的中文名默认不改写：只换一个 Cue 的内容时其余名称保持原样', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const result = await service.syncSong(fake.connection, fake.bridge, song);
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.name).toBe('歌曲');
  expect(written.cues.map(cue => cue.name)).toEqual(Array.from({ length: 8 }, (_, index) => `段落 ${index + 1}`));
  const again = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: result.binding,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: result.binding.points[index]!.cue, delayMs: 0 }] })) });
  expect(again.changed).toBe(false);
});
it('只改名字时写入拼音；新歌和新 Cue 直接写拼音', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const renamed = { ...song, points: song.points.map((point, index) => index === 1 ? { ...point, name: '新副歌' } : point) };
  await service.syncSong(fake.connection, fake.bridge, renamed);
  expect(inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!.cues.map(cue => cue.name).slice(0, 3)).toEqual(['段落 1', 'XinFuGe', '段落 3']);
});
it('显式要求时把控台上软件写过的中文名改为拼音，用回读结果再次同步不再判为改名', async () => {
  const { song, sequences } = boundSong();
  const fake = songConsole(sequences);
  const service = new Ma2LayoutService(join(await mkdtemp(join(tmpdir(), 'tblink-song-')), 'layouts.json'), () => false, noBackups);
  const first = await service.syncSong(fake.connection, fake.bridge, { ...song, rewriteLegacyNames: true });
  const written = inspectMa2SequenceXml(sequences.get(9000)!).sequences[0]!;
  expect(written.name).toBe('GeQu');
  expect(written.cues.map(cue => cue.name)).toEqual(Array.from({ length: 8 }, (_, index) => `DuanLuo ${index + 1}`));
  const again = await service.syncSong(fake.connection, fake.bridge, { ...song, requestId: randomUUID(), binding: first.binding,
    points: song.points.map((point, index) => ({ ...point, cues: [{ sequence: 9000, cue: first.binding.points[index]!.cue, delayMs: 0 }] })) });
  expect(again.changed).toBe(false);
});
