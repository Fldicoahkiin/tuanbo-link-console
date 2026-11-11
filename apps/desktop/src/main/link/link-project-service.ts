import { createHash } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, copyFile, mkdir, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  linkMediaAssetSchema,
  parseLinkProject,
  serializeLinkProject,
  type LinkMediaAsset,
  type LinkMediaKind,
  type LinkProject,
  type LinkProjectAssetRelinkResult
} from '@tb/schema';
import { isProjectAssetPath, MEDIA_EXTENSIONS, REFERENCE_AUDIO_EXTENSIONS, type LinkProjectAssetInspection } from '@tb/core/link';
import { writeFileAtomically } from './atomic-file';
import { recoverMa2Read } from './ma2-read-recovery';
import { recoverMa2Material } from './ma2-material-recovery';
import { VerifiedMediaFiles } from './verified-media-files';
import { ReferenceAudioCache } from './reference-audio-cache';
import { ProjectWriteQueue } from './project-write-queue';
import {
  extractReferenceAudioTrack,
  readExtractedAudioDuration,
  type ReferenceAudioExtractor
} from './reference-audio-extractor';

export const REFERENCE_AUDIO_CONTAINER_EXTENSIONS: ReadonlySet<string> = new Set(['.avi', '.m4v', '.mkv', '.mov', '.mp4', '.webm']);
/** The waveform worker's output limit, and room for that many peaks as JSON. */
const MAX_WAVEFORM_PEAKS = 500_000;
const MAX_WAVEFORM_CACHE_BYTES = 16 * 1024 * 1024;
const waveformPeaksSchema = z.array(z.number().finite().min(-1).max(1)).min(1).max(MAX_WAVEFORM_PEAKS);
/** A bare array is the format before 2026-11-11, written without checking which file was decoded. Since then
 * a cache names the sha256 its decoded file was verified against, so a cache built from another song's file
 * (the home player once asked with the previous song's link) can be told apart and rebuilt. */
const waveformCacheFileSchema = z.union([
  waveformPeaksSchema,
  z.object({ sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), peaks: waveformPeaksSchema }).strict()
]);
type WaveformCacheFile = z.infer<typeof waveformCacheFileSchema>;

/** `sourceVerified`: the peaks were decoded from a file verified to be this very song. */
export type WaveformCacheEntry = { peaks: number[]; sourceVerified: boolean };

export type ImportedReferenceAudio = {
  assetId: string;
  relativePath: string;
  sha256: string;
  durationMs: number;
};

export class LinkProjectService {
  private readonly fileAccess = new Map<string, Promise<void>>();
  private readonly pendingSaves = new ProjectWriteQueue((path, project, backupOriginal) => this.withProjectFile(path, () => this.writeSavedProject(path, project, backupOriginal)));
  private readonly verifiedMedia = new VerifiedMediaFiles(hashFile);
  private readonly referenceAudioCache = new ReferenceAudioCache(hashFile);

  constructor(
    private readonly extractAudioTrack: ReferenceAudioExtractor = extractReferenceAudioTrack,
    private readonly writeProject: typeof writeFileAtomically = writeFileAtomically
  ) {}

  async open(projectPath: string): Promise<LinkProject> {
    return (await this.openDocument(projectPath)).project;
  }

  /** `upgraded`: the opened content differs from the file (format defaults, dropped fields or merged
   * read checkpoints). The file itself is left as it is until the operator saves. */
  async openDocument(projectPath: string): Promise<{ project: LinkProject; upgraded: boolean }> {
    assertProjectExtension(projectPath);
    return this.withProjectFile(projectPath, () => this.readProject(projectPath));
  }

