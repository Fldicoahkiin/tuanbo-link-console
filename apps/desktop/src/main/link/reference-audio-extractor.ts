import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import ffmpegPath from 'ffmpeg-static';
import { ffmpegDeadline } from './ffmpeg-deadline';

export type AudioTrim = { startMs: number; durationMs: number; tailToleranceMs?: number };
export type ReferenceAudioExtractor = (sourcePath: string, destinationPath: string, trim?: AudioTrim) => Promise<void>;

export const extractReferenceAudioTrack: ReferenceAudioExtractor = async (sourcePath, destinationPath, trim) => {
  const executable = resolveFfmpegExecutable();
  await new Promise<void>((resolvePromise, reject) => {
    const process = spawn(executable, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
      ...(trim ? ['-af', `atrim=start=${trim.startMs / 1000}:duration=${trim.durationMs / 1000},asetpts=PTS-STARTPTS`] : []),
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
      destinationPath
    ], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpegDeadline(process, '提取音轨', 15 * 60_000, reject);
    let errorOutput = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => {
      errorOutput = `${errorOutput}${chunk}`.slice(-8_000);
    });
    process.on('error', (error) => {
      reject(new Error(`FFmpeg 启动失败：${error.message}`, { cause: error }));
    });
    process.on('exit', (code) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`FFmpeg 音轨提取失败（退出码 ${String(code)}）：${errorOutput.trim() || '没有错误输出'}`));
    });
  });
  if (trim) await alignExtractedAudioDuration(destinationPath, trim.durationMs, trim.tailToleranceMs ?? 2);
};

export async function alignExtractedAudioDuration(path: string, expectedMs: number, toleranceMs: number): Promise<void> {
  const actualMs = await readExtractedAudioDuration(path);
  if (Math.abs(actualMs - expectedMs) > toleranceMs) throw new Error(`裁剪区间超出可解码音频：需要 ${expectedMs} 毫秒，实际 ${Math.round(actualMs)} 毫秒；未缩短节目。`);
  const file = await open(path, 'r+');
  try {
    const size = (await file.stat()).size;
    const chunk = Buffer.alloc(8);
    for (let offset = 12; offset + 8 <= size;) {
      await file.read(chunk, 0, 8, offset);
      const length = chunk.readUInt32LE(4);
      if (chunk.toString('ascii', 0, 4) === 'data') {
        if (offset + 8 + length !== size) throw new Error('音频数据块不完整或存在尾部数据，不能安全对齐时长');
        const targetBytes = expectedMs * 192;
        const targetSize = offset + 8 + targetBytes;
        if (!Number.isSafeInteger(targetBytes) || targetBytes <= 0 || targetSize - 8 > 0xffffffff) throw new Error('音频目标时长超出 WAV 范围');
        if (targetBytes > length) await file.write(Buffer.alloc(targetBytes - length), 0, targetBytes - length, size);
        await file.truncate(targetSize);
        const word = Buffer.alloc(4);
        word.writeUInt32LE(targetBytes); await file.write(word, 0, 4, offset + 4);
        word.writeUInt32LE(targetSize - 8); await file.write(word, 0, 4, 4);
        return;
      }
      offset += 8 + length + length % 2;
    }
    throw new Error('裁剪结果缺少音频数据');
  } finally { await file.close(); }
}

/** Extractor output is always 48 kHz stereo PCM16; read chunks without loading audio. */
export async function readExtractedAudioDuration(path: string): Promise<number> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    await file.read(header, 0, 12, 0);
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('裁剪结果不是有效 WAV');
    const size = (await file.stat()).size;
    const chunk = Buffer.alloc(8);
    for (let offset = 12; offset + 8 <= size;) {
      await file.read(chunk, 0, 8, offset);
      const length = chunk.readUInt32LE(4);
      if (chunk.toString('ascii', 0, 4) === 'data') {
        const actualMs = Math.min(length, size - offset - 8) / 192;
        if (actualMs < 1) throw new Error('提取结果没有有效音频采样');
        return Math.floor(actualMs);
      }
      offset += 8 + length + length % 2;
    }
    throw new Error('裁剪结果缺少音频数据');
  } finally { await file.close(); }
}

function resolveFfmpegExecutable(): string {
  if (!ffmpegPath) throw new Error('缺少 FFmpeg 组件，请重新安装联动台');
  return ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
}

/** A single untouched PCM track can be reused without decode, copy and remix.
 * Other formats and declared subranges still use the normal rendering path. */
export async function referencePcmLayout(path: string): Promise<{ offset: number; bytes: number } | null> {
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(12);
    if ((await file.read(header, 0, 12, 0)).bytesRead !== 12 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') return null;
    const size = (await file.stat()).size;
    const chunk = Buffer.alloc(24);
    let pcm = false;
    for (let offset = 12; offset + 8 <= size;) {
      if ((await file.read(chunk, 0, Math.min(24, size - offset), offset)).bytesRead < 8) return null;
      const length = chunk.readUInt32LE(4);
      if (offset + 8 + length > size) return null;
      const name = chunk.toString('ascii', 0, 4);
      if (name === 'fmt ') pcm = length >= 16 && chunk.readUInt16LE(8) === 1 && chunk.readUInt16LE(10) === 2
        && chunk.readUInt32LE(12) === 48000 && chunk.readUInt32LE(16) === 192000 && chunk.readUInt16LE(20) === 4 && chunk.readUInt16LE(22) === 16;
      if (name === 'data') return pcm && length > 0 && length % 4 === 0 ? { offset: offset + 8, bytes: length } : null;
      offset += 8 + length + length % 2;
    }
    return null;
  } finally { await file.close(); }
}
