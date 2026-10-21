import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import { ma2ObjectDirectorySchema } from '@tb/schema';
import { Ma2LayoutService } from './ma2-layout-service';
import { Ma2SongWatch } from './ma2-song-watch';
import { listMa2ExecutorPages } from './ma2-executor-page';
import { expect, it } from 'vitest';
import { Ma2Telnet, ma2ResponseLine } from './ma2-telnet';
import { ensureMa2NetworkBridge } from './ma2-bridge-installer';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { createMa2Timecode } from './ma2-create';
import { sameMa2XmlObjects } from './ma2-timecode-xml';
import { readMa2NativeLibrary } from './ma2-native-library';

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
    const library = await readMa2NativeLibrary(connection, new Ma2OnpcBridge(new Ma2NetworkWire(connection), () => false), () => false);
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
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(connection), () => false);
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
  const connection: Pick<Ma2Telnet, 'command'> = { command: (line, match, beforeSend, priority) => { traffic.commands += 1; traffic.bytes += Buffer.byteLength(line); return raw.command(line, match, beforeSend, priority); } };
  const measured: Record<string, { ms: number; commands: number; bytes: number }> = {};
  const step = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const before = { ...traffic }; const started = performance.now();
    const value = await run();
    measured[name] = { ms: Math.round(performance.now() - started), commands: traffic.commands - before.commands, bytes: traffic.bytes - before.bytes };
    return value;
  };
  let created: { sequence: number; page: number } | null = null;
  const operations: Array<{ label: string; ms: number; commands: number; received: number }> = [];
  try {
    await raw.connect(process.env.TBLINK_MA2_HARDWARE_USER ?? 'administrator', process.env.TBLINK_MA2_HARDWARE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(raw, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const native = new Ma2OnpcBridge(new Ma2NetworkWire(connection), () => false);
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
    const library = await readMa2NativeLibrary(connection, bridge, () => false, undefined, 'library', undefined, directory.entries.filter(entry => entry.target < 9950).slice(0, 12).map(entry => entry.target));
    const source = library.sequences.find(value => value.cues.length >= 2);
    if (!source) throw new Error('测试 Show 前 12 个序列中没有至少 2 个 Cue 的序列');
    let sequence = 9950; while (directory.entries.some(entry => entry.target === sequence)) sequence += 1;
    let page = 9890; while (pages.pages.some(value => value.page === page)) page += 1;
    created = { sequence, page };
    const network = { host: process.env.TBLINK_MA2_HARDWARE_HOST!, port: 30000, monitorPort: 30001, username: 'administrator' };
    const expectedSource = { show: directory.show, generation: directory.generation, version: directory.version };
    const ref = (index: number) => [{ sequence: source.sequence, cue: source.cues[index]!.number, delayMs: 0 }];
    const points = [{ id: 'p1', name: 'TBLINK_PROBE_1', atMs: 0, cues: ref(0) }, { id: 'p2', name: 'TBLINK_PROBE_2', atMs: 1000, cues: ref(1) }, { id: 'p3', name: 'TBLINK_PROBE_3', atMs: 2000, cues: [] }];
    const service = new Ma2LayoutService(resolve(await mkdtemp(join(tmpdir(), 'tblink-song-probe-')), 'layouts.json'), () => false);
    const base = { network, expectedSource, projectId: randomUUID(), itemId: 'probe', settings: { layout: 999, name: 'TBLINK', nextSequence: sequence, columns: 8, executorPage: page }, name: 'TBLINK_PROBE' };
    const first = await step('create', () => service.syncSong(connection, bridge, { ...base, requestId: randomUUID(), points }));
    const second = await step('changeOneCue', () => service.syncSong(connection, bridge, { ...base, requestId: randomUUID(), binding: first.binding,
      points: first.binding.points.map((point, index) => ({ ...points[index]!, cues: index === 2 ? ref(0) : [{ sequence, cue: point.cue, delayMs: 0 }] })) }));
    const watch = new Ma2SongWatch(() => false);
    const check = { network, expectedSource, sequence, executor: second.binding.executor!, revision: second.remoteRevision! };
    await step('firstCheck', () => watch.changed(connection, bridge, check));
    const unchanged = await step('cachedCheck', () => watch.changed(connection, bridge, check));
    await mkdir(resolve('artifacts/ma2-hardware-diagnostics'), { recursive: true });
    await writeFile(resolve('artifacts/ma2-hardware-diagnostics/song-transfer.json'), JSON.stringify({ at: new Date().toISOString(), show: directory.show, version: directory.version, source: source.sequence, sequence, page, backupFile: second.backupFile, measured }, null, 2));
    console.info(JSON.stringify({ sequence, page, backupFile: second.backupFile, measured }));
    expect(second.changed).toBe(true); expect(unchanged).toBe(false);
    expect(second.backupFile).toMatch(/^tblink_library_[a-f0-9]{32}\.xml$/);
  } finally {
    console.info(JSON.stringify({ operations, measured }));
    if (created && raw.state === 'connected') {
      const marker = `TBLINK_CLEAN_${randomBytes(16).toString('hex')}:`;
      const removed = await raw.command(`Lua "gma.cmd('Delete Sequence ${created.sequence} /nc');gma.cmd('Delete Page ${created.page} /nc');gma.echo('${marker}'..tostring(gma.show.getobj.handle('Sequence ${created.sequence}')==nil and gma.show.getobj.handle('Page ${created.page}')==nil))"`, text => ma2ResponseLine(text, marker));
      expect(removed).toBe('true');
    }
    raw.disconnect();
  }
}, 600000);
