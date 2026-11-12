import { copyFile, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { analyzeIbtAudio } from './ibt-beat-service';

const executable = resolve('tools/ibt/bin/ibt.exe');
function pcmWave(silence: boolean): Buffer {
  const rate = 44100, duration = 12;
  const wav = Buffer.alloc(44 + rate * duration * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  if (!silence) for (let index = 0; index < rate * duration; index++) {
    const time = index / rate;
    const kick = Math.sin(time * Math.PI * 2 * 90) * Math.exp(-(time % 0.5) * 45) * 0.8;
    const hat = Math.sin(time * Math.PI * 2 * 6000) * Math.exp(-(time % 0.125) * 100) * 0.12;
    wav.writeInt16LE(Math.round((kick + hat) * 32767), 44 + index * 2);
  }
  return wav;
}

// Runs the real tools/ibt/bin/ibt.exe, which only `node tools/ibt/build.mjs` on Windows produces.
it.skipIf(process.platform !== 'win32')('真实 IBT 识别主拍，静音不生成外推节拍；支持中文路径', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tblink-节拍-'));
  const source = join(directory, '舞蹈 & 120.wav');
  try {
    await writeFile(source, pcmWave(false));
    const beats = await analyzeIbtAudio(source, 12000, copyFile, executable);
    expect(beats.dense.length).toBeGreaterThanOrEqual(21);
    expect(beats.dense.length).toBeLessThanOrEqual(25);
    expect(beats.dense.every(time => Math.abs(time - Math.round(time / 500) * 500) < 45)).toBe(true);
    expect(beats.standard.every(time => beats.dense.includes(time))).toBe(true);
    await writeFile(source, pcmWave(true));
    expect((await analyzeIbtAudio(source, 12000, copyFile, executable)).dense).toEqual([]);
    await expect(analyzeIbtAudio(source, 12000, copyFile, join(directory, 'missing.exe'))).rejects.toThrow('IBT');
  } finally { await unlink(source); await rmdir(directory); }
}, 30000);
