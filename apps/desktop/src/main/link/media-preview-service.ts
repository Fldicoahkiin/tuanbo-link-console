import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { hashFile, LinkProjectService } from './link-project-service';
import { VerifiedMediaFiles } from './verified-media-files';

export class MediaPreviewService {
  private readonly pending = new Map<string, Promise<string>>();
  private readonly verified = new VerifiedMediaFiles(hashFile);
  private thumbnailWorkers = 0;
  private readonly thumbnailQueue: (() => void)[] = [];
  private videoWorkers = 0;
  private readonly videoQueue: (() => void)[] = [];

  constructor(
    private readonly projects: LinkProjectService,
    private readonly executeFfmpeg: (executable: string, arguments_: string[]) => Promise<void> = runFfmpeg,
    private readonly resolveExecutable: () => string = resolveFfmpegExecutable
  ) {}

  ensureThumbnail(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    assertSha256(sha256);
    const key = `thumbnail:${resolve(projectPath)}:${sha256}`;
    const current = this.pending.get(key);
    if (current) return current;
    if (this.thumbnailQueue.length >= 32) return Promise.reject(new Error('缩略图准备队列已满，请停止滚动后重新打开素材列表'));
    const operation = this.thumbnailSlot(async () => {
      const source = this.projects.resolveMediaAsset(projectPath, relativePath);
      if (!await this.verified.verify(source, sha256)) throw new Error('原素材完整性校验失败，请重新导入');
      const directory = join(dirname(resolve(projectPath)), 'cache', 'media-thumbnails');
      const destination = join(directory, `${sha256}.jpg`);
      if (await pathExists(destination)) return destination;
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `.${sha256}.${crypto.randomUUID()}.tmp.jpg`);
      await generateTemporaryOutput(temporary, destination, () => this.executeFfmpeg(this.resolveExecutable(), [
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '1', '-filter_threads', '1', '-i', source,
        '-map', '0:v:0', '-an', '-frames:v', '1', '-vf', 'scale=320:320:force_original_aspect_ratio=decrease', '-q:v', '3', '-threads', '1', temporary
      ]));
      return destination;
    }).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async thumbnailSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.thumbnailWorkers >= 2) await new Promise<void>(resolve => this.thumbnailQueue.push(resolve));
    else this.thumbnailWorkers++;
    try { return await task(); }
    finally { const next = this.thumbnailQueue.shift(); if (next) next(); else this.thumbnailWorkers--; }
  }

  private async videoSlot<T>(task: () => Promise<T>): Promise<T> {
    if (this.videoQueue.length >= 32) throw new Error('视频准备队列已满，本次未开始生成缓存；请等待当前任务完成后重新准备');
    if (this.videoWorkers >= 2) await new Promise<void>(resolve => this.videoQueue.push(resolve));
    else this.videoWorkers++;
    try { return await task(); }
    finally { const next = this.videoQueue.shift(); if (next) next(); else this.videoWorkers--; }
  }

  ensureVideoPreview(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    assertSha256(sha256);
    const key = `video:${resolve(projectPath)}:${sha256}`;
    const current = this.pending.get(key);
    if (current) return current;
    const operation = this.createVideoPreview(projectPath, relativePath, sha256).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  async ensureObsSeekVideo(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    assertSha256(sha256);
    // Several assets may share one content-addressed output, but each source
    // path must be verified before joining that work. Otherwise preloading only
    // warms the first path and can also accept a different, corrupted source.
    const source = this.projects.resolveMediaAsset(projectPath, relativePath);
    if (!await this.verified.verify(source, sha256)) throw new Error('原素材完整性校验失败，请重新导入');
    const key = `obs-seek:${resolve(projectPath)}:${sha256}`;
    const current = this.pending.get(key);
    if (current) return current;
    const operation = this.createObsSeekVideo(projectPath, relativePath, sha256).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async createObsSeekVideo(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    const source = this.projects.resolveMediaAsset(projectPath, relativePath);
    const directory = join(dirname(resolve(projectPath)), 'cache', 'obs-seek-jpeg2000');
    const destination = join(directory, `${sha256}.source-pixels.mkv`);
    const checksumPath = `${destination}.sha256`;
    if (await pathExists(destination) && await pathExists(checksumPath)) {
      const digest = (await readFile(checksumPath, 'utf8')).trim();
      assertSha256(digest);
      if (!await this.verified.verify(destination, digest)) throw new Error(`OBS 定位缓存已损坏，请移除对应缓存后重新准备：${destination}`);
      return destination;
    }
    await mkdir(directory, { recursive: true });
    const temporaryPath = join(directory, `.${sha256}.${crypto.randomUUID()}.tmp.mkv`);
    await this.videoSlot(() => generateTemporaryOutput(temporaryPath, destination, async () => {
      await this.executeFfmpeg(this.resolveExecutable(), [
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '1', '-i', source,
          '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'ffv1', '-level', '3', '-g', '1', '-threads', '2',
        '-c:a', 'copy', '-avoid_negative_ts', 'disabled', temporaryPath
      ]);
      if (!await this.verified.verify(source, sha256)) throw new Error('原素材在生成定位缓存时发生变化');
    }));
    // Publish the checksum through the same identity-checked cache used during
    // admission. Otherwise the first use rehashes the file just generated by
    // next-program preloading, moving large disk reads back onto the boundary.
    await writeFile(checksumPath, await this.verified.digest(destination), 'utf8');
    return destination;
  }

  ensureAudioPreview(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    assertSha256(sha256);
    const key = `audio:${resolve(projectPath)}:${sha256}`;
    const current = this.pending.get(key);
    if (current) return current;
    const operation = this.createAudioPreview(projectPath, relativePath, sha256).finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async createVideoPreview(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    const source = this.projects.resolveMediaAsset(projectPath, relativePath);
    const projectDirectory = dirname(resolve(projectPath));
    const proxyDirectory = join(projectDirectory, 'cache', 'media-proxies');
    const destination = join(proxyDirectory, `${sha256}.mp4`);
    if (await pathExists(destination)) return destination;
    await mkdir(proxyDirectory, { recursive: true });
    const temporaryPath = join(proxyDirectory, `.${sha256}.${crypto.randomUUID()}.tmp.mp4`);
    await this.videoSlot(() => generateTemporaryOutput(temporaryPath, destination, async () => {
      await this.executeFfmpeg(this.resolveExecutable(), [
        '-hide_banner', '-loglevel', 'error', '-y', '-threads', '2', '-filter_threads', '1', '-i', source,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-threads', '2',
        temporaryPath
      ]);
    }));
    return destination;
  }

  private async createAudioPreview(projectPath: string, relativePath: string, sha256: string): Promise<string> {
    const source = this.projects.resolveMediaAsset(projectPath, relativePath);
    const previewDirectory = join(dirname(resolve(projectPath)), 'cache', 'media-audio');
    const destination = join(previewDirectory, `${sha256}.wav`);
    if (await pathExists(destination)) return destination;
    await mkdir(previewDirectory, { recursive: true });
    const temporaryPath = join(previewDirectory, `.${sha256}.${crypto.randomUUID()}.tmp.wav`);
    try {
      await generateTemporaryOutput(temporaryPath, destination, async () => {
        await this.executeFfmpeg(this.resolveExecutable(), [
          '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
          '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le',
          temporaryPath
        ]);
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('matches no streams')) {
        throw new Error('素材不包含音频轨道', { cause: error });
      }
      throw error;
    }
    return destination;
  }
}

async function generateTemporaryOutput(temporaryPath: string, destination: string, generate: () => Promise<void>): Promise<void> {
  try {
    await generate();
    await rename(temporaryPath, destination);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError) {
      if (!isErrorWithCode(cleanupError, 'ENOENT')) {
        throw new Error(`媒体代理失败且临时文件清理失败：${toMessage(error)}；清理失败：${toMessage(cleanupError)}`, {
          cause: new AggregateError([error, cleanupError])
        });
      }
    }
    throw error;
  }
}

function resolveFfmpegExecutable(): string {
  if (!ffmpegPath) throw new Error('FFmpeg 运行时未安装');
  return ffmpegPath.includes('app.asar') ? ffmpegPath.replace('app.asar', 'app.asar.unpacked') : ffmpegPath;
}

function runFfmpeg(executable: string, arguments_: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const process = spawn(executable, arguments_, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';
    process.stderr.setEncoding('utf8');
    process.stderr.on('data', (chunk: string) => { errorOutput = `${errorOutput}${chunk}`.slice(-8_000); });
    process.on('error', (error) => reject(new Error(`FFmpeg 启动失败：${error.message}`, { cause: error })));
    process.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`FFmpeg 生成编辑代理失败（退出码 ${String(code)}）：${errorOutput.trim() || '没有错误输出'}`));
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('媒体 SHA-256 格式无效');
}

function isErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
