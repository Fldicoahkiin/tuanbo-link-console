import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { ma2ObjectDirectorySchema, ma2TimecodeRangesSchema } from '@tb/schema';
import { Ma2LayoutService } from './ma2-layout-service';
import { Ma2ConsoleBackups } from './ma2-console-backups';
import { Ma2SongWatch } from './ma2-song-watch';
import { listMa2ExecutorPages } from './ma2-executor-page';
import { expect, it } from 'vitest';
import { Ma2Telnet, ma2ResponseLine } from './ma2-telnet';
import { ensureMa2NetworkBridge } from './ma2-bridge-installer';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { createMa2Timecode } from './ma2-create';
import { inspectMa2SequenceXml, inspectMa2TimecodeXml, sameMa2XmlObjects } from './ma2-timecode-xml';
import { readMa2NativeLibrary } from './ma2-native-library';
import { ma2SongTimecodeXml } from './ma2-song-timecode';
import { createMa2TimecodeXml } from './ma2-create';
import { showStopped } from './fixtures/show-gates';

it.runIf(Boolean(process.env.TBLINK_MA2_HARDWARE_LIBRARY))('实体控台素材结构只读诊断', async () => {
  const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  try {
    await connection.connect('administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    const marker = `TBLINK_TEST_${randomBytes(16).toString('hex')}:`;
    const data = await connection.command(`Lua "local o=gma.show.getobj;local h=o.handle('Sequence 1');local r={};for i=0,math.min(o.amount(h)-1,10) do local c=o.child(h,i);if c then r[#r+1]=tostring(o.number(c))..','..tostring(o.name(c))..','..tostring(o.class(c)) end end;gma.echo('${marker}'..table.concat(r,';'))"`, text => ma2ResponseLine(text, marker));
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/cue-structure.txt'), data);
  } finally { connection.disconnect(); }
});

it.runIf(Boolean(process.env.TBLINK_MA2_HARDWARE_LIBRARY))('实体控台读取完整素材库', async () => {
  const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  try {
    await connection.connect('administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(connection, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const library = await readMa2NativeLibrary(connection, new Ma2OnpcBridge(new Ma2NetworkWire(connection), showStopped), showStopped);
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/effect-library.json'), JSON.stringify(library, null, 2));
    console.info(JSON.stringify({ sequences: library.sequences.length, cues: library.sequences.reduce((count, sequence) => count + sequence.cues.length, 0), errors: library.errors }));
    expect(library.sequences.length).toBeGreaterThan(0);
    expect(library.errors).toEqual([]);
  } finally { connection.disconnect(); }
}, 600000);

it.runIf(Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('实体控台自动部署内存桥并只读扫描工程目录', async () => {
  const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  const directory = resolve('artifacts/ma2-hardware-diagnostics');
  await mkdir(directory, { recursive: true });
  try {
    const version = await connection.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    const source = await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8');
    await ensureMa2NetworkBridge(connection, source);
    // Reconnecting to the same version must reuse the session, not restart it.
    await ensureMa2NetworkBridge(connection, source);
    const wire = new Ma2NetworkWire(connection);
    expect(await wire.exchange(randomBytes(16).toString('hex'), 'PING', 1, '', () => undefined)).toBe(version);
    const timecodes = await wire.exchange(randomBytes(16).toString('hex'), 'LIST', 1, '', () => undefined);
    await writeFile(resolve(directory, 'timecode-directory.json'), timecodes);
    const sequences = await wire.exchange(randomBytes(16).toString('hex'), 'LISTSEQ', 1, '', () => undefined);
    await writeFile(resolve(directory, 'sequence-directory.json'), sequences);
    expect(JSON.parse(timecodes)).toHaveProperty('entries');
    expect(JSON.parse(sequences)).toHaveProperty('entries');
    await writeFile(resolve(directory, 'bridge-acceptance.json'), JSON.stringify({ version, memoryBridge: true, ping: true, timecodeDirectory: true, sequenceDirectory: true, at: new Date().toISOString() }, null, 2));
  } finally { connection.disconnect(); }
}, 120000);

it.runIf(process.env.TBLINK_MA2_HARDWARE_WRITE === '1')('实体控台专属空时间线创建、备份写回和还原', async () => {
  const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  try {
    await connection.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(connection, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(connection), showStopped);
    // CREATE refuses an occupied number. No existing user object is reused.
    await createMa2Timecode(bridge, 9905, 'TBLINK_HARDWARE_ACCEPTANCE');
    const original = await bridge.request('READ', 9905);
    const desired = original.replace('name="TBLINK_HARDWARE_ACCEPTANCE"', 'name="TBLINK_HARDWARE_VERIFIED"');
    expect(desired).not.toBe(original);
    const receipt = await bridge.exchange('APPLY', 9905, original, desired);
    const changed = await bridge.request('READ', 9905);
    expect(sameMa2XmlObjects(changed, desired)).toBe(true);
    await bridge.request('APPLY', 9905, changed, original);
    const restored = await bridge.request('READ', 9905);
    expect(sameMa2XmlObjects(restored, original)).toBe(true);
    const sample = await bridge.request('READ', 1);
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/timecode-1.xml'), sample);
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/write-acceptance.json'), JSON.stringify({ target: 9905, emptyTestObjectOnly: true, written: true, restored: true, backup: `tblink_backup_${receipt.requestId}.xml`, existingTimecodeRead: 1 }, null, 2));
  } finally { connection.disconnect(); }
}, 120000);

// Read-only probe: each line carries one Lua string of known length and only echoes that length.
it.runIf(Boolean(process.env.TBLINK_MA2_LENGTH_PROBE && process.env.TBLINK_MA2_HARDWARE_HOST))('控台命令行单行长度上限只读探测', async () => {
  const results: Array<{ bytes: number; echoed: number | null; host: string | null; error: string | null }> = [];
  for (const bytes of [600, 900, 1000, 1024, 1100, 1500, 2048, 3000, 4000]) {
    const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 }, () => undefined, 3000);
    try {
      await connection.connect('administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
      const marker = `TBLINK_LEN_${randomBytes(16).toString('hex')}:`;
      const line = (count: number): string => `Lua "local s='${'a'.repeat(count)}';gma.echo('${marker}'..#s..':'..tostring(gma.show.getvar('HOSTTYPE')))"`;
      const count = bytes - Buffer.byteLength(line(0));
      const reply = await connection.command(line(count), text => ma2ResponseLine(text, marker));
      const [echoed, host] = reply.split(':');
      results.push({ bytes, echoed: Number(echoed) === count ? Buffer.byteLength(line(count)) : Number(echoed), host: host ?? null, error: null });
    } catch (error) { results.push({ bytes, echoed: null, host: null, error: error instanceof Error ? error.message : String(error) }); }
    finally { connection.disconnect(); }
  }
  await mkdir(resolve('artifacts/ma2-hardware-diagnostics'), { recursive: true });
  await writeFile(resolve('artifacts/ma2-hardware-diagnostics/command-length.json'), JSON.stringify(results, null, 2));
  console.info(JSON.stringify(results));
  expect(results[0]?.echoed).toBe(600);
}, 120000);

// Read-only probe: which characters reach Lua unchanged through the native command interpreter.
it.runIf(Boolean(process.env.TBLINK_MA2_LENGTH_PROBE && process.env.TBLINK_MA2_HARDWARE_HOST))('控台命令行字符原样传递只读探测', async () => {
  const characters = ['*', '%', '[', ']', '(', ')', '-', '+', '.', ',', ';', ':', '/', '<', '>', '=', '#', '@', '!', '~', '&', '{', '}', '?', '_', '|', '^', '$'];
  const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 }, () => undefined, 3000);
  const results: Record<string, string> = {};
  try {
    await connection.connect('administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    for (const character of characters) {
      const marker = `TBLINK_CHR_${randomBytes(16).toString('hex')}:`;
      try {
        const reply = await connection.command(`Lua "local s='x${character}y';gma.echo('${marker}'..(s:gsub('.',function(c)return string.format('%02x',c:byte())end)))"`, text => ma2ResponseLine(text, marker));
        results[character] = Buffer.from(reply, 'hex').toString('utf8') === `x${character}y` ? 'same' : `changed:${Buffer.from(reply, 'hex').toString('utf8')}`;
      } catch (error) { results[character] = `error:${error instanceof Error ? error.message : String(error)}`; break; }
    }
  } finally { connection.disconnect(); }
  await mkdir(resolve('artifacts/ma2-hardware-diagnostics'), { recursive: true });
  await writeFile(resolve('artifacts/ma2-hardware-diagnostics/command-characters.json'), JSON.stringify(results, null, 2));
  console.info(JSON.stringify(results));
  expect(results['*']).toBeDefined();
}, 120000);