  /** Windows may refuse rename while the target is open. Serialize our reads
   * with writes; external locks still fail visibly, without retrying a save. */
  private withProjectFile<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const absolute=resolve(path);const key=process.platform==='win32' ? absolute.toLowerCase() : absolute;
    const result=(this.fileAccess.get(key) ?? Promise.resolve()).then(operation);
    // The caller owns errors. This settled tail only releases the file queue.
    const tail=result.then(()=>undefined,()=>undefined);this.fileAccess.set(key,tail);
    void tail.then(()=>{if(this.fileAccess.get(key)===tail)this.fileAccess.delete(key);});
    return result;
  }

  private async readProject(projectPath: string): Promise<{ project: LinkProject; upgraded: boolean }> {
    const content = await readFile(projectPath, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch (error) {
      throw new Error(`工程文件格式不对，可能已损坏：${projectPath}`, { cause: error });
    }
    const parsed = parseLinkProject(value);
    const project = await recoverMa2Material(projectPath, await recoverMa2Read(projectPath, parsed));
    return { project, upgraded: project !== parsed || JSON.stringify(value) !== JSON.stringify(parsed) };
  }

  /** `backupOriginal`: the first save after an in-memory upgrade keeps the file as it was. */
  async save(projectPath: string, project: LinkProject, backupOriginal = false): Promise<void> {
    assertProjectExtension(projectPath);
    return this.pendingSaves.enqueue(projectPath, project, backupOriginal);
  }

  /** A copy outside any project file, e.g. a recovery copy: atomic, without upgrade backups. */
  async writeCopy(copyPath: string, project: LinkProject): Promise<void> {
    assertProjectExtension(copyPath);
    return this.withProjectFile(copyPath, () => this.writeProject(copyPath, serializeLinkProject(project)));
  }

  private async writeSavedProject(absolutePath: string, project: LinkProject, backupOriginal: boolean): Promise<void> {
    const content = serializeLinkProject(project);
    if (backupOriginal) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      try { await copyFile(absolutePath, `${absolutePath}.${stamp}.before-upgrade.bak`, constants.COPYFILE_EXCL); }
      // A file removed since it was opened has no original left to keep.
      catch (error) { if (!isErrorWithCode(error, 'ENOENT')) throw error; }
    }
      if (project.rundown.some(item => item.lighting?.musicAnalysis)) {
        try {
          const original = await readFile(absolutePath, 'utf8');
          const old = parseLinkProject(JSON.parse(original));
          if (!old.rundown.some(item => item.lighting?.musicAnalysis)) {
            try { await copyFile(absolutePath, `${absolutePath}.before-music-analysis.bak`, constants.COPYFILE_EXCL); }
            catch (error) { if (!isErrorWithCode(error, 'EEXIST')) throw error; }
          }
        } catch (error) { if (!isErrorWithCode(error, 'ENOENT')) throw error; }
      }
      if (project.ma2MaterialLibrary?.version === 2 || project.rundown.some(item => item.lighting?.version === 2)) {
        try {
          const old = parseLinkProject(JSON.parse(await readFile(absolutePath, 'utf8')));
          if (old.ma2MaterialLibrary?.version !== 2 && !old.rundown.some(item => item.lighting?.version === 2)) {
            try { await copyFile(absolutePath, `${absolutePath}.before-lighting-library.bak`, constants.COPYFILE_EXCL); }
            catch (error) { if (!isErrorWithCode(error, 'EEXIST')) throw error; }
          }
        } catch (error) { if (!isErrorWithCode(error, 'ENOENT')) throw error; }
      }
      if (project.ma2ReadState?.formatVersion === 2 || project.ma2MaterialLibrary) {
        try {
          const old = parseLinkProject(JSON.parse(await readFile(absolutePath, 'utf8')));
          if (old.ma2ReadState?.formatVersion !== 2 && !old.ma2MaterialLibrary) {
            try { await copyFile(absolutePath, `${absolutePath}.before-ma2-workflow.bak`, constants.COPYFILE_EXCL); }
            catch (error) { if (!isErrorWithCode(error, 'EEXIST')) throw error; }
          }
        } catch (error) { if (!isErrorWithCode(error, 'ENOENT')) throw error; }
      }
      await this.writeProject(absolutePath, content);
  }

  async loadWaveformCache(projectPath: string, sha256: string): Promise<WaveformCacheEntry | null> {
    assertSha256(sha256);
    try {
      return waveformCacheEntry(await readWaveformCacheFile(waveformCachePath(projectPath, sha256)), sha256);
    } catch (error) {
      if (isErrorWithCode(error, 'ENOENT')) return null;
      throw error;
    }
  }

  /** Only a caller that checked the decoded file against `sha256` may pass `sourceVerified: true`. */
  async saveWaveformCache(projectPath: string, sha256: string, peaks: number[], sourceVerified: boolean): Promise<void> {
    assertSha256(sha256);
    if (!waveformPeaksSchema.safeParse(peaks).success) {
      throw new Error(`波形峰值必须是 1 到 ${MAX_WAVEFORM_PEAKS} 个 -1 到 1 之间的有限数值`);
    }
    const path = waveformCachePath(projectPath, sha256);
    await assertRealPathInside(dirname(resolve(projectPath)), dirname(path), '保存波形缓存已拒绝：工程文件夹中的 cache/waveforms 经符号链接或目录联接指向工程文件夹之外');
    await writeFileAtomically(path, `${JSON.stringify(sourceVerified ? { sourceSha256: sha256, peaks } : peaks)}\n`);
  }

  async inspectAssets(projectPath: string, project: LinkProject): Promise<LinkProjectAssetInspection> {
    const result: LinkProjectAssetInspection = { referenceAudio: {}, media: {} };
    for (const item of project.rundown) {
      if (!item.referenceAudio) continue;
      const audioPath = this.resolveReferenceAudio(projectPath, item.referenceAudio.relativePath);
      result.referenceAudio[item.id] = {
        audioAvailable: await pathExists(audioPath),
        waveformAvailable: await pathExists(waveformCachePath(projectPath, item.referenceAudio.sha256))
      };
    }
    result.media = await this.inspectMediaAssets(projectPath, project.mediaAssets);
    return result;
  }

  async inspectMediaAssets(projectPath: string, assets: Pick<LinkMediaAsset, 'id' | 'relativePath' | 'sha256' | 'name'>[]): Promise<LinkProjectAssetInspection['media']> {
    const result: LinkProjectAssetInspection['media'] = {};
    // Bounded disk work. Never start thousands of reads or hash an entire Show
    // simply because the renderer mounted a material list.
    for (let offset = 0; offset < assets.length; offset += 4) {
      await Promise.all(assets.slice(offset, offset + 4).map(async asset => {
        const path = this.resolveMediaAsset(projectPath, asset.relativePath);
        const exists = await pathExists(path);
        if (exists && !await this.verifiedMedia.verify(path, asset.sha256)) throw new Error(`素材文件校验失败：${asset.name}，请重新导入原文件`);
        result[asset.id] = { fileAvailable: exists };
      }));
    }
    return result;
  }

  async importReferenceAudio(
    projectPath: string,
    sourcePath: string,
    durationMs: number | null,
    startMs = 0,
    preserveP1Duration = false
  ): Promise<ImportedReferenceAudio> {
    assertProjectExtension(projectPath);
    if (!Number.isFinite(startMs) || startMs < 0) throw new Error('音频裁剪起点必须是非负毫秒数');
    if (durationMs !== null && (!Number.isInteger(durationMs) || durationMs <= 0)) {
      throw new Error('参考音频时长必须是正整数毫秒');
    }
    const extension = extname(sourcePath).toLowerCase();
    if (!REFERENCE_AUDIO_EXTENSIONS.has(extension) && !REFERENCE_AUDIO_CONTAINER_EXTENSIONS.has(extension)) {
      throw new Error(`不支持的参考音频格式：${extension || '无扩展名'}`);
    }
    await access(sourcePath, constants.R_OK);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error('参考音频必须是非空文件');

    const projectDirectory = dirname(resolve(projectPath));
    const assetsDirectory = join(projectDirectory, 'assets', 'reference-audio');
    await mkdir(assetsDirectory, { recursive: true });
    if (REFERENCE_AUDIO_CONTAINER_EXTENSIONS.has(extension) && startMs === 0 && !preserveP1Duration) {
      const audio = await this.referenceAudioCache.ensure(projectPath, sourcePath,
        () => this.importContainerAudio(assetsDirectory, projectDirectory, sourcePath, null, 0, false));
      return { ...audio, durationMs: durationMs === null ? audio.durationMs : Math.min(durationMs, audio.durationMs) };
    }
    if (durationMs === null || startMs > 0 || REFERENCE_AUDIO_CONTAINER_EXTENSIONS.has(extension)) {
      return this.importContainerAudio(assetsDirectory, projectDirectory, sourcePath, durationMs, startMs, preserveP1Duration);
    }

    const digest = await hashFile(sourcePath);
    const destination = join(assetsDirectory, `${digest}${extension}`);

    if (!(await pathExists(destination))) {
      const temporaryPath = join(assetsDirectory, `.${crypto.randomUUID()}.tmp`);
      await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
      try {
        await rename(temporaryPath, destination);
      } catch (error) {
        throw new Error(`导入参考音频失败；临时文件：${temporaryPath}`, { cause: error });
      }
    }

    const relativePath = relative(projectDirectory, destination).replaceAll('\\', '/');
    return {
      assetId: crypto.randomUUID(),
      relativePath,
      sha256: digest,
      durationMs
    };
  }

  private async importContainerAudio(
    assetsDirectory: string,
    projectDirectory: string,
    sourcePath: string,
    durationMs: number | null,
    startMs: number,
    preserveP1Duration: boolean
  ): Promise<ImportedReferenceAudio> {
    const temporaryPath = join(assetsDirectory, `.${crypto.randomUUID()}.tmp.wav`);
    try {
      await this.extractAudioTrack(sourcePath, temporaryPath, durationMs !== null && (startMs > 0 || preserveP1Duration) ? { startMs, durationMs, ...(preserveP1Duration ? { tailToleranceMs: 250 } : {}) } : undefined);
      const extractedStat = await stat(temporaryPath);
      if (!extractedStat.isFile() || extractedStat.size <= 0) throw new Error('提取结果为空');
      const decodedDurationMs = await readExtractedAudioDuration(temporaryPath);
      const digest = await hashFile(temporaryPath);
      const destination = join(assetsDirectory, `${digest}.wav`);
      if (await pathExists(destination)) await unlink(temporaryPath);
      else await rename(temporaryPath, destination);
      return {
        assetId: crypto.randomUUID(),
        relativePath: relative(projectDirectory, destination).replaceAll('\\', '/'),
        sha256: digest,
        durationMs: durationMs === null ? decodedDurationMs : Math.min(durationMs, decodedDurationMs)
      };
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isErrorWithCode(cleanupError, 'ENOENT')) {
          throw new Error(`MP4 音轨导入失败且临时文件清理失败：${toMessage(error)}；清理失败：${toMessage(cleanupError)}`, {
            cause: new AggregateError([error, cleanupError])
          });
        }
      }
      if (error instanceof Error && error.message.includes('matches no streams')) throw new Error('素材不包含音频轨道', { cause: error });
      throw new Error(`素材里没有能解码的音轨：${sourcePath}：${toMessage(error)}`, { cause: error });
    }
  }

  async importMediaAsset(
    projectPath: string,
    sourcePath: string,
    metadata: Pick<LinkMediaAsset, 'name' | 'kind' | 'durationMs' | 'width' | 'height'>
  ): Promise<LinkMediaAsset> {
    assertProjectExtension(projectPath);
    const extension = extname(sourcePath).toLowerCase();
    if (!MEDIA_EXTENSIONS[metadata.kind].has(extension)) {
      throw new Error(`不支持的${mediaKindLabel(metadata.kind)}格式：${extension || '无扩展名'}`);
    }
    await access(sourcePath, constants.R_OK);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error('媒体素材必须是非空文件');

    const digest = await hashFile(sourcePath);
    const projectDirectory = dirname(resolve(projectPath));
    const assetsDirectory = join(projectDirectory, 'assets', 'reference-media');
    const destination = join(assetsDirectory, `${digest}${extension}`);
    await mkdir(assetsDirectory, { recursive: true });
    await copyIntoProject(sourcePath, destination, assetsDirectory, '导入媒体素材', digest);

    return linkMediaAssetSchema.parse({
      id: crypto.randomUUID(),
      name: metadata.name.trim(),
      kind: metadata.kind,
      relativePath: relative(projectDirectory, destination).replaceAll('\\', '/'),
      sha256: digest,
      byteLength: sourceStat.size,
      ...(metadata.durationMs !== undefined ? { durationMs: metadata.durationMs } : {}),
      ...(metadata.width !== undefined ? { width: metadata.width } : {}),
      ...(metadata.height !== undefined ? { height: metadata.height } : {})
    });
  }

  /** Relative paths of the given asset files that are absent from the project
   * folder. Only asset-folder files are checked, so this cannot probe others. */
  async findMissingAssetFiles(projectPath: string, files: readonly { relativePath: string }[]): Promise<string[]> {
    assertProjectExtension(projectPath);
    const paths = files.map(file => {
      const path = resolveProjectAsset(projectPath, file.relativePath, '工程素材');
      assertProjectAssetPath(file.relativePath);
      return { relativePath: file.relativePath, path };
    });
    const missing: string[] = [];
    for (const { relativePath, path } of paths) {
      if (!await pathExists(path)) missing.push(relativePath);
    }
    return missing;
  }

  /** Brings back files missing from the project folder from the same relative
   * path under sourceDirectory, for example the folder the .tblink was moved
   * out of. Only a file with the recorded SHA-256 is copied; nothing else is
   * searched for. A restored file's waveform cache comes along when the
   * source folder has one. The project document itself does not change. Only
   * files the software imports are restored, and symbolic links or junctions
   * may not lead out of either folder; one refused file refuses the whole request. */
  async relinkAssetFiles(projectPath: string, sourceDirectory: string, files: readonly { relativePath: string; sha256: string }[]): Promise<LinkProjectAssetRelinkResult> {
    assertProjectExtension(projectPath);
    if (!isAbsolute(sourceDirectory)) throw new Error('原工程文件夹必须是完整路径');
    const projectDirectory = dirname(resolve(projectPath)); const sourceFolder = resolve(sourceDirectory);
    const targets = files.map(file => {
      const destination = resolveProjectAsset(projectPath, file.relativePath, '工程素材');
      assertProjectAssetPath(file.relativePath);
      return { ...file, destination, source: resolveInsideFolder(sourceFolder, file.relativePath, '工程素材') };
    });
    const result: LinkProjectAssetRelinkResult = [];
    for (const { relativePath, sha256, destination, source } of targets) {
      if (await pathExists(destination)) { result.push({ relativePath, status: 'present' }); continue; }
      if (!await pathExists(source)) { result.push({ relativePath, status: 'not-found' }); continue; }
      await assertRealPathInside(sourceFolder, source, `找回素材已拒绝：所选文件夹中的 ${relativePath} 经符号链接或目录联接指向该文件夹之外`);
      if (await hashFile(source) !== sha256) { result.push({ relativePath, status: 'mismatch' }); continue; }
      // Checked before mkdir, so a linked assets folder does not get folders created through it either.
      await assertRealPathInside(projectDirectory, dirname(destination), `找回素材已拒绝：工程文件夹中 ${relativePath} 所在的文件夹经符号链接或目录联接指向工程文件夹之外`);
      // P1 follow preflight blocks on a missing waveform, so it moves with its audio.
      const waveform = join(sourceFolder, 'cache', 'waveforms', `${sha256}.json`); const waveformDestination = waveformCachePath(projectPath, sha256);
      let cache: WaveformCacheFile | null = null;
      if (await pathExists(waveform) && !await pathExists(waveformDestination)) {
        await assertRealPathInside(sourceFolder, waveform, `找回波形缓存已拒绝：所选文件夹中的 cache/waveforms/${sha256}.json 经符号链接或目录联接指向该文件夹之外`);
        await assertRealPathInside(projectDirectory, dirname(waveformDestination), '找回波形缓存已拒绝：工程文件夹中的 cache/waveforms 经符号链接或目录联接指向工程文件夹之外');
        cache = await readWaveformCacheFile(waveform);
      }
      await mkdir(dirname(destination), { recursive: true });
      await copyIntoProject(source, destination, dirname(destination), '找回素材', sha256);
      // Copied as it is: an old cache stays unverified and is rebuilt when the song's waveform is next shown.
      if (cache) await writeFileAtomically(waveformDestination, `${JSON.stringify(cache)}\n`);
      result.push({ relativePath, status: 'restored' });
    }
    return result;
  }

  resolveReferenceAudio(projectPath: string, relativePath: string): string {
    return resolveProjectAsset(projectPath, relativePath, '参考音频');
  }

  resolveMediaAsset(projectPath: string, relativePath: string): string {
    return resolveProjectAsset(projectPath, relativePath, '媒体素材');
  }
}

