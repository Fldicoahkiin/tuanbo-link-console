import { mkdir, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { createEmptyLinkProject, ma2ObjectDirectorySchema } from '@tb/schema';
import { setLightingCommand } from '@tb/core/link';
import { Ma2OnpcBridge } from '../../../../main/link/ma2-onpc-bridge';
import { prepareMa2AutoBindings } from '../../../../main/link/ma2-auto-bind-service';
import { convertMa2Snapshot } from '../../../../main/link/ma2-timecode-conversion';
import { compareMa2LightingReadback } from '../../../../main/link/ma2-comparison';
import { Ma2ApplyService } from '../../../../main/link/ma2-apply-service';
import { Ma2AutoSync } from './ma2-auto-sync';
import { useDocumentStore } from '../stores/document-store';

it.skipIf(!process.env.MA2_ONPC_AUTO_BIND_ACCEPTANCE)('真实 onPC：无执行器 Cue 自动关联、移动、撤销及再次添加写回', async () => {
  const connection = { dataDirectory: process.env.MA2_ONPC_DATA_DIRECTORY ?? '' };
  const bridge = new Ma2OnpcBridge(connection.dataDirectory, () => false);
  const directory = ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1)));
  expect(directory.show).toBe('tblink_ui100_20261007');
  const template = convertMa2Snapshot(await bridge.request('SNAPSHOT', 9907), 9907);
  const document = structuredClone(template.document);
  document.tracks = document.tracks.slice(0, 1);
  document.tracks[0]!.clips = document.tracks[0]!.clips.slice(0, 1);
  const clip = document.tracks[0]!.clips[0]!;
  clip.start = 0; clip.duration = 10000; clip.events = clip.events.slice(0, 2);
  clip.events.forEach((event, index) => { if (event.kind !== 'ma2') throw new Error('Fixture must be MA2'); event.executor = ''; event.at = index * 1200; });
  const project = createEmptyLinkProject('未绑定 Cue 自动同步验收'); project.schemaVersion = 2;
  project.projectId = 'tblink-auto-bind-acceptance-20261009';
  project.rundown.push({ id: 'song', title: '自动同步验收', enabled: true, notes: '', cues: [], referenceMediaClips: [], visualLayers: [], lighting: document });
  const store = useDocumentStore;
  store.getState().setProject(project, null);
  const service = new Ma2ApplyService(bridge, () => false);
  const out = 'D:/团播联动台数据/验收/未绑定Cue实时同步-20261009';
  await mkdir(out, { recursive: true });
  const states: Array<{ status: string; message: string }> = [];
  const catalog = { directory, readAt: new Date().toISOString(), entries: [] };
  const runner = new Ma2AutoSync({
    state: () => ({ ...store.getState(), playing: false }),
    catalog: async () => ({ ...catalog, directory: ma2ObjectDirectorySchema.parse(JSON.parse(await bridge.request('LIST', 1))) }),
    rename: () => Promise.reject(new Error('此测试不应改名')),
    prepare: request => prepareMa2AutoBindings(bridge, request, () => false),
    read: async request => convertMa2Snapshot(await bridge.request('SNAPSHOT', request.target), request.target),
    compare: request => Promise.resolve(compareMa2LightingReadback(request.document, request.bindingId, request.readback, new Map())),
    apply: request => service.apply(request),
    archive: async (_id, value) => { const path = `${out}/before-${Date.now()}.tblink`; await writeFile(path, JSON.stringify(value)); return path; },
    execute: (id, command) => store.getState().executeForDocument(id, command),
    changed: (status, message) => { states.push({ status, message }); }
  });
  const started = Date.now();
  runner.start(connection, catalog);
  await runner.tick();
  expect(states.at(-1), JSON.stringify(states)).toMatchObject({ status: 'verified' });
  const current = () => store.getState().project!.rundown[0]!.lighting!;
  const target = current().ma2Bindings![0]!.timecode;
  const firstMs = Date.now() - started;
  const moved = structuredClone(current()); moved.tracks[0]!.clips[0]!.events[1]!.at = 2300;
  store.getState().execute(setLightingCommand('song', moved));
  await runner.tick();
  expect(states.at(-1), JSON.stringify(states)).toMatchObject({ status: 'verified' });
  const remote = async () => convertMa2Snapshot(await bridge.request('SNAPSHOT', target), target);
  expect((await remote()).document.tracks[0]!.clips[0]!.events[1]!.at).toBe(2300);
  store.getState().undo(); await runner.tick();
  expect(states.at(-1), JSON.stringify(states)).toMatchObject({ status: 'verified' });
  expect((await remote()).document.tracks[0]!.clips[0]!.events[1]!.at).toBe(1200);
  const added = structuredClone(current());
  const event = structuredClone(clip.events[1]!); if (event.kind !== 'ma2') throw new Error('fixture');
  event.id = 'new-unbound-cue'; event.executor = ''; event.at = 3000;
  added.tracks[0]!.clips[0]!.events.push(event);
  store.getState().execute(setLightingCommand('song', added)); await runner.tick();
  expect(states.at(-1), JSON.stringify(states)).toMatchObject({ status: 'verified' });
  expect((await remote()).mappings).toHaveLength(3);
  runner.stop();
  await writeFile(`${out}/verified.tblink`, JSON.stringify(store.getState().project));
  await writeFile(`${out}/result.json`, JSON.stringify({ firstMs, totalMs: Date.now() - started, target, executors: current().ma2Bindings![0]!.trackMappings, states }, null, 2));
}, 300000);