// Writes only objects it creates: a free Sequence >= 9950 and a new executor Page >= 9890, both deleted afterwards.
it.runIf(process.env.TBLINK_MA2_SONG_WRITE === '1' && Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('onPC 歌曲序列新建、改一个 Cue 内容与复查的实测往返', async () => {
  const raw = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  const traffic = { commands: 0, bytes: 0 };
  const slowest: Array<{ action: string; ms: number }> = [];
  const connection: Pick<Ma2Telnet, 'command'> = { command: async (line, match, beforeSend, priority) => {
    traffic.commands += 1; traffic.bytes += Buffer.byteLength(line);
    const started = performance.now();
    try { return await raw.command(line, match, beforeSend, priority); }
    finally {
      const action = /TBLINK_NET\('[a-f0-9]+','(\w+)'/.exec(line)?.[1] ?? /^Lua "([^;(]{0,24})/.exec(line)?.[1] ?? 'other';
      slowest.push({ action, ms: Math.round(performance.now() - started) }); slowest.sort((a, b) => b.ms - a.ms); slowest.splice(5);
    }
  } };
  const measured: Record<string, { ms: number; commands: number; bytes: number }> = {};
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const before = { ...traffic }; const started = performance.now();
    const value = await run();
    measured[name] = { ms: Math.round(performance.now() - started), commands: traffic.commands - before.commands, bytes: traffic.bytes - before.bytes };
    return value;
  };
  let created: { sequence: number; page: number; timecode?: number } | null = null;
  const operations: Array<{ label: string; ms: number; commands: number; received: number }> = [];
  try {
    await raw.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(raw, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const native = new Ma2OnpcBridge(new Ma2NetworkWire(connection), showStopped);
    const timed = async <T extends string | { response: string }>(label: string, run: () => Promise<T>): Promise<T> => {
      const before = { ...traffic }; const started = performance.now();
      try { const value = await run(); operations.push({ label, ms: Math.round(performance.now() - started), commands: traffic.commands - before.commands, received: Buffer.byteLength(typeof value === 'string' ? value : value.response) }); return value; }
      catch (error) { operations.push({ label: `${label} 失败`, ms: Math.round(performance.now() - started), commands: traffic.commands - before.commands, received: 0 }); throw error; }
    };
    const bridge: Pick<Ma2OnpcBridge, 'request' | 'exchange'> = {
      request: (operation, target, expected, desired, signal) => timed(`${operation} ${target}`, () => native.request(operation, target, expected, desired, signal)),
      exchange: (operation, target, expected, desired, signal) => timed(`${operation} ${target}`, () => native.exchange(operation, target, expected, desired, signal))
    };
    const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
    const pages = await listMa2ExecutorPages(bridge, { network: { host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001, username: 'administrator' }, expectedSource: { show: directory.show, generation: directory.generation, version: directory.version } });
    const library = await readMa2NativeLibrary(connection, bridge, showStopped, undefined, 'library', undefined, directory.entries.filter(entry => entry.target < 9950).slice(0, 12).map(entry => entry.target));
    const source = library.sequences.find(value => value.cues.length >= 2);
    if (!source) throw new Error('测试 Show 前 12 个序列中没有至少 2 个 Cue 的序列');
    let sequence = 9950; while (directory.entries.some(entry => entry.target === sequence)) sequence += 1;
    let page = 9890; while (pages.pages.some(value => value.page === page)) page += 1;
    created = { sequence, page };
    const network = { host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001, username: 'administrator' };
    const expectedSource = { show: directory.show, generation: directory.generation, version: directory.version };
    const ref = (index: number) => [{ sequence: source.sequence, cue: source.cues[index]!.number, delayMs: 0 }];
    const points = [{ id: 'p1', name: '探针开场', atMs: 0, cues: ref(0) }, { id: 'p2', name: '探针副歌', atMs: 1000, cues: ref(1) }, { id: 'p3', name: '探针尾声', atMs: 2000, cues: [] }];
    const workspace = await mkdtemp(join(tmpdir(), 'tblink-song-probe-'));
    const service = new Ma2LayoutService(resolve(workspace, 'layouts.json'), showStopped, new Ma2ConsoleBackups(resolve(workspace, 'backups.json'), showStopped, message => Promise.reject(new Error(message))));
    const base = { network, expectedSource, projectId: randomUUID(), itemId: 'probe', settings: { layout: 999, name: 'TBLINK', nextSequence: sequence, columns: 8, executorPage: page }, name: '联动探针歌曲', timecodeStartMs: 480000 };
    const first = await step('create', () => service.syncSong(connection, bridge, { ...base, requestId: randomUUID(), points }));
    created = { sequence, page, ...first.binding.timecode ? { timecode: first.binding.timecode.number } : {} };
    // The operator tunes the first Cue's fade on the console; the next sync adopts it into the baseline.
    const tuned = first.binding.points[0]!.cue;
    const marker = `TBLINK_FADE_${randomBytes(16).toString('hex')}:`;
    expect(await raw.command(`Lua "gma.cmd('Assign Sequence ${sequence} Cue ${tuned} /fade=7');gma.echo('${marker}ok')"`, text => ma2ResponseLine(text, marker))).toBe('ok');
    // Each sync hands its verified post-write export to the song check, as the network manager does.
    const watch = new Ma2SongWatch(showStopped);
    const checkOf = (result: typeof first) => ({ network, expectedSource, sequence, executor: result.binding.executor!, revision: result.remoteRevision! });
    const adoptReadback = (exportFile: string, result: typeof first): Promise<boolean> => watch.adopt(connection, checkOf(result), exportFile);
    const second = await step('changeOneCue', () => service.syncSong(connection, bridge, { ...base, requestId: randomUUID(), binding: first.binding,
      points: first.binding.points.map((point, index) => ({ ...points[index]!, cues: index === 2 ? ref(0) : [{ sequence, cue: point.cue, delayMs: 0 }] })) }, undefined, undefined, { adoptReadback }));
    const fadeOf = (xml: string): string | undefined => {
      const [whole, fraction = ''] = tuned.split('.');
      const cue = xml.split('<Cue index=').find(part => part.includes(`<Number number="${Number(whole)}" sub_number="${Number(fraction.padEnd(3, '0'))}"`));
      return /<CuePart\b[^>]*\bbasic_fade="([^"]*)"/.exec(cue ?? '')?.[1];
    };
    expect(fadeOf(await bridge.request('SEQUENCE', sequence))).toBe('7');
    // The adopted readback makes the first check after a sync a console-side compare, not a full read.
    const self = (point: { cue: string }) => [{ sequence, cue: point.cue, delayMs: 0 }];
    const recheck = async (result: typeof first, label: string): Promise<string> => {
      expect(await step(label, () => watch.changed(connection, bridge, checkOf(result)))).toBe(false);
      const baseline = await watch.unchangedBaseline(connection, { network, expectedSource, sequence, executor: result.binding.executor! }, result.binding.baselineXml);
      expect(baseline).toMatch(/^tblink_watch_[a-f0-9]{16}$/);
      return baseline!;
    };
    const warmBaseline = await recheck(second, 'firstCheck');
    const unchanged = await step('cachedCheck', () => watch.changed(connection, bridge, checkOf(second)));
    const warm = await step('changeOneCueWarm', () => service.syncSong(connection, bridge, { ...base, requestId: randomUUID(), binding: second.binding,
      points: second.binding.points.map((point, index) => ({ ...points[index]!, cues: index === 1 ? ref(0) : self(point) })) }, undefined, undefined, { consoleBaseline: warmBaseline, adoptReadback }));
    expect(warm.changed).toBe(true);
    // Combining two sources into that Cue keeps the console's fade instead of the first source's.
    const combineBaseline = await recheck(warm, 'checkAfterWarm');
    const combined = await step('combineExistingWarm', () => service.syncSong(connection, bridge, { ...base, requestId: randomUUID(), binding: warm.binding,
      points: warm.binding.points.map((point, index) => ({ ...points[index]!, cues: index === 0 ? [...ref(0), ...ref(1)] : self(point) })) }, undefined, undefined, { consoleBaseline: combineBaseline, adoptReadback }));
    expect(combined.changed).toBe(true);
    expect(fadeOf(await bridge.request('SEQUENCE', sequence))).toBe('7');
    // The song's own Timecode show, read back from the console: start, slot, executor track and one Goto per point.
    const own = combined.binding.timecode!;
    expect(own).toMatchObject({ offset: 14400, slot: 'TC Slot 2' });
    const shown = inspectMa2TimecodeXml(await bridge.request('READ', own.number)).timecodes[0]!;
    const steps = inspectMa2SequenceXml(await bridge.request('SEQUENCE', sequence)).sequences[0]!.cues;
    expect(shown.attributes).toMatchObject({ offset: '14400', slot: 'TC Slot 2', frame_format: '30 FPS', m_autostart: 'true' });
    expect(shown.tracks.map(track => track.executorAddress.join('.'))).toEqual([`30.1.${combined.binding.executor}`]);
    expect(shown.tracks[0]!.subtracks[0]!.events.map(event => [event.attributes.time ?? '0', event.cueAddress.join('/')]))
      .toEqual(combined.binding.points.map(point => [String(Math.round(point.atMs! * 30 / 1000)), `1/${sequence}/${steps.find(cue => Number(cue.number) === Number(point.cue))!.index}`]));
    console.info(JSON.stringify({ timecode: own, events: shown.tracks[0]!.subtracks[0]!.events.length }));
    await mkdir(resolve('artifacts/ma2-hardware-diagnostics'), { recursive: true });
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/song-transfer.json'), JSON.stringify({ at: new Date().toISOString(), show: directory.show, version: directory.version, source: source.sequence, sequence, page, backupFile: second.backupFile, measured }, null, 2));
    console.info(JSON.stringify({ sequence, page, backupFile: second.backupFile, measured }));
    expect(second.changed).toBe(true); expect(unchanged).toBe(false);
    expect(second.binding.name).toBe('LianDongTanZhenGeQu');
    expect(second.library.sequences[0]?.cues.map(cue => cue.name)).toEqual(['TanZhenKaiChang', 'TanZhenFuGe', 'TanZhenWeiSheng']);
    expect(second.backupFile).toMatch(/^tblink_library_[a-f0-9]{32}\.xml$/);
  } finally {
    console.info(JSON.stringify({ operations, measured, slowest }));
    if (created && raw.state === 'connected') {
      const marker = `TBLINK_CLEAN_${randomBytes(16).toString('hex')}:`;
      const removed = await raw.command(`Lua "gma.cmd('Delete Sequence ${created.sequence} /nc');gma.cmd('Delete Page ${created.page} /nc');${created.timecode ? `gma.cmd('Delete Timecode ${created.timecode} /nc');` : ''}gma.echo('${marker}'..tostring(gma.show.getobj.handle('Sequence ${created.sequence}')==nil and gma.show.getobj.handle('Page ${created.page}')==nil))"`, text => ma2ResponseLine(text, marker));
      expect(removed).toBe('true');
    }
    raw.disconnect();
  }
}, 600000);