async function copyIntoProject(
  sourcePath: string,
  destination: string,
  assetsDirectory: string,
  operation: string,
  expectedSha256: string
): Promise<void> {
  if (await pathExists(destination)) {
    if (await hashFile(destination) !== expectedSha256) throw new Error(`${operation}失败：工程里已有的素材和原文件不一致，请恢复原文件`);
    return;
  }
  const temporaryPath = join(assetsDirectory, `.${crypto.randomUUID()}.tmp`);
  await copyFile(sourcePath, temporaryPath, constants.COPYFILE_EXCL);
  try {
    if (await hashFile(temporaryPath) !== expectedSha256) throw new Error('复制出来的文件和原文件不一致，原文件可能正在被修改');
    await rename(temporaryPath, destination);
  } catch (error) {
    throw new Error(`${operation}失败；临时文件：${temporaryPath}`, { cause: error });
  }
}

function resolveProjectAsset(projectPath: string, relativePath: string, label: string): string {
  return resolveInsideFolder(dirname(resolve(projectPath)), relativePath, label);
}

function resolveInsideFolder(projectDirectory: string, relativePath: string, label: string): string {
  const resolved = resolve(projectDirectory, relativePath);
  const relativeResolved = relative(projectDirectory, resolved);
  if (
    relativeResolved === ''
    || relativeResolved === '..'
    || relativeResolved.startsWith(`..${sep}`)
    || isAbsolute(relativeResolved)
    || basename(resolved) === ''
  ) {
    throw new Error(`${label}路径必须位于工程目录内`);
  }
  return resolved;
}

