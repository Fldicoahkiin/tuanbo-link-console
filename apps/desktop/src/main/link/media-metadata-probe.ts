import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import type { LinkMediaKind } from '@tb/schema';

export type ProbedMediaMetadata = {
  durationMs?: number;
  width?: number;
  height?: number;
};

type ExecuteProbe = (executable: string, arguments_: string[]) => Promise<string>;

export class MediaMetadataProbe {
  constructor(
    private readonly executeProbe: ExecuteProbe = runProbe,
    private readonly resolveExecutable: () => string = resolveFfmpegExecutable
  ) {}

  async inspect(sourcePath: string, kind: LinkMediaKind): Promise<ProbedMediaMetadata> {
    const output = await this.executeProbe(this.resolveExecutable(), [
      '-hide_banner', '-i', sourcePath, '-map', '0', '-t', '0', '-f', 'null', '-'
    ]);
    const durationMs = parseDurationMs(output);
    const dimensions = parseVideoDimensions(output);
    if (kind !== 'image' && durationMs === null) throw new Error('FFmpeg 无法读取媒体时长');
    if (kind !== 'audio' && !dimensions) throw new Error('FFmpeg 无法读取画面尺寸');
    return {
      ...(durationMs !== null ? { durationMs } : {}),
      ...(dimensions ? { width: dimensions.width, height: dimensions.height } : {})
    };
  }
}

export function parseDurationMs(output: string): number | null {
  const match = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/i.exec(output);
  if (!match) return null;
  const milliseconds = Math.round((Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3])) * 1_000);
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : null;
}

export function parseVideoDimensions(output: string): { width: number; height: number } | null {
  const lines = output.split(/\r?\n/).filter((line) => /Stream #[^:]+:\d+.*Video:/i.test(line));
  for (const line of lines) {
    const match = /(?:^|[, ])(\d{2,6})x(\d{2,6})(?:[, \[]|$)/.exec(line);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };
  }
  return null;
}

function resolveFfmpegExecutable(): string {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  return ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
}

function runProbe(executable: string, arguments_: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { output = `${output}${chunk}`.slice(-32_000); });
    child.on('error', (error) => reject(new Error(`FFmpeg 启动失败：${error.message}`, { cause: error })));
    child.on('exit', (code) => {
      if (code === 0) resolve(output);
      else reject(new Error(`FFmpeg 媒体探测失败（退出码 ${String(code)}）：${output.trim() || '没有错误输出'}`));
    });
  });
}