// Read-only: a PING transaction left open by a dropped session is released by its id from a new session.
it.runIf(Boolean(process.env.TBLINK_MA2_LENGTH_PROBE && process.env.TBLINK_MA2_HARDWARE_HOST))('断线遗留的插件占用可在新会话按原编号释放', async () => {
  const open = async (): Promise<Ma2Telnet> => {
    const connection = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
    await connection.connect('administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(connection, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    return connection;
  };
  const rpc = async (connection: Ma2Telnet, action: string, id: string, args = ''): Promise<string> => {
    const token = randomBytes(16).toString('hex');
    return connection.command(`Lua "TBLINK_NET('${token}','${action}','${id}'${args})"`, text => ma2ResponseLine(text, `TBLINK_RPC_${token}:`));
  };
  const stale = randomBytes(16).toString('hex');
  const first = await open();
  expect(await rpc(first, 'begin', stale, ",'PING',1,0")).toBe('ACK');
  first.disconnect();
  const second = await open();
  try {
    const blocked = await rpc(second, 'begin', randomBytes(16).toString('hex'), ",'PING',1,0");
    expect(Buffer.from(blocked.replace(/^ERR:/, ''), 'hex').toString('utf8')).toContain('Another network request is pending');
    expect(await rpc(second, 'release', stale)).toBe('ACK');
    const fresh = randomBytes(16).toString('hex');
    expect(await rpc(second, 'begin', fresh, ",'PING',1,0")).toBe('ACK');
    expect(await rpc(second, 'release', fresh)).toBe('ACK');
  } finally { second.disconnect(); }
}, 120000);

// Writes one scratch Sequence (deleted afterwards): how Copy behaves on a song that already exists on the console.
it.runIf(process.env.TBLINK_MA2_COPY_PROBE === '1' && Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('onPC 已有序列内 Copy Cue 的语义探测', async () => {
  const raw = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  const results: Record<string, string> = {};
  let created: { sequence: number; page: number | null } | null = null;
  // Lua runs inside Lua "…": no double quotes, and MA consumes $ ^ | on the command line.
  const lua = async (label: string, code: string): Promise<string> => {
    const marker = `TBLINK_PROBE_${randomBytes(16).toString('hex')}:`;
    const value = await raw.command(`Lua "${code};gma.echo('${marker}'..tostring(TBPR))"`, text => ma2ResponseLine(text, marker));
    results[label] = value; return value;
  };
  try {
    await raw.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(raw, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(raw), showStopped);
    const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
    const library = await readMa2NativeLibrary(raw, bridge, showStopped, undefined, 'library', undefined, directory.entries.filter(entry => entry.target < 9950).slice(0, 12).map(entry => entry.target));
    const source = library.sequences.find(value => value.cues.length >= 2);
    if (!source) throw new Error('测试 Show 前 12 个序列中没有至少 2 个 Cue 的序列');
    const parts = (cue: string): string => { const [whole, fraction = ''] = cue.split('.'); return `'${Number(whole)}','${Number(fraction.padEnd(3, '0'))}'`; };
    const [c1, c2] = [source.cues[0]!.number, source.cues[1]!.number];
    const S = source.sequence;
    let T = 9950; while (directory.entries.some(entry => entry.target === T)) T += 1;
    created = { sequence: T, page: null };
    await lua('define-find', "_G.TBPC=function(s,w,u) local q=string.char(34);local n='tblink_probe_'..s;gma.cmd('Export Sequence '..s..' '..n..' /o');local p=gma.show.getvar('PATH')..'/importexport/'..n..'.xml';local f=io.open(p,'rb');if not f then return nil end;local x=f:read('*a');f:close();os.remove(p);local i=x:find('<Number number='..q..w..q..' sub_number='..q..u..q,1,true);if not i then return nil end;local a=1;while true do local j=x:find('<Cue index=',a,true);if not j or j>i then break end;a=j+1 end;return x:sub(a-1,x:find('</Cue>',i,true)) end;TBPR='ok'");
    await lua('define-summary', "_G.TBPS=function(s,w,u) local c=TBPC(s,w,u);if not c then return 'nocue' end;local h=c:sub(1,c:find('>',1,true));local i=c:find('<CuePart',1,true);local p=i and c:sub(i,c:find('>',i,true)) or '';local r=0;for _ in c:gmatch('<CueData[ >]') do r=r+1 end;return h..p..' rows='..r end;TBPR='ok'");
    await lua('define-compare', "_G.TBPD=function(c) local a=c and c:find('<CueDatas',1,true);local b=c and c:find('</CueDatas>',1,true);return a and b and c:sub(a,b) or '' end;_G.TBPQ=function(s1,w1,u1,s2,w2,u2) return tostring(TBPD(TBPC(s1,w1,u1))==TBPD(TBPC(s2,w2,u2))) end;TBPR='ok'");
    const exists = (address: string): string => `tostring(not (gma.show.getobj.handle('${address}')==nil))`;
    await lua('source-c1', `TBPR=TBPS(${S},${parts(c1)})`);
    await lua('source-c2', `TBPR=TBPS(${S},${parts(c2)})`);
    // Q0: does Copy create a Sequence that does not exist yet?
    await lua('copy-into-missing-sequence', `gma.cmd('Copy Sequence ${S} Cue ${c1} At Sequence ${T} Cue 1 /o /nc');TBPR=${exists(`Sequence ${T}`)}..','..${exists(`Sequence ${T} Cue 1`)}`);
    if (results['copy-into-missing-sequence'] !== 'true,true') {
      let page = 9890; const pages = await listMa2ExecutorPages(bridge, { network: { host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001, username: 'administrator' }, expectedSource: { show: directory.show, generation: directory.generation, version: directory.version } });
      while (pages.pages.some(value => value.page === page)) page += 1;
      created = { sequence: T, page };
      const workspace = await mkdtemp(join(tmpdir(), 'tblink-copy-probe-'));
      const service = new Ma2LayoutService(resolve(workspace, 'layouts.json'), showStopped, new Ma2ConsoleBackups(resolve(workspace, 'backups.json'), showStopped, message => Promise.reject(new Error(message))));
      await service.syncSong(raw, bridge, { network: { host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001, username: 'administrator' }, expectedSource: { show: directory.show, generation: directory.generation, version: directory.version },
        projectId: randomUUID(), itemId: 'copy-probe', requestId: randomUUID(), settings: { layout: 999, name: 'TBLINK', nextSequence: T, columns: 8, executorPage: page }, name: 'CopyProbe',
        points: [{ id: 'p1', name: 'Probe', atMs: 0, cues: [{ sequence: S, cue: c1, delayMs: 0 }] }] });
    }
    // Q1: does Copy /o create a Cue number the target Sequence does not have yet?
    await lua('copy-new-cue-number', `gma.cmd('Copy Sequence ${S} Cue ${c2} At Sequence ${T} Cue 7 /o /nc');TBPR=${exists(`Sequence ${T} Cue 7`)}..','..TBPQ(${S},${parts(c2)},${T},'7','0')`);
    // Q2: which Cue attributes survive Copy /o and a following /merge on an existing Cue?
    await lua('target-before', `TBPR=TBPS(${T},'1','0')`);
    await lua('assign-fade', `gma.cmd('Assign Sequence ${T} Cue 1 /fade=7');TBPR=TBPS(${T},'1','0')`);
    await lua('copy-overwrite', `gma.cmd('Copy Sequence ${S} Cue ${c2} At Sequence ${T} Cue 1 /o /nc');TBPR=TBPS(${T},'1','0')..' sameData='..TBPQ(${S},${parts(c2)},${T},'1','0')`);
    await lua('assign-fade-again', `gma.cmd('Assign Sequence ${T} Cue 1 /fade=7');TBPR=TBPS(${T},'1','0')`);
    await lua('copy-merge', `gma.cmd('Copy Sequence ${S} Cue ${c1} At Sequence ${T} Cue 1 /merge /nc');TBPR=TBPS(${T},'1','0')`);
    // Q3: keep every attribute of an existing Cue while replacing its data. The Cue is taken from the
    // console's own export without CueDatas, imported into a scratch Sequence and copied back with /o;
    // the sources are then merged, and /merge keeps the target's attributes.
    let scratch = T + 1; while (directory.entries.some(entry => entry.target === scratch)) scratch += 1;
    await lua('define-strip', "_G.TBPX=function(c) return (c:gsub('<CueDatas>.-</CueDatas>',''):gsub('<CueDatas%s*/>',''):gsub(' index=.%d+.',''):gsub('<Number number=.-/>',''):gsub('%s+',' ')) end;TBPR='ok'");
    await lua('define-attributes', "_G.TBPY=function(t,w) local q=string.char(34);local p=gma.show.getvar('PATH')..'/importexport/';gma.cmd('Export Sequence '..t..' tblink_probe_src /o');local f=io.open(p..'tblink_probe_src.xml','rb');local x=f:read('*a');f:close();os.remove(p..'tblink_probe_src.xml');local i=x:find('<Number number='..q..w..q..' sub_number='..q..'0'..q,1,true);local a=1;while true do local j=x:find('<Cue index=',a,true);if not j or j>i then break end;a=j+1 end;local c=x:sub(a-1,x:find('</Cue>',i,true)+5);c=c:gsub('<CueDatas>.-</CueDatas>',''):gsub('<CueDatas%s*/>',''):gsub('<Cue index=.%d+.','<Cue index='..q..'1'..q,1);return x:sub(1,x:find('<Cue index=',1,true)-1)..c..'</Sequ></MA>' end;TBPR='ok'");
    await lua('define-reset', "_G.TBPZ=function(t,w,s) local p=gma.show.getvar('PATH')..'/importexport/';local o=io.open(p..'tblink_probe_attrs.xml','wb');o:write(TBPY(t,w));o:close();gma.cmd('Import tblink_probe_attrs.xml At Sequence '..s..' /nc');local ok=not (gma.show.getobj.handle('Sequence '..s..' Cue '..w)==nil);if ok then gma.cmd('Copy Sequence '..s..' Cue '..w..' At Sequence '..t..' Cue '..w..' /o /nc') end;gma.cmd('Delete Sequence '..s..' /nc');os.remove(p..'tblink_probe_attrs.xml');return tostring(ok)..','..tostring(gma.show.getobj.handle('Sequence '..s)==nil) end;TBPR='ok'");
    for (const option of ['/delay=2', '/outfade=3', '/outdelay=1', '/trig=Time', '/trigtime=4']) await lua(`assign ${option}`, `gma.cmd('Assign Sequence ${T} Cue 1 ${option}');TBPR=TBPS(${T},'1','0')`);
    await lua('attributes-before', `TBPB=TBPX(TBPC(${T},'1','0'));TBPR=TBPB:sub(1,600)`);
    await lua('reset-to-attributes', `TBPR=TBPZ(${T},'1',${scratch})..' '..TBPS(${T},'1','0')`);
    await lua('merge-first', `gma.cmd('Copy Sequence ${S} Cue ${c2} At Sequence ${T} Cue 1 /merge /nc');TBPR=TBPS(${T},'1','0')`);
    await lua('merge-second', `gma.cmd('Copy Sequence ${S} Cue ${c1} At Sequence ${T} Cue 1 /merge /nc');TBPR=TBPS(${T},'1','0')`);
    await lua('attributes-kept', `local a=TBPX(TBPC(${T},'1','0'));TBPR=tostring(a==TBPB)..(a==TBPB and '' or ' after='..a:sub(1,600))`);
    await lua('reference-merge', `gma.cmd('Copy Sequence ${S} Cue ${c2} At Sequence ${T} Cue 3 /o /nc');gma.cmd('Copy Sequence ${S} Cue ${c1} At Sequence ${T} Cue 3 /merge /nc');TBPR=TBPQ(${T},'1','0',${T},'3','0')`);
    // Q4: which elements a plain Cue and a Cue with a command carry besides its data (static merge rejects commands).
    await lua('define-elements', "_G.TBPE=function(c) local seen,list={},{};for n in TBPX(c):gmatch('<(%a[%w_]*)') do if not seen[n] then seen[n]=true;list[#list+1]=n end end;return table.concat(list,',') end;TBPR='ok'");
    await lua('elements-plain', `TBPR=TBPE(TBPC(${S},${parts(c1)}))`);
    await lua('assign-command', `gma.cmd('Copy Sequence ${S} Cue ${c1} At Sequence ${T} Cue 5 /o /nc');gma.cmd('Assign Sequence ${T} Cue 5 /cmd='..string.char(34)..'Off Sequence 99998'..string.char(34));local c=TBPX(TBPC(${T},'5','0'));TBPR=TBPE(TBPC(${T},'5','0'))..' cue='..c:sub(1,500)`);
    // Single source: Copy /o should leave the Cue exactly as its source, as the snapshot import did.
    await lua('single-source-as-source', `gma.cmd('Copy Sequence ${S} Cue ${c2} At Sequence ${T} Cue 4 /o /nc');local a,b=TBPX(TBPC(${T},'4','0')),TBPX(TBPC(${S},${parts(c2)}));local k=1;while k<=#a and a:sub(k,k)==b:sub(k,k) do k=k+1 end;TBPR=tostring(a==b)..(a==b and '' or ' at '..k..' target='..a:sub(k-80,k+160)..' source='..b:sub(k-80,k+160))`);
    await mkdir(resolve('artifacts/ma2-hardware-diagnostics'), { recursive: true });
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/copy-probe.json'), JSON.stringify({ at: new Date().toISOString(), show: directory.show, version: directory.version, source: S, c1, c2, target: T, results }, null, 2));
  } finally {
    console.info(JSON.stringify({ created, results }));
    if (created && raw.state === 'connected') {
      const marker = `TBLINK_CLEAN_${randomBytes(16).toString('hex')}:`;
      const page = created.page === null ? '' : `gma.cmd('Delete Page ${created.page} /nc');`;
      const removed = await raw.command(`Lua "gma.cmd('Delete Sequence ${created.sequence} /nc');${page}gma.echo('${marker}'..tostring(gma.show.getobj.handle('Sequence ${created.sequence}')==nil))"`, text => ma2ResponseLine(text, marker));
      expect(removed).toBe('true');
    }
    raw.disconnect();
  }
}, 600000);

// Writes 12 backup exports of one existing Sequence on the console and removes them all again.
it.runIf(process.env.TBLINK_MA2_BACKUP_ROTATION === '1' && Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('onPC 写前备份每个对象只留最近 10 份', async () => {
  const raw = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  const created: string[] = [];
  const lua = async (code: string): Promise<string> => {
    const marker = `TBLINK_ROTATE_${randomBytes(16).toString('hex')}:`;
    return await raw.command(`Lua "${code};gma.echo('${marker}'..tostring(R))"`, text => ma2ResponseLine(text, marker));
  };
  const exists = (file: string): Promise<string> => lua(`local f=io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','rb');R=not (f==nil);if f then f:close() end`);
  try {
    await raw.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(raw, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(raw), showStopped);
    const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
    const sequence = directory.entries[0]!.target;
    const backups = new Ma2ConsoleBackups(resolve(await mkdtemp(join(tmpdir(), 'tblink-rotation-')), 'backups.json'), showStopped, message => Promise.reject(new Error(message)));
    for (let index = 0; index < 12; index++) {
      const file = `tblink_library_${randomBytes(16).toString('hex')}`;
      expect(await lua(`gma.cmd('Export Sequence ${sequence} ${file} /o');local f=io.open(gma.show.getvar('PATH')..'/importexport/${file}.xml','rb');R=not (f==nil);if f then f:close() end`)).toBe('true');
      created.push(file);
      await backups.record(bridge, { console: 'onpc-rotation-test', object: `Sequence ${sequence}`, files: [file] });
    }
    const present = await Promise.all(created.map(exists));
    console.info(JSON.stringify({ sequence, present }));
    expect(present).toEqual([...Array<string>(2).fill('false'), ...Array<string>(10).fill('true')]);
  } finally {
    if (created.length && raw.state === 'connected') {
      const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(raw), showStopped);
      await bridge.request('DISCARD', 1, created.join(','));
      expect((await Promise.all(created.map(exists))).every(value => value === 'false')).toBe(true);
    }
    raw.disconnect();
  }
}, 300000);

// Writes one scratch Timecode show (and a scratch executor page), compares what the console keeps with
// what was written, and removes both; also removes a song probe show an earlier failed run left behind.
it.runIf(process.env.TBLINK_MA2_TIMECODE_PROBE === '1' && Boolean(process.env.TBLINK_MA2_HARDWARE_HOST))('onPC 本曲时间码节目写入后控台保留的内容', async () => {
  const raw = new Ma2Telnet({ host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001 });
  const results: Record<string, unknown> = {};
  let made: { timecode?: number; page?: number } = {};
  const lua = async (code: string): Promise<string> => {
    const marker = `TBLINK_TCPROBE_${randomBytes(16).toString('hex')}:`;
    return await raw.command(`Lua "${code};gma.echo('${marker}'..tostring(R))"`, text => ma2ResponseLine(text, marker));
  };
  const canonical = (xml: string): string => xml.replace(/<Info\b[^>]*\/>/g, '').replace(/>\s+</g, '><').trim();
  try {
    await raw.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(raw, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(raw), showStopped);
    const timecodes = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
    const ranges = ma2TimecodeRangesSchema.parse(JSON.parse(await bridge.request('TCRANGES', 1)));
    expect(ranges.entries.map(entry => entry.target)).toEqual(timecodes.entries.map(entry => entry.target));
    results.ranges = { count: ranges.entries.length, sample: ranges.entries.slice(0, 5) };
    for (const orphan of timecodes.entries.filter(entry => entry.name === `LianDongTanZhenGeQu ${entry.target}`)) results[`removed-orphan-${orphan.target}`] = await lua(`gma.cmd('Delete Timecode ${orphan.target} /nc');R=gma.show.getobj.handle('Timecode ${orphan.target}')==nil`);
    const sequences = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LISTSEQ', 1)));
    const sequence = sequences.entries.find(entry => entry.target === 8999)?.target ?? sequences.entries[0]!.target;
    const report = inspectMa2SequenceXml(await bridge.request('SEQCUES', sequence, '1.000,2.000')).sequences[0]!;
    let page = 9890; const pages = await listMa2ExecutorPages(bridge, { network: { host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001, username: 'administrator' }, expectedSource: { show: timecodes.show, generation: timecodes.generation, version: timecodes.version } });
    while (pages.pages.some(value => value.page === page)) page += 1;
    made = { page };
    results.assign = await lua(`gma.cmd('Store Page ${page} /nc');gma.cmd('Assign Sequence ${sequence} At Executor ${page}.101 /nc');R=not (gma.show.getobj.handle('Executor ${page}.101')==nil)`);
    const executorName = /tblink_executor_name="([^"]*)"/.exec(await bridge.request('EXECUTOR', page, '101'))?.[1] ?? '';
    let target = 9950; const live = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
    while (live.entries.some(entry => entry.target === target)) target += 1;
    made = { ...made, timecode: target };
    const current = await bridge.request('CREATE', target, '', createMa2TimecodeXml(target, 'TcProbe', timecodes.version));
    results.created = canonical(current);
    const desired = ma2SongTimecodeXml(current, target, { name: 'TcProbe', startMs: 480000, executor: `${page}.101`, executorName, sequence,
      cues: report.cues.slice(0, 2).map((cue, index) => ({ atMs: index * 1000, cueIndex: cue.index, number: cue.number, name: cue.name })) });
    const wanted = canonical(desired); results.desired = wanted;
    try { await bridge.exchange('APPLY', target, current, desired); results.apply = 'verified'; }
    catch (error) { results.apply = error instanceof Error ? error.message : String(error); }
    const after = canonical(await bridge.request('READ', target));
    results.after = after;
    let k = 0; while (k < after.length && after[k] === wanted[k]) k += 1;
    results.firstDifference = { at: k, desired: wanted.slice(Math.max(0, k - 120), k + 200), after: after.slice(Math.max(0, k - 120), k + 200) };
    await mkdir(resolve('artifacts/ma2-hardware-diagnostics'), { recursive: true });
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/timecode-probe.json'), JSON.stringify({ at: new Date().toISOString(), version: timecodes.version, sequence, page, target, executorName, results }, null, 2));
  } finally {
    console.info(JSON.stringify({ made, apply: results.apply, firstDifference: results.firstDifference }));
    if (raw.state === 'connected') {
      if (made.timecode) await lua(`gma.cmd('Delete Timecode ${made.timecode} /nc');R='ok'`);
      if (made.page) await lua(`gma.cmd('Delete Page ${made.page} /nc');R='ok'`);
    }
    raw.disconnect();
  }
}, 300000);
