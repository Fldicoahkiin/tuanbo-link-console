import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, writeFile, link, copyFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';

// Synthetic, reproducible LOAD fixture. A few generated masters are hard-linked
// into distinct asset paths; the manifest explicitly excludes real-media diversity.
// No device connection, OBS mutation, MIDI send or playback occurs in this tool.
if (process.platform !== 'win32') throw new Error('稳定性基准必须在 Windows 生成');
const require = createRequire(resolve('apps/desktop/package.json'));
const ffmpeg = require('ffmpeg-static');
if (typeof ffmpeg !== 'string') throw new Error('缺少 FFmpeg');
const root = resolve(process.env.TBLINK_ACCEPTANCE_DIRECTORY ?? 'artifacts'); await mkdir(root, { recursive: true });
const directory = await mkdtemp(join(root, 'stability-fixture-'));
const masters = join(directory, 'masters'); await mkdir(masters);
await build({ stdin: { contents: "export {parseLinkProject,createEmptyLinkProject,createLightingDocument} from './packages/schema/src/index'; export {frameNumberToTimecode} from './packages/core/src/mtc-timecode';", resolveDir: process.cwd() },
  bundle: true, platform: 'node', format: 'cjs', alias: { '@tb/schema': resolve('packages/schema/src/index.ts') }, outfile: join(directory, 'fixture-domain.cjs') });
