import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
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
