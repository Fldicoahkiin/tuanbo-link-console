import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function measureMediaStart({ socket, address, directory, fixture }) {
  const output = join(directory, 'media-probe.cjs');
  await build({ stdin: { contents: "export { ObsNativeSeek } from './apps/desktop/src/main/link/obs-native-seek'; export { ObsMediaPreload } from './apps/desktop/src/main/link/obs-media-preload'; export { ObsMediaScenes } from './apps/desktop/src/main/link/obs-media-scenes'; export { MediaPreviewService } from './apps/desktop/src/main/link/media-preview-service'; export { LinkProjectService } from './apps/desktop/src/main/link/link-project-service'; export { createObsProgramSnapshot, preciseSeekAssetIds } from './packages/core/src/obs-program-snapshot'; export { SceneOutputTimeline } from './packages/core/src/scene-output-timeline'; export { parseLinkProject } from './packages/schema/src/index';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', loader: { '.lua': 'text' }, alias: { '@tb/schema': resolve('packages/schema/src/index.ts'), '@tb/core/link': resolve('packages/core/src/link-public.ts') }, outfile: output });
  const { ObsNativeSeek, ObsMediaPreload, ObsMediaScenes, MediaPreviewService, LinkProjectService, createObsProgramSnapshot, preciseSeekAssetIds, SceneOutputTimeline, parseLinkProject } = createRequire(import.meta.url)(output);
  const native = new ObsNativeSeek(); await native.prepare(address);
  const project = parseLinkProject(JSON.parse(await readFile(fixture, 'utf8'))), opening = new SceneOutputTimeline(project, project.rundown[0].id).at(0);
  const requests = [], seeks = [], sources = [], started = performance.now(); let phase = 'prepare';
  const preciseAssets = preciseSeekAssetIds(createObsProgramSnapshot(project, project.rundown[0].id, 0), 0);
  const media = new MediaPreviewService(new LinkProjectService(), undefined,
    () => createRequire(resolve('apps/desktop/package.json'))('ffmpeg-static'));
  const scenes = new ObsMediaScenes(socket, async (operation, label) => {
    const at = performance.now();
    try { const result = await operation(); requests.push({ phase, label, at: at - started, durationMs: performance.now() - at, result }); return result; }
    catch (error) { requests.push({ phase, label, at: at - started, durationMs: performance.now() - at, error: String(error) }); throw error; }
  }, operation => operation());
  const preload = new ObsMediaPreload(project, project.rundown[0].id, scenes, {
    prime: (name, retained, kind) => native.prime(address, name, retained, kind), seek: (name, position) => native.seek(address, name, position)
  });
  const current = () => undefined;
  const path = event => resolve(dirname(fixture), event.relativePath);
  try {
    for (const event of opening.media) {
      const asset = project.mediaAssets.find(asset => asset.id === event.assetId);
      const playbackPath = event.assetKind === 'video' && preciseAssets.has(asset.id) && process.env.TBLINK_MEASURE_MEDIA_SOURCE !== 'original'
        ? await media.ensureObsSeekVideo(fixture, asset.relativePath, asset.sha256) : path(event);
      sources.push({ assetId: asset.id, sourcePath: path(event), playbackPath, usesPreciseCache: playbackPath !== path(event) });
      await scenes.prepare(project.projectId, asset, path(event), playbackPath);
      preload.register(project.projectId, asset, path(event));
    }
    phase = 'prime';
    for (const event of opening.media.filter(event => event.assetKind !== 'image')) await preload.prime(event, current);
    phase = 'prepare-composition';
    for (const entry of opening.cues) for (const action of entry.cue.actions) await scenes.prepareComposition(action.sceneName, action.sceneLayers);
    phase = 'switch';
    for (const entry of opening.cues) for (const action of entry.cue.actions) await scenes.compose(action.sceneName, action.sceneLayers);
    phase = 'play';
    const results = await Promise.allSettled(opening.media.map(event => preload.execute(event, path(event))));
    const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
    if (process.env.TBLINK_MEASURE_MEDIA_SEEK === '1') {
      for (let boundary = 1; boundary <= 4; boundary++) {
        const enteredAt = performance.now();
        await delay(2000); phase = `preload-${boundary}`;
        const next = opening.media.filter(event => event.assetKind !== 'image').map(event => ({ ...event,
          id: `probe-${boundary}-${event.id}`, clipId: `probe-${boundary}-${event.clipId}`, sourceOffsetMs: 100, deferSceneSwitch: true }));
        const prepared = await Promise.allSettled(next.map(event => preload.prime(event, current)));
        const preparationFailure = prepared.find(result => result.status === 'rejected'); if (preparationFailure) throw preparationFailure.reason;
        assert(performance.now() - enteredAt < 12000, '下一片段未在边界前完成预备');
        await delay(Math.max(0, 12000 - (performance.now() - enteredAt))); phase = `seek-${boundary}`;
        const at = performance.now();
        const results = await Promise.allSettled(next.map(async event => {
          await preload.execute(event, path(event));
          const elapsedMs = performance.now() - at;
          seeks.push({ boundary, sourceName: preload.resolveSource(event.sourceName), targetMs: 100, elapsedMs });
          assert(elapsedMs <= 100, `四路接续定位超过100ms：${event.assetName} ${elapsedMs.toFixed(2)}ms`);
        }));
        const failure = results.find(result => result.status === 'rejected'); if (failure) throw failure.reason;
      }
    }
  } finally {
    await writeFile(join(directory, 'media-start-requests.json'), JSON.stringify({ scope: '逐请求测量，无正式音频，不是全链路验收；按正式快照选择精确定位缓存；启用接续定位探针时另验100ms边界', sources, seeks, requests }, null, 2));
    await preload.close();
    for (const event of opening.media.filter(event => event.assetKind === 'image')) await scenes.execute({ ...event, phase: 'stop' }, path(event));
    await scenes.releasePrimed();
  }
}