const { parseLinkProject, createEmptyLinkProject, createLightingDocument, frameNumberToTimecode } = require(join(directory, 'fixture-domain.cjs'));
async function render(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-threads', '2', '-filter_threads', '1', '-n', ...args], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = ''; child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { errors = (errors + data).slice(-4096); });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(`基准媒体生成失败 ${code}: ${errors}`)));
  });
}
for (const [name, size] of [['4k', '3840x2160'], ['1080', '1920x1080']]) {
  console.log(`生成 ${name} / 60fps / 12 秒动态测试视频`);
  await render(['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=60:duration=12`, '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-threads', '2', '-pix_fmt', 'yuv420p', join(masters, `${name}.mp4`)]);
}
await render(['-f', 'lavfi', '-i', 'color=c=blue@0.2:s=2160x3840,format=rgba', '-frames:v', '1', join(masters, 'overlay.png')]);
// -36 dB timing pulses, not production music. Exactly 108 seconds per program.
await render(['-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,1),0.02),0.015625*sin(2*PI*1000*t),0)':s=48000:d=108", '-ac', '2', '-c:a', 'pcm_s16le', join(masters, 'audio.wav')]);
const details = new Map();
for (const name of ['4k.mp4', '1080.mp4', 'overlay.png', 'audio.wav']) {
  const path = join(masters, name), data = await readFile(path);
  details.set(name, { sha256: createHash('sha256').update(data).digest('hex'), byteLength: (await stat(path)).size });
}
const time = frame => frameNumberToTimecode(frame, '30');
const reports = [];
for (const variant of ['mixed', 'four-4k']) {
  // The software only reads project files from its own asset folders.
  const output = join(directory, variant); await mkdir(join(output, 'assets', 'reference-media'), { recursive: true }); await mkdir(join(output, 'assets', 'reference-audio'), { recursive: true });
  await link(join(masters, 'audio.wav'), join(output, 'assets', 'reference-audio', 'audio.wav'));
  // Keep each video's NTFS link group below the per-file link limit. PNGs are
  // small independent copies; neither profile borrows a file from the other.
  for (const master of ['4k.mp4', '1080.mp4']) await copyFile(join(masters, master), join(output, master));
  const assets = [], rundown = [];
  for (let program = 0; program < 200; program++) {
    const prefix = `program-${program + 1}`;
    const visualLayers = Array.from({ length: 8 }, (_, layer) => ({ id: `${prefix}-layer-${layer}`, name: layer < 4 ? `叠加 ${layer + 1}` : `视频 ${layer - 3}`, visible: true, locked: false }));
    for (let index = 0; index < 10; index++) {
      const video = index < 4, high = variant === 'four-4k' || index < 2;
      const master = video ? `${high ? '4k' : '1080'}.mp4` : 'overlay.png';
      const relativePath = `assets/reference-media/${prefix}-asset-${index}.${video ? 'mp4' : 'png'}`;
      if (video) await link(join(output, master), join(output, relativePath));
      else await copyFile(join(masters, master), join(output, relativePath));
      assets.push({ id: `${prefix}-asset-${index}`, name: `合成素材 ${program * 10 + index + 1}`, kind: video ? 'video' : 'image', relativePath,
        ...details.get(master), ...(video ? { durationMs: 12000 } : {}), width: video ? high ? 3840 : 1920 : 2160, height: video ? high ? 2160 : 1080 : 3840 });
    }
    const clips = [];
    for (let layer = 0; layer < 4; layer++) {
      for (let section = 0; section < 9; section++) clips.push({ id: `${prefix}-video-${layer}-${section}`, assetId: `${prefix}-asset-${layer}`, label: `视频 ${layer + 1}`, layerId: visualLayers[layer + 4].id,
        startTimecode: time(section * 360), durationMs: 12000, sourceOffsetMs: 0, embeddedAudioEnabled: false });
      clips.push({ id: `${prefix}-image-${layer}`, assetId: `${prefix}-asset-${layer + 4}`, label: `叠加 ${layer + 1}`, layerId: visualLayers[layer].id, startTimecode: time(0), durationMs: 108000 });
    }
    const lighting = createLightingDocument(); lighting.outputMode = 'direct';
    lighting.tracks = [{ id: `${prefix}-lighting`, name: '合成灯光动作（专用回环）', kind: 'midi', color: '#ffcc66', group: '', muted: false, solo: false, locked: false,
      channel: 1, portProfileId: 'stability-loopback-only', controller: 7, noteNames: {}, clips: [{ id: `${prefix}-lighting-clip`, name: '合成测试', start: 0, duration: 108000, timeLock: 'time', muted: false,
        events: Array.from({ length: 125 }, (_, cue) => ({ id: `${prefix}-light-${cue}`, kind: 'note', at: cue * 850, duration: 80, note: cue % 64 + 32, velocity: 1 })) }] }];
    rundown.push({ id: prefix, title: `合成验收节目 ${program + 1}`, notes: '合成负载，不是现场 MA2 导出；灯光只配专用测试回环。', visualLayers, referenceMediaClips: clips, lighting,
      referenceAudio: { assetId: `${prefix}-audio`, relativePath: 'assets/reference-audio/audio.wav', sha256: details.get('audio.wav').sha256, durationMs: 108000 },
      playback: { volume: 100, startMs: 0, endMs: 108000, mtcOffsetMs: 480000 + program * 120000, shortcut: '', endAction: program === 199 ? 'pause' : 'next' },
      cues: Array.from({ length: 125 }, (_, cue) => ({ id: `${prefix}-camera-${cue}`, name: `合成机位 ${cue % 16 + 1}`, timecode: time(12 + cue * 25), durationMs: 200,
        layerId: visualLayers[4].id, actions: [{ id: `${prefix}-action-${cue}`, label: '切换合成场景', kind: 'obs.setProgramScene', sceneName: `TBLINK 验收机位 ${cue % 16 + 1}` }] })) });
  }
  const project = parseLinkProject({ ...createEmptyLinkProject(`六小时结构与解码负载 ${variant}`), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes', outputCanvas: { width: 2160, height: 3840 }, mediaAssets: assets, rundown });
  const bytes = JSON.stringify(project);
  await writeFile(join(output, 'stability.tblink'), bytes);
  reports.push({ variant, programs: 200, assets: assets.length, authoredCues: 50000, totalSeconds: 21600, maximumVideos: 4, visualLayers: 8,
    sceneNames: Array.from({ length: 16 }, (_, i) => `TBLINK 验收机位 ${i + 1}`), projectSha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ synthetic: true, physicalAcceptance: false, loadAcceptance: false,
  sourceDiversity: '2 generated video masters, 1 PNG and 1 WAV; videos use independent hard-linked paths, PNGs are copies. This does not cover 2000 distinct real-world encodes or cold-disk I/O.',
  midiProfile: 'stability-loopback-only', reports }, null, 2));
console.log(`已生成可读取工程与真实合成媒体：${directory}。未执行播放、设备连接或验收。`);
