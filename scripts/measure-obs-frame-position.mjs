import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

// Called only by the owner of a fresh portable OBS. This checks actual decoded
// pixels, not merely a cursor acknowledgement, and is not a performance soak.
export async function measureFramePosition({ socket, address, directory, inputKind = 'ffmpeg_source' }) {
  const require = createRequire(resolve('apps/desktop/package.json'));
  const ffmpeg = require('ffmpeg-static');
  const run = args => promisify(execFile)(ffmpeg, ['-hide_banner', '-loglevel', 'error', ...args],
    { windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer' }).then(result => result.stdout);
  const source = join(directory, 'frame-position-gop90.mp4');
  const dimensions = process.env.TBLINK_FRAME_POSITION_DIMENSIONS || '128x72';
  assert(['128x72', '1920x1080', '3840x2160'].includes(dimensions));
  const withAudio = process.env.TBLINK_FRAME_POSITION_AUDIO === '1';
  const fps = Number(process.env.TBLINK_FRAME_POSITION_FPS ?? 30);
  const bFrames = Number(process.env.TBLINK_FRAME_POSITION_BFRAMES ?? 0);
  assert([25, 30, 60].includes(fps)); assert([0, 2].includes(bFrames));
  const frameCount = fps * 10;
  // Each frame has a binary luminance barcode, so a stale keyframe cannot be
  // mistaken for the target because two adjacent pictures look almost alike.
  await run(['-f', 'lavfi', '-i', `nullsrc=size=128x72:rate=${fps}:duration=10,geq=lum='16+220*mod(floor(N/pow(2,floor(X/8))),2)':cb=128:cr=128`,
    ...(withAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=10', '-c:a', 'aac'] : []),
    '-vf', `scale=${dimensions.replace('x', ':')}:flags=neighbor`, '-filter_threads', '1',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '12', '-g', String(fps * 3), '-keyint_min', String(fps * 3), '-bf', String(bFrames), '-sc_threshold', '0', '-threads', '2', source]);
  const reference = await run(['-i', source, '-vf', 'scale=128:72:flags=neighbor', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const frameBytes = 128 * 72 * 3;
  assert.equal(reference.length, frameBytes * frameCount);
  const bundle = join(directory, 'frame-position.cjs');
  await build({ stdin: { contents: "export { ObsNativeSeek } from './apps/desktop/src/main/link/obs-native-seek'; export { MediaPreviewService } from './apps/desktop/src/main/link/media-preview-service'; export { LinkProjectService } from './apps/desktop/src/main/link/link-project-service';", resolveDir: process.cwd() },
    bundle: true, platform: 'node', format: 'cjs', loader: { '.lua': 'text' }, alias: { '@tb/schema': resolve('packages/schema/src/index.ts'), '@tb/core/link': resolve('packages/core/src/link-public.ts') }, outfile: bundle });
  const { ObsNativeSeek, MediaPreviewService, LinkProjectService } = require(bundle);
  const native = new ObsNativeSeek(); await native.prepare(address);
  const media = new MediaPreviewService(new LinkProjectService(), undefined, () => ffmpeg);
  const cache = await media.ensureObsSeekVideo(join(directory, 'measurement.tblink'), 'frame-position-gop90.mp4', createHash('sha256').update(await readFile(source)).digest('hex'));
  // Independent codec diagnostic: OBS deliberately disables automatic frame
  // threading for JPEG 2000. Preserve YUV pixels; this is not a production
  // cache replacement or evidence for alpha/10-bit/4K compatibility.
  const singleFrameCache = join(directory, 'frame-position-jpeg2000.mkv');
  const cacheOnly = process.env.TBLINK_FRAME_POSITION_CACHE_ONLY === '1';
  if (!cacheOnly) {
  await run(['-threads', '2', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'jpeg2000', '-pred', '1', '-threads', '1', '-c:a', 'copy', '-avoid_negative_ts', 'disabled', singleFrameCache]);
  const cachePixels = await run(['-threads', '2', '-i', singleFrameCache, '-vf', 'scale=128:72:flags=neighbor', '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  // Comparing large Buffers with deepEqual constructs a gigantic textual diff
  // on failure and can exhaust memory. Digest equality verifies the same bytes
  // without materialising one number/string for every pixel in the error.
  assert.equal(cachePixels.length, reference.length, '定位诊断缓存的实际帧数与原文不同');
  assert.equal(createHash('sha256').update(cachePixels).digest('hex'), createHash('sha256').update(reference).digest('hex'), '定位诊断缓存像素与原文不同');
  }
  const originalScene = (await socket.call('GetCurrentProgramScene')).sceneName;
  const rows = [], failures = [];
  const hevcDiagnostic = process.env.TBLINK_FRAME_POSITION_HEVC_DIAGNOSTIC === '1';
  const hevcCache = join(directory, 'frame-position-hevc-lossless.mkv');
  if (hevcDiagnostic) {
    await run(['-threads', '2', '-i', source, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'hevc_nvenc',
      '-preset', 'p1', '-tune', 'lossless', '-rc', 'constqp', '-qp', '0', '-g', '1', '-bf', '0', '-pix_fmt', '+',
      '-vf', 'tpad=stop_mode=clone:stop=32', '-fps_mode', 'passthrough', '-c:a', 'copy', '-avoid_negative_ts', 'disabled', hevcCache]);
    const originalPixels = await run(['-threads', '2', '-i', source, '-map', '0:v:0', '-f', 'hash', '-hash', 'sha256', '-']);
    const hardwarePixels = await run(['-hwaccel', 'cuda', '-i', hevcCache, '-map', '0:v:0', '-frames:v', String(frameCount), '-f', 'hash', '-hash', 'sha256', '-']);
    assert.equal(hardwarePixels.toString('utf8'), originalPixels.toString('utf8'), 'HEVC 硬件解码的原范围像素必须相同');
  }
  const variants = hevcDiagnostic ? [{ name: 'hevc-lossless-diagnostic', file: hevcCache, hardwareRequested: true }]
    : cacheOnly ? [{ name: 'lossless-cache', file: cache, hardwareRequested: true }] : [{ name: 'original-software', file: source, hardwareRequested: false },
    { name: 'original-hardware-requested', file: source, hardwareRequested: true },
    { name: 'lossless-cache', file: cache, hardwareRequested: true },
    { name: 'lossless-jpeg2000-diagnostic', file: singleFrameCache, hardwareRequested: false }];
  function identify(pixels) {
    const bitWidth = 8, bits = [];
    for (let bit = 0; bit < 16; bit++) {
      let sum = 0;
      for (let y = 8; y < 64; y += 8) for (let x = bit * bitWidth + 2; x < bit * bitWidth + 6; x++) sum += pixels[(y * 128 + x) * 3];
      bits.push(sum / 28 > 128 ? 1 : 0);
    }
    return bits.reduce((number, bit, index) => number + bit * 2 ** index, 0);
  }
  for (let frame = 0; frame < frameCount; frame++) assert.equal(identify(reference.subarray(frame * frameBytes, (frame + 1) * frameBytes)), frame);
  try {
    for (const variant of variants) {
      const sceneName = `团播联动台·素材·逐帧验收·${variant.name}`, sourceName = `${sceneName}·来源`;
      await socket.call('CreateScene', { sceneName });
      await socket.call('CreateInput', { sceneName, inputName: sourceName, inputKind, inputSettings: {
        local_file: variant.file, is_local_file: true, restart_on_activate: false, close_when_inactive: false, hw_decode: variant.hardwareRequested
      } });
      try {
        await socket.call('SetInputMute', { inputName: sourceName, inputMuted: true });
        await socket.call('SetCurrentProgramScene', { sceneName });
        await native.prime(address, sourceName);
        for (const frame of [0, 3, fps, Math.round(fps * 151 / 30), Math.round(fps * 61 / 30), Math.round(fps * 7.5), frameCount - 1, 0]) {
          const positionMs = Math.round(frame * 1000 / fps), at = performance.now();
          // Seek directly from the last decoded frame to zero. A restart would
          // conceal EOF state which was not reset by the seek implementation.
          await native.seek(address, sourceName, positionMs);
          let actualFrame = -1, status = null;
          do {
            const screenshot = await socket.call('GetSourceScreenshot', { sourceName, imageFormat: 'png', imageWidth: 128, imageHeight: 72 });
            const png = Buffer.from(screenshot.imageData.split(',')[1], 'base64');
            const pngFile = join(directory, `${variant.name}-${rows.length}-${frame}.png`);
            await writeFile(pngFile, png);
            const pixels = await run(['-i', pngFile, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
            assert.equal(pixels.length, frameBytes);
            actualFrame = identify(pixels);
            status = await socket.call('GetMediaInputStatus', { inputName: sourceName });
            if (actualFrame === frame && status.mediaState === 'OBS_MEDIA_STATE_PAUSED') break;
            await delay(20);
          } while (performance.now() - at < 2000);
          const row = { variant: variant.name, hardwareRequested: variant.hardwareRequested, targetFrame: frame,
            positionMs, actualFrame, elapsedMs: performance.now() - at, status };
          rows.push(row);
          if (actualFrame !== frame || status.mediaState !== 'OBS_MEDIA_STATE_PAUSED') failures.push(row);
        }
      } finally {
        await socket.call('SetCurrentProgramScene', { sceneName: originalScene });
        await socket.call('RemoveInput', { inputName: sourceName });
        await socket.call('RemoveScene', { sceneName });
      }
    }
  } finally {
    await writeFile(join(directory, 'frame-position.json'), JSON.stringify({ passed: failures.length === 0 && rows.length === variants.length * 8,
      scope: '单来源视频的真实OBS截图条码定位；不代表四路负载或硬件解码已实际启用',
      dimensions, withAudio, fps, gop: fps * 3, bFrames, inputKind, cacheOnly, hevcDiagnostic, rows, failures }, null, 2));
  }
  assert.equal(failures.length, 0, '真实OBS截图帧号与目标不一致；不能依靠游标数值确认定位准确');
}