function assertProjectAssetPath(relativePath: string): void {
  if (!isProjectAssetPath(relativePath)) throw new Error(`只能使用 assets/reference-audio 或 assets/reference-media 中的音视频和图片文件：${relativePath}`);
}

/** The one check for files the window names inside a project: asset-folder files with an imported
 * extension, inside the project folder as written and after following links. One refusal refuses all. */
export async function resolveProjectAssetFiles(projectPath: string, relativePaths: readonly string[]): Promise<string[]> {
  const paths = relativePaths.map(relativePath => {
    assertProjectAssetPath(relativePath);
    return resolveProjectAsset(projectPath, relativePath, '工程素材');
  });
  const folder = await realpath(dirname(resolve(projectPath)));
  for (const [index, path] of paths.entries()) {
    if (!isInsideFolder(folder, await realpathOfNearestExisting(path))) throw new Error(`工程素材 ${relativePaths[index]} 经符号链接或目录联接指向工程文件夹之外，已拒绝`);
  }
  return paths;
}

/** Follows symbolic links and junctions. A path that does not exist yet is
 * judged by its nearest existing parent, the folder it would be created in. */
async function assertRealPathInside(folder: string, path: string, refusal: string): Promise<void> {
  const [realFolder, realPath] = await Promise.all([realpath(folder), realpathOfNearestExisting(path)]);
  if (!isInsideFolder(realFolder, realPath)) throw new Error(refusal);
}

