import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createEmptyLinkProject, ma2ObjectDirectorySchema, parseLinkProject } from '@tb/schema';
import { setLightingCommand } from '@tb/core/link';
import { Ma2Telnet } from '../../../../main/link/ma2-telnet';
import { ensureMa2NetworkBridge } from '../../../../main/link/ma2-bridge-installer';
import { Ma2NetworkWire } from '../../../../main/link/ma2-network-wire';
import { Ma2OnpcBridge } from '../../../../main/link/ma2-onpc-bridge';
import { prepareMa2AutoBindings } from '../../../../main/link/ma2-auto-bind-service';
import { convertMa2Snapshot } from '../../../../main/link/ma2-timecode-conversion';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2AutoSync } from './ma2-auto-sync';
import { useDocumentStore } from '../stores/document-store';
import { ma2PendingChanges } from '@tb/core/link';

it.skipIf(!process.env.MA2_NETWORK_ACCEPTANCE_PROJECT)('真实网络：大序列精简快照、自动关联、移动、撤销、重做、删除、保存恢复', async () => {
  const source = parseLinkProject(JSON.parse(await readFile(process.env.MA2_NETWORK_ACCEPTANCE_PROJECT!, 'utf8')));
  const host = process.env.MA2_NETWORK_ACCEPTANCE_HOST!;
  const connection = new Ma2Telnet({ host, port: 30000, monitorPort: 30001 });
  const out = 'D:/团播联动台数据/验收/实时同步完整验收-20261009';
  await mkdir(out, { recursive: true });
  const states: Array<{ at: string; status: string; message: string }> = [];
  try {
    const username = process.env.MA2_NETWORK_ACCEPTANCE_USER ?? 'administrator';
    await connection.connect(username, process.env.MA2_NETWORK_ACCEPTANCE_PASSWORD ?? 'admin');
    await ensureMa2NetworkBridge(connection, await readFile(resolve('tools/ma2/tblink_bridge.lua'), 'utf8'));
    const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(connection), () => false);
    const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
    expect(directory.show).toBe('tblink_ui100_20261007');
    const started = Date.now();
    const snapshot = await bridge.request('SNAPSHOT', 9907);
    const snapshotMs = Date.now() - started;
    expect(Buffer.byteLength(snapshot)).toBeLessThan(250000);
    expect(snapshot).not.toContain('<CueDatas>');
    const native = convertMa2Snapshot(snapshot, 9907);
    expect(native.mappings).toHaveLength(10);
    const original = source.rundown.find(item => item.id === 'onpc-100-demo')!.lighting!;
    const comparison = compareMa2LightingReadback(original, original.ma2Bindings![0]!.id, native, new Map());
    expect(comparison.conflicts).toEqual([]);
    expect([...comparison.local.objects].sort((a, b) => a.id.localeCompare(b.id))).toEqual([...comparison.remote.objects].sort((a, b) => a.id.localeCompare(b.id)));
    const document = structuredClone(original);
    document.ma2Bindings = [];
    for (const track of document.tracks) for (const clip of track.clips) for (const event of clip.events) {
      if (event.kind === 'ma2') event.executor = '';
    }
    const project = createEmptyLinkProject('网络大序列同步验收'); project.schemaVersion = 2;
    project.projectId = `network-acceptance-${Date.now()}`;
    project.rundown = [{ id: 'song', title: '独立验收副本', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting: document }];
    const store = useDocumentStore;
    store.getState().setProject(project, null);
    const service = new Ma2ApplyService(bridge, () => false);
    const endpoint = { dataDirectory: '', network: { host, port: 30000, monitorPort: 30001, username } };
    const runner = new Ma2AutoSync({
      state: () => ({ ...store.getState(), playing: false }),
      catalog: async () => ({ directory: ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1))), readAt: new Date().toISOString(), entries: [] }),
      rename: () => Promise.reject(new Error('此测试不应改名')),
    prepare: request => prepareMa2AutoBindings(bridge, request, () => false),
      read: async request => convertMa2Snapshot(await bridge.request('SNAPSHOT', request.target), request.target),
      compare: request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map())),
      apply: request => service.apply(request),
      archive: async (_id, value) => { const path = `${out}/before-${Date.now()}.tblink`; await writeFile(path, JSON.stringify(value)); return path; },
      execute: (id, command) => store.getState().executeForDocument(id, command),
      changed: (status, message) => { states.push({ at: new Date().toISOString(), status, message }); }
    });
    runner.start(endpoint, { directory, readAt: new Date().toISOString(), entries: [] });
    const current = () => store.getState().project!.rundown[0]!.lighting!;
    const cycles: number[] = [];
    const sync = async () => { const begin = Date.now(); await runner.tick(); cycles.push(Date.now() - begin); expect(states.at(-1), JSON.stringify(states)).toMatchObject({ status: 'verified' }); };
    await sync();
    const target = current().ma2Bindings![0]!.timecode;
    const event = current().tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(entry => entry.kind === 'ma2')!;
    const id = event.id; const at = event.at;
    const moved = structuredClone(current());
    moved.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(entry => entry.id === id)!.at += 1000;
    store.getState().execute(setLightingCommand('song', moved)); await sync();
    const remote = async () => convertMa2Snapshot(await bridge.request('SNAPSHOT', target), target);
    expect((await remote()).mappings).toHaveLength(10);
    store.getState().undo(); await sync();
    expect(current().tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(entry => entry.id === id)!.at).toBe(at);
    store.getState().redo(); await sync();
    const removed = structuredClone(current());
    for (const track of removed.tracks) for (const clip of track.clips) clip.events = clip.events.filter(entry => entry.id !== id);
    store.getState().execute(setLightingCommand('song', removed)); await sync();
    expect((await remote()).mappings).toHaveLength(9);
    store.getState().undo(); await sync();
    expect((await remote()).mappings).toHaveLength(10);
    runner.stop();
    const saved = `${out}/network-verified.tblink`;
    await writeFile(saved, JSON.stringify(store.getState().project));
    const reopened = parseLinkProject(JSON.parse(await readFile(saved, 'utf8')));
    expect(ma2PendingChanges(reopened)).toEqual([]);
    expect(reopened.rundown[0]!.lighting).toEqual(current());
    await writeFile(`${out}/network-result.json`, JSON.stringify({ at: new Date().toISOString(), snapshotMs, snapshotBytes: Buffer.byteLength(snapshot), target, cycles, traffic: connection.readTraffic(), states }, null, 2));
  } finally { connection.disconnect(); }
}, 300000);
