import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEmptyLinkProject, ma2ObjectDirectorySchema, parseLinkProject } from '@tb/schema';
import { saveMa2MaterialLibraryCommand, renameConsoleCueCommand, pendingMa2Renames } from '@tb/core/link';
import { Ma2Telnet, ma2ResponseLine } from '../../../../main/link/ma2-telnet';
import { ensureMa2NetworkBridge } from '../../../../main/link/ma2-bridge-installer';
import { Ma2OnpcBridge } from '../../../../main/link/ma2-onpc-bridge';
import { Ma2NetworkWire } from '../../../../main/link/ma2-network-wire';
import { renameMa2Object } from '../../../../main/link/ma2-rename-service';
import { inspectMa2SequenceXml } from '../../../../main/link/ma2-timecode-xml';
import { Ma2AutoSync } from './ma2-auto-sync';
import { useDocumentStore as store } from '../stores/document-store';

it.skipIf(!process.env.MA2_RENAME_ACCEPTANCE_HOST)('真实 onPC：中文英文 Cue 改名、撤销重做及冲突保护，最后恢复原名', async () => {
  const host = process.env.MA2_RENAME_ACCEPTANCE_HOST!;
  const connection = new Ma2Telnet({ host, port: 30000, monitorPort: 30001 });
  const output = process.env.TBLINK_MA2_RENAME_OUTPUT ?? 'D:/团播联动台数据/验收/Cue名称同步-20261009';
  await mkdir(output, { recursive: true });
  const timings: number[] = [];
  const states: { status: string; message: string }[] = [];
  try {
    const username = process.env.MA2_NETWORK_ACCEPTANCE_USER ?? 'administrator';
    await connection.connect(username, process.env.MA2_NETWORK_ACCEPTANCE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(connection, await readFile('tools/ma2/tblink_bridge.lua', 'utf8'));
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(connection), () => false);
    const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
    expect(directory.show).toBe('tblink_ui100_20261007');
    const snapshot = await bridge.request('SNAPSHOT', 9907);
    const sequence = inspectMa2SequenceXml(snapshot).sequences.find(value => value.number === 9907)!;
    const cue = sequence.cues.find(value => value.number === '3.000')!;
    expect(cue.name).toBe('003 扫光');
    const nativeLabels = await connection.command(`Lua "gma.echo('TBLINK_LABEL_DIAG:'..(gma.show.getobj.label(gma.show.getobj.handle('Sequence 9907 Cue 3')):gsub('.',function(c)return string.format('%02x',string.byte(c))end)))"`, text => ma2ResponseLine(text, 'TBLINK_LABEL_DIAG:'));
    expect(nativeLabels).toBe(Buffer.from(cue.name!).toString('hex'));
    const endpoint = { dataDirectory: '', network: { host, port: 30000, monitorPort: 30001, username } };
    const source = { endpoint: `${host}:30000`, show: directory.show };
    const reference = { sequence: 9907, cue: '3.000', kind: 'single' as const };
    const project = saveMa2MaterialLibraryCommand(source.endpoint, { directory, readAt: new Date().toISOString(), fixtureUsage: [], errors: [], sequences: [{ sequence: 9907, name: '100步灯光测试', cues: [{ index: cue.index, number: cue.number, name: cue.name }] }] }).execute(createEmptyLinkProject('名称同步验收'));
    store.getState().setProject(project, null);
    const runner = new Ma2AutoSync({ state: () => ({ ...store.getState(), playing: false }),
      catalog: async () => ({ directory: ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1))), readAt: new Date().toISOString(), entries: [] }),
      prepare: () => Promise.reject(new Error('Unexpected prepare')), read: () => Promise.reject(new Error('Unexpected read')),
      compare: () => Promise.reject(new Error('Unexpected compare')), apply: () => Promise.reject(new Error('Unexpected apply')),
      rename: request => renameMa2Object(bridge, request), archive: async (_id, value) => { const path = `${output}/before-${Date.now()}.tblink`; await writeFile(path, JSON.stringify(value)); return path; },
      execute: (id, command) => store.getState().executeForDocument(id, command), changed: (status, message) => { states.push({ status, message }); }
    });
    runner.start(endpoint, { directory, readAt: new Date().toISOString(), entries: [] });
    const sync = async () => { const start = Date.now(); await runner.tick(); timings.push(Date.now() - start); expect(states.at(-1), JSON.stringify(states)).toMatchObject({ status: 'verified' }); expect(pendingMa2Renames(store.getState().project)).toEqual([]); };
    store.getState().execute(renameConsoleCueCommand(reference, '中文名称验收', source)); await sync();
    store.getState().execute(renameConsoleCueCommand(reference, 'Front Light Test', source)); await sync();
    store.getState().undo(); await sync();
    store.getState().redo(); await sync();
    await expect(renameMa2Object(bridge, { ...endpoint, generation: directory.generation, change: { ...source, ...reference, confirmedName: 'Wrong baseline', name: 'Must Not Write' } })).rejects.toThrow('控台上的名称又被修改');
    store.getState().undo(); await sync();
    store.getState().undo(); await sync();
    runner.stop();
    expect(store.getState().project!.ma2MaterialLibrary!.library!.sequences[0]!.cues[0]!.name).toBe(cue.name);
    const final = inspectMa2SequenceXml(await bridge.request('SNAPSHOT', 9907)).sequences.find(value => value.number === 9907)!;
    expect(final).toEqual(sequence);
    const saved = parseLinkProject(JSON.parse(JSON.stringify(store.getState().project)));
    expect(pendingMa2Renames(saved)).toEqual([]);
    await writeFile(`${output}/result.json`, JSON.stringify({ timings, restoredName: cue.name, states }, null, 2));
    await writeFile(`${output}/verified.tblink`, JSON.stringify(saved));
  } finally { connection.disconnect(); }
}, 180000);