function isInsideFolder(folder: string, path: string): boolean {
  const inside = relative(folder, path);
  return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

async function realpathOfNearestExisting(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isErrorWithCode(error, 'ENOENT') || dirname(path) === path) throw error;
    return realpathOfNearestExisting(dirname(path));
  }
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  // Keep integrity checks streaming, with fewer filesystem round trips for 4K
  // media and rendered PCM. One-MiB blocks keep memory bounded.
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    const bytes: unknown = chunk;
    if (!Buffer.isBuffer(bytes)) throw new Error('素材读取未返回二进制数据');
    hash.update(bytes);
  }
  return hash.digest('hex');
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch (error) {
    if (isErrorWithCode(error, 'ENOENT')) return false;
    throw error;
  }
}

function assertProjectExtension(projectPath: string): void {
  if (extname(projectPath).toLowerCase() !== '.tblink') {
    throw new Error('工程文件必须使用 .tblink 扩展名');
  }
}

/** Same shape as saveWaveformCache writes; a file from elsewhere is checked before it is read whole. */
async function readWaveformCacheFile(path: string): Promise<WaveformCacheFile> {
  if ((await stat(path)).size > MAX_WAVEFORM_CACHE_BYTES) throw new Error(`波形缓存超过 16 MB：${path}`);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`波形缓存损坏：${path}`, { cause: error });
  }
  const parsed = waveformCacheFileSchema.safeParse(value);
  if (!parsed.success) throw new Error(`波形缓存结构无效：${path}`);
  return parsed.data;
}

/** A cache verified against another sha256 than its file name is as unverified as an old one. */
function waveformCacheEntry(file: WaveformCacheFile, sha256: string): WaveformCacheEntry {
  return Array.isArray(file) ? { peaks: file, sourceVerified: false } : { peaks: file.peaks, sourceVerified: file.sourceSha256 === sha256 };
}

function waveformCachePath(projectPath: string, sha256: string): string {
  return join(dirname(resolve(projectPath)), 'cache', 'waveforms', `${sha256}.json`);
}

function assertSha256(value: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('SHA-256 格式无效');
}

function mediaKindLabel(kind: LinkMediaKind): string {
  if (kind === 'audio') return '音频';
  if (kind === 'video') return '视频';
  return '图片';
}

function isErrorWithCode(error: unknown, code: string): error is Error & { code: string } {
  return error instanceof Error && 'code' in error && error.code === code;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
