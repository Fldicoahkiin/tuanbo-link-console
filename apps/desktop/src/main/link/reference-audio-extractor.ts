import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';

export type ReferenceAudioExtractor = (sourcePath: string, destinationPath: string) => Promise<void>;

export const extractReferenceAudioTrack: ReferenceAudioExtractor = async (sourcePath, destinationPath) => {
  const executable = resolveFfmpegExecutable();
  await new Promise<void>((resolvePromise, reject) => {
    const process = spawn(executable, [
      '-hide_banner', '-loglevel', 'error', '-y', '-i', sourcePath,
      '-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le',
      destinationPath
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
};

function resolveFfmpegExecutable(): string {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  return ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
}
