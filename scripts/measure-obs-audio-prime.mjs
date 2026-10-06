import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Only the isolated OBS launcher calls this. The test source stays muted and
// off-air. Audio-only readiness must never depend on a non-existent video size.
export async function measureAudioPrime({ socket, address, directory, wavPath, inputKind = 'ffmpeg_source' }) {
  const bundle = join(directory, 'audio-prime.cjs');
  await build({ stdin: { contents: "export { ObsNativeSeek } from './apps/desktop/src/main/link/obs-native-seek';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', loader: { '.lua': 'text' }, outfile: bundle });
  const { ObsNativeSeek } = createRequire(resolve('apps/desktop/package.json'))(bundle);
  const native = new ObsNativeSeek(), sceneName = '团播联动台·素材·纯音频验收', inputName = `${sceneName}·来源`;
  const result = { passed: false, scope: '真实OBS纯音频来源静音预热与位置回读；不是可听输出或长时验收', readings: [], error: null };
  await socket.call('CreateScene', { sceneName });
  await socket.call('CreateInput', { sceneName, inputName, inputKind, inputSettings: {
    local_file: wavPath, is_local_file: true, restart_on_activate: false, close_when_inactive: false
  } });
  try {
    await socket.call('SetInputMute', { inputName, inputMuted: true });
    for (const retained of [false, true]) {
      const started = performance.now();
      await native.prime(address, inputName, retained, 'audio');
      let state;
      do {
        state = await socket.call('GetMediaInputStatus', { inputName });
        if (state.mediaState === 'OBS_MEDIA_STATE_PAUSED' && Math.abs(state.mediaCursor) <= 100) break;
        await delay(20);
      } while (performance.now() - started < 2000);
      result.readings.push({ retained, elapsedMs: performance.now() - started, state });
      assert.equal(state.mediaState, 'OBS_MEDIA_STATE_PAUSED'); assert(Math.abs(state.mediaCursor) <= 100);
      const positionMs = retained ? 11200 : 5700;
      await native.seek(address, inputName, positionMs);
      const seekStarted = performance.now();
      do {
        state = await socket.call('GetMediaInputStatus', { inputName });
        if (state.mediaState === 'OBS_MEDIA_STATE_PAUSED' && Math.abs(state.mediaCursor - positionMs) <= 100) break;
        await delay(20);
      } while (performance.now() - seekStarted < 2000);
      result.readings.push({ retained, phase: 'seek', positionMs, state });
      assert.equal(state.mediaState, 'OBS_MEDIA_STATE_PAUSED'); assert(Math.abs(state.mediaCursor - positionMs) <= 100);
      await socket.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PLAY' });
      await delay(250);
      state = await socket.call('GetMediaInputStatus', { inputName });
      result.readings.push({ retained, phase: 'muted-play', positionMs, state });
      assert.equal(state.mediaState, 'OBS_MEDIA_STATE_PLAYING'); assert(state.mediaCursor > positionMs + 100);
      await socket.call('TriggerMediaInputAction', { inputName, mediaAction: 'OBS_WEBSOCKET_MEDIA_INPUT_ACTION_PAUSE' });
    }
    result.passed = true;
  } catch (error) { result.error = String(error); throw error; }
  finally {
    await writeFile(join(directory, 'audio-prime.json'), JSON.stringify(result, null, 2));
    await socket.call('RemoveInput', { inputName }); await socket.call('RemoveScene', { sceneName });
  }
}
