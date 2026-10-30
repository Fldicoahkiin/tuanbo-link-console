import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Called only with the separately launched acceptance OBS and test app. */
export async function verifyObsProgramPlayback({ page, directory, profile, control, expect, requireDesktop, setWindowVisible }) {
  const target = join(directory, 'program-playback'); await mkdir(target);
  const bundle = join(target, 'domain.cjs');
  await requireDesktop('esbuild').build({ entryPoints: [resolve('packages/core/src/link-public.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'cjs' });
  const domain = requireDesktop(bundle);
  const wave = Buffer.alloc(44 + 48000 * 4 * 12);
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8); wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22); wave.writeUInt32LE(48000, 24); wave.writeUInt32LE(192000, 28);
  wave.writeUInt16LE(4, 32); wave.writeUInt16LE(16, 34); wave.write('data', 36); wave.writeUInt32LE(wave.length - 44, 40);
  const audio = join(target, 'test.wav'); await writeFile(audio, wave);
  const p1Path = join(target, 'origin.hia'), file = join(target, 'program.tblink');
  await writeFile(p1Path, `<playerRoot><audioPlayList CurrentList="0"><audioPlayElement caption="验收" type="0"/></audioPlayList><videoPlayList CurrentList="0"><videoPlayElement caption="验收" type="0"><media mediaType="0" resourceFilePath="${audio.replaceAll('\\', '/')}" playEndAction="2" cut_start="0" cut_end="12" volume="100" mute="0" shortcut="" MidiStartTime="480.5" audio_caption_="P1 原始起点验收"/></videoPlayElement></videoPlayList></playerRoot>`);
  const initial = await page.evaluate(() => globalThis.window.tbLink.createProject('播放切场景与 P1 起点'));
  await writeFile(file, JSON.stringify(initial));
  const imported = await page.evaluate(payload => globalThis.window.tbLink.importP1Project(payload), { p1ProjectPath: p1Path, linkProjectPath: file });
  assert.equal(imported.items.length, 1); assert.equal(imported.items[0].p1Media.midiStartTime, '480.5');
  const project = domain.synchronizeP1ProjectCommand(imported).execute(initial);
  project.playbackSource = 'internal'; project.obsOutputMode = 'scenes';
  project.rundown[0].cues = [0, 2, 4].map((seconds, index) => ({ id: `cue-${index}`, enabled: true, name: `机位 ${index}`, notes: '',
    timecode: { hours: 0, minutes: 0, seconds, frames: 0 }, actions: [{ id: `action-${index}`, label: `机位 ${index}`, kind: 'obs.setProgramScene', sceneName: index === 1 ? '验收机位乙' : '验收机位甲' }] }));
  await writeFile(file, JSON.stringify(project));
  for (const [index, sceneName] of ['验收机位甲', '验收机位乙'].entries()) {
    await control.call('CreateScene', { sceneName });
    await control.call('CreateInput', { sceneName, inputName: `${sceneName}颜色`, inputKind: 'color_source_v3', inputSettings: { width: 640, height: 360, color: index ? 4278255360 : 4278190335 }, sceneItemEnabled: true });
  }
  const results = [];
  const observedScenes = [];
  const onScene = event => observedScenes.push({ sceneName: event.sceneName, at: Date.now() });
  control.on('CurrentProgramSceneChanged', onScene);
  try {
    // One playback engine since 0.5.6: Windows native audio, with the window shown and hidden.
    for (const scenario of [{ engine: 'native', hidden: false }, { engine: 'native', hidden: true }]) {
      const { engine, hidden } = scenario;
      await page.evaluate(async ({ profile, file, engine }) => {
        await globalThis.window.tbLink.saveIntegrationProfile({ profile: { ...profile, internalPlayer: { audioEngine: engine, nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 } } });
        localStorage.setItem('tblink.last-project-path.v1', file);
      }, { profile, file, engine });
      await page.reload();
      await expect(page.getByRole('navigation', { name: '主要工作区' })).toBeVisible();
      await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '节目单', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'MTC 起始时间（时:分:秒:帧）', exact: true })).toHaveValue('00:08:00:15');
      await setWindowVisible(!hidden);
      const previousScene = (await control.call('GetCurrentProgramScene')).currentProgramSceneName;
      await control.call('SetCurrentProgramScene', { sceneName: 'Connection' });
      if (previousScene !== 'Connection') await expect.poll(() => observedScenes.at(-1)?.sceneName).toBe('Connection');
      observedScenes.length = 0;
      await writeFile(join(target, 'current-scenario.json'), JSON.stringify(scenario));
      const play = page.locator('.player-transport .primary-button');
      await expect(play).toBeEnabled(); await play.click();
      await expect(page.locator('.player-transport.status-playing')).toBeVisible({ timeout: 15000 });
      await expect.poll(() => observedScenes.map(event => event.sceneName), { timeout: 5000, intervals: [20, 50] }).toEqual(['验收机位甲', '验收机位乙', '验收机位甲']);
      const scenes = [...observedScenes];
      assert.equal((await control.call('GetCurrentProgramScene')).currentProgramSceneName, '验收机位甲');
      const status = await page.evaluate(() => globalThis.window.tbLink.getNativePlaybackStatus());
      assert.equal(status.offsetMs, 480500);
      results.push({ engine, hiddenWindow: hidden, scenes, importedP1Origin: imported.items[0].p1Media.midiStartTime, playbackOriginMs: project.rundown[0].playback.mtcOffsetMs });
      await writeFile(join(target, 'completed-scenarios.json'), JSON.stringify(results, null, 2));
      await page.getByRole('button', { name: '停止播放', exact: true }).click();
      await expect(play).toBeEnabled();
      await expect(page.getByRole('button', { name: '顶部一键连接', exact: true })).toBeEnabled();
    }
    await writeFile(join(target, 'acceptance.json'), JSON.stringify({ results, realObs: true, audibleOutput: false, physicalConsole: false }, null, 2));
  } catch (error) {
    await writeFile(join(target, 'observed-scenes.json'), JSON.stringify(observedScenes, null, 2));
    await writeFile(join(target, 'failure.txt'), String(error.stack ?? error));
    throw error;
  } finally {
    control.off('CurrentProgramSceneChanged', onScene);
    await writeFile(join(target, 'logs.json'), JSON.stringify(await page.evaluate(() => globalThis.window.tbLink.queryLogs()), null, 2));
    await page.screenshot({ path: join(target, 'last-screen.png') });
    const stop = page.getByRole('button', { name: '停止播放', exact: true });
    if (await page.locator('.player-transport.status-stopped').count() === 0 && await stop.isEnabled()) await stop.click();
    await expect(page.getByRole('button', { name: '顶部一键连接', exact: true })).toBeEnabled();
    await setWindowVisible(true);
  }
}
