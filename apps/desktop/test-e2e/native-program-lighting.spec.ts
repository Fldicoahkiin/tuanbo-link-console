import { test, expect, _electron as electron } from '@playwright/test';
import { createServer, type Server, type Socket } from 'node:net';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEmptyLinkProject, createLightingDocument, lightingTrackSchema, parseLinkProject } from '@tb/schema';
import { createDefaultIntegrationProfile } from '../src/renderer/src/link/view-models/local-integration-profile';

for (const failSecond of [false, true]) test(`正式原生灯光后台调度：${failSecond ? '控台拒绝时停止灯光并显示错误' : '界面阻塞、暂停和恢复不漏发或重发'}`, async ({}, info) => {
  test.skip(process.env.TBLINK_NATIVE_ENGINE_TEST !== '1', '真实 WASAPI + 隔离 TCP 协议端；不控制实体控台');
  const sockets = new Set<Socket>(), calls: { cue: string; receivedAt: number }[] = [];
  const own = (socket: Socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  const monitor = createServer(own);
  const command = createServer(socket => {
    own(socket); socket.write("Logged in as User 'guest'\r\n [Channel]>Please login !\r\n"); let buffer = '';
    socket.on('data', (data: Buffer) => {
      buffer += data.toString();
      while (buffer.includes('\r\n')) {
        const end = buffer.indexOf('\r\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line.startsWith('Login ')) { socket.write('\r\n [Channel]>'); continue; }
        const auth = /TBLINK_AUTH_[a-f0-9]{32}/.exec(line)?.[0], boot = /TBLINK_BOOT_[a-f0-9]{32}/.exec(line)?.[0];
        if (auth) { socket.write(`\r\n${auth}:3.9.60.74\r\n`); continue; }
        if (boot) { socket.write(`\r\n${boot}:ready\r\n`); continue; }
        const play = /TBLINK_PLAY_[a-f0-9]{32}/.exec(line)?.[0], cue = /gma.cmd\('Goto Cue ([\d.]+) Sequence 168'\)/.exec(line)?.[1];
        if (play && cue) { calls.push({ cue, receivedAt: Date.now() }); socket.write(`\r\n${play}:${failSecond && cue === '2.000' ? 'MISSING' : 'SENT'}\r\n`); }
      }
    });
  });
  const listen = async (server: Server) => { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('测试端口未就绪'); return address.port; };
  const port = await listen(command), monitorPort = await listen(monitor);
  const wav = Buffer.alloc(44 + 48000 * 4 * 10);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22); wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(192000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  await writeFile(info.outputPath('silence.wav'), wav);
  const points = [600, 1600, 2800, 5500, 8500];
  const track = lightingTrackSchema.parse({ id: 'track', name: '后台灯光', kind: 'ma2', color: '#68c9ed', group: 'effect-canvas',
    muted: false, solo: false, locked: false, channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [{ id: 'clip', name: '后台灯光', start: 0,
    duration: 10000, timeLock: 'time', muted: false, events: points.map((at, index) => ({ id: `cue-${index}`, at, kind: 'ma2', action: 'goto',
      sequence: 168, cue: `${index + 1}.000`, executor: '', label: `灯光 ${index + 1}` })) }] });
  const project = parseLinkProject({ ...createEmptyLinkProject('原生后台灯光验收'), schemaVersion: 2, playbackSource: 'internal', obsOutputMode: 'scenes',
    rundown: [{ id: 'song', title: '后台灯光', referenceAudio: { assetId: 'audio', relativePath: 'silence.wav', durationMs: 10000,
      sha256: createHash('sha256').update(wav).digest('hex') }, lighting: { ...createLightingDocument(), outputMode: 'network', tracks: [track] } }] });
  const file = info.outputPath('project.tblink'); await writeFile(file, JSON.stringify(project));
  const profile = createDefaultIntegrationProfile(); profile.obs.autoConnectOnLaunch = false;
  profile.internalPlayer = { audioEngine: 'native', nativeAudioOutputDeviceId: 'default', audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, audioSampleRate: 48000 };
  const app = await electron.launch({ args: [`--user-data-dir=${info.outputPath('profile')}`, join(process.cwd(), 'out/main/index.cjs')] });
  const page = await app.firstWindow(), evidence: Record<string, unknown> = { passed: false, scope: '真实 WASAPI / 主进程 / TCP；协议回执模拟，不代表实体灯具' };
  try {
    await page.waitForFunction(() => Boolean(window.tbLink));
    await page.evaluate(profile => window.tbLink.saveIntegrationProfile({ profile }), profile); await page.reload();
    await page.evaluate(async settings => { await window.tbLink.saveMa2Network({ settings }); const result = await window.tbLink.connectMa2Network();
      if (result.state !== 'connected') throw new Error(result.error ?? '测试连接失败');
    }, { host: '127.0.0.1', port, monitorPort, username: 'test', autoConnect: false });
    await app.evaluate(({ dialog }, file) => { dialog.showOpenDialog = () => Promise.resolve({ canceled: false, filePaths: [file] }); }, file);
    await page.getByRole('button', { name: '打开工程', exact: true }).click();
    await page.getByRole('navigation', { name: '主要工作区' }).getByRole('button', { name: '灯光工作台', exact: true }).click();
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect(page.getByRole('button', { name: '暂停时间线', exact: true })).toBeVisible();
    const before = await page.evaluate(async () => ({ state: await window.tbLink.getNativePlaybackStatus(), at: Date.now() }));
    expect(before.state!.positionMs).toBeLessThan(500);
    const after = await page.evaluate(() => { const started = performance.now(); while (performance.now() - started < 3500) { /* renderer fault */ } return Date.now(); });
    if (failSecond) {
      expect(calls.map(call => call.cue)).toEqual(['1.000', '2.000']);
      await expect(page.getByRole('region', { name: '通知', exact: true }).getByText(/灯光动作已停止.*控台没有找到 Sequence 168 Cue 2\.000/)).toBeVisible();
      expect((await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('playing');
      await page.getByRole('button', { name: '停止时间线', exact: true }).click();
      await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
      Object.assign(evidence, { passed: true, before, after, calls });
      return;
    }
    expect(calls.map(call => call.cue)).toEqual(['1.000', '2.000', '3.000']);
    expect(calls.every(call => call.receivedAt < after)).toBe(true);
    const errorsMs = calls.map((call, index) => call.receivedAt - before.at + before.state!.positionMs - points[index]!);
    expect(errorsMs.every(value => Math.abs(value) < 150)).toBe(true);
    await page.getByRole('button', { name: '暂停时间线', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('paused');
    await page.waitForTimeout(2000); expect(calls).toHaveLength(3);
    await page.getByRole('button', { name: '播放时间线', exact: true }).click();
    await expect.poll(() => calls.map(call => call.cue), { timeout: 4000 }).toEqual(['1.000', '2.000', '3.000', '4.000']);
    await page.getByRole('button', { name: '停止时间线', exact: true }).click();
    await expect.poll(async () => (await page.evaluate(() => window.tbLink.getNativePlaybackStatus()))?.status).toBe('stopped');
    await page.waitForTimeout(1000); expect(calls).toHaveLength(4);
    await page.screenshot({ path: info.outputPath('native-lighting-stopped.png') });
    Object.assign(evidence, { passed: true, before, after, calls, errorsMs });
  } finally {
    await writeFile(info.outputPath('evidence.json'), JSON.stringify(evidence, null, 2));
    await page.keyboard.press('Escape');
    await page.evaluate(async () => { await window.tbLink.setRuntimeActive(false); await window.tbLink.setDocumentDirty(false); });
    await app.close(); for (const socket of sockets) socket.destroy();
    await Promise.all([monitor, command].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});
