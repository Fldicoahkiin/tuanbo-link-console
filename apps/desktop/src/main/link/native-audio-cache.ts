import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, statfs, unlink, open } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomically } from './atomic-file';
import { NativeAudioDecode, type DecodeResult } from './native-audio-decode';

const requestSchema = z.object({ sourcePath: z.string().min(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  sampleRate: z.union([z.literal(44100), z.literal(48000)]), expectedDurationMs: z.number().finite().positive().max(86_400_000),
  positionMs: z.number().finite().nonnegative().default(0) }).strict().refine(value => value.positionMs < value.expectedDurationMs);
const keyPattern = /^[a-f0-9]{64}-(44100|48000)-\d+$/;
const manifestSchema = z.object({ version: z.literal(2), key: z.string().regex(keyPattern),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), pcmSha256: z.string().regex(/^[a-f0-9]{64}$/), baseFrame: z.number().int().nonnegative(),
  frames: z.number().int().positive(), sampleRate: z.union([z.literal(44100), z.literal(48000)]), bytes: z.number().int().positive(), lastUsed: z.number().finite() }).strict();
type Manifest = z.infer<typeof manifestSchema>;
type Active = { key: string; path: string; cachedPath: string; metadata: string; decoder: NativeAudioDecode; count: number;
  completion: Promise<DecodeResult>; manifest: Manifest | null; published: boolean; releasing: boolean;
  reserve: number; frames: number; baseFrame: number; durationMs: number; sampleRate: 44100 | 48000 };
export type NativeAudioLease = { path: string; sampleRate: 44100 | 48000; baseMs: number; streaming: boolean;
  frames: number; durationMs: number; completion: Promise<DecodeResult>; release: () => Promise<void> };

/** Original audio is fingerprinted before output. A private growing PCM file
 * starts playback after a two-second prefill, independently of total duration.
 * Only fully decoded, validated files become reusable cache entries. */
export class NativeAudioCache {
  private readonly leases = new Map<string, number>();
  // Exactly the current and next source may decode concurrently. Leases pin
  // their files; preparation must never cancel the currently playing decoder.
  private readonly active = new Map<string, Active>();
  private busy = false;
  constructor(private readonly directory: string, private readonly ffmpeg: string,
    private readonly budgetBytes = 8 * 1024 ** 3, private readonly maxEntries = 256,
    private readonly measured: (phase: string, elapsedMs: number) => void = () => undefined) {}

  async prepare(input: z.input<typeof requestSchema>, signal: AbortSignal): Promise<NativeAudioLease> {
    const request = requestSchema.parse(input); signal.throwIfAborted();
    if (this.busy) throw new Error('音频准备任务尚未结束，不能叠加解码任务');
    this.busy = true;
    let measuredAt = performance.now();
    const measured = (phase: string): void => { const now = performance.now(); this.measured(phase, now - measuredAt); measuredAt = now; };
    try {
      await mkdir(this.directory, { recursive: true });
      const initial = await stat(request.sourcePath);
      if (await digest(request.sourcePath, signal) !== request.sourceSha256) throw new Error('音频原文件与工程指纹不一致，请重新导入');
      measured('音源完整性校验');
      // Retain source coordinates even when decoding begins near a cold seek.
      const baseFrame = Math.floor(request.positionMs / 1000) * request.sampleRate;
      const key = `${request.sourceSha256}-${request.sampleRate}-${baseFrame}`;
      const path = join(this.directory, `${key}.pcm`), metadata = join(this.directory, `${key}.json`);
      const existing = this.active.get(key);
      if (existing) {
        if (existing.releasing) throw new Error('该音源正在释放，请在清理完成后明确重新准备');
        if (existing.durationMs !== request.expectedDurationMs) throw new Error('同一音源的节目时长声明不一致');
        const neededFrames = Math.min(existing.frames, Math.ceil(request.positionMs * request.sampleRate / 1000) - baseFrame + request.sampleRate * 2);
        await existing.decoder.readyThrough(neededFrames * 4, signal); signal.throwIfAborted();
        // A release can run while disk prefill awaits. Do not resurrect it.
        if (existing.releasing || this.active.get(key) !== existing) throw new Error('音源预填充期间租约已释放');
        existing.count++; this.leases.set(key, existing.count);
        return this.activeLease(existing);
      }
      let manifest: Manifest | null = null;
      try { manifest = manifestSchema.parse(JSON.parse(await readFile(metadata, 'utf8'))); }
      catch (error) { if (!isMissing(error)) throw new Error('音频解码缓存元数据损坏，原文件未修改', { cause: error }); }
      if (manifest) {
        if (manifest.key !== key || manifest.sourceSha256 !== request.sourceSha256 || manifest.sampleRate !== request.sampleRate
          || manifest.baseFrame !== baseFrame || manifest.bytes !== manifest.frames * 4 || (await stat(path)).size !== manifest.bytes
          || await digest(path, signal) !== manifest.pcmSha256) throw new Error('音频解码缓存校验失败，不能使用损坏的 PCM');
        signal.throwIfAborted(); await writeFileAtomically(metadata, JSON.stringify({ ...manifest, lastUsed: Date.now() }));
        return this.cachedLease(key, path, manifest);
      }
      if (this.active.size >= 2) throw new Error('当前与下一音源已占用解码槽，不能增加后台解码任务');
      const frames = Math.ceil(request.expectedDurationMs * request.sampleRate / 1000) - baseFrame;
      const reserve = frames * 4 + request.sampleRate * 4;
      await this.makeRoom(reserve);
      const free = await statfs(this.directory);
      if (free.bavail * free.bsize < reserve + 256 * 1024 ** 2) throw new Error('磁盘空间不足以准备音频，保留至少 256MB 余量后重试');
      signal.throwIfAborted();
      const temporary = join(this.directory, `${key}.${randomUUID()}.partial`);
      const decoder = new NativeAudioDecode({ executable: this.ffmpeg, source: request.sourcePath, output: temporary,
        rate: request.sampleRate, baseMs: baseFrame * 1000 / request.sampleRate, maximumBytes: reserve });
      measured('磁盘预算与启动解码');
      const active: Active = { key, path: temporary, cachedPath: path, metadata, decoder, count: 1,
        completion: Promise.resolve({ ok: true }), manifest: null, published: false, releasing: false,
        reserve, frames, baseFrame, durationMs: request.expectedDurationMs, sampleRate: request.sampleRate };
      this.active.set(key, active); this.leases.set(key, 1);
      active.completion = this.validateDecode(active, request, initial, baseFrame, frames, reserve);
      try {
        const neededFrames = Math.min(frames, Math.ceil(request.positionMs * request.sampleRate / 1000) - baseFrame + request.sampleRate * 2);
        await decoder.readyThrough(neededFrames * 4, signal); signal.throwIfAborted();
        measured('解码预填充');
      } catch (error) { await this.releaseActive(active); throw error; }
      return this.activeLease(active);
    } finally { this.busy = false; }
  }

  private async validateDecode(active: Active, request: z.output<typeof requestSchema>, initial: Awaited<ReturnType<typeof stat>>,
    baseFrame: number, expectedFrames: number, reserve: number): Promise<DecodeResult> {
    const decoded = await active.decoder.finished; if (!decoded.ok) return decoded;
    try {
      const source = await stat(request.sourcePath), pcm = await stat(active.path);
      if (initial.size !== source.size || initial.mtimeMs !== source.mtimeMs || initial.ino !== source.ino) throw new Error('解码时音频源发生变化，不能使用此次结果');
      if (!pcm.size || pcm.size % 4 || pcm.size > reserve || pcm.size / 4 + request.sampleRate / 1000 < expectedFrames) throw new Error('实际解码音频长度与工程不符');
      active.manifest = { version: 2, key: active.key, sourceSha256: request.sourceSha256, baseFrame,
        pcmSha256: await digest(active.path, new AbortController().signal), frames: pcm.size / 4, sampleRate: request.sampleRate, bytes: pcm.size, lastUsed: Date.now() };
      const handle = await open(active.path, 'r+'); try { await handle.sync(); } finally { await handle.close(); }
      return { ok: true };
    } catch (error) { return { ok: false, error: error instanceof Error ? error : new Error(String(error)) }; }
  }

  private async releaseActive(active: Active): Promise<void> {
    if (active.count <= 0) return;
    if (active.count > 1) { active.count--; this.leases.set(active.key, active.count); return; }
    active.releasing = true;
    // Keep ownership until the child really exits. A refused cancellation leaves
    // the active job registered and prevents another decoder from starting.
    await active.decoder.cancel();
    const result = await active.completion;
    if (result.ok && active.manifest) {
      await rename(active.path, active.cachedPath);
      await writeFileAtomically(active.metadata, JSON.stringify(active.manifest)); active.published = true;
    } else if (active.decoder.wasCancelled) {
      try { await unlink(active.path); } catch (error) { if (!isMissing(error)) throw error; }
    }
    active.count = 0; this.leases.delete(active.key); this.active.delete(active.key);
  }

  private activeLease(active: Active): NativeAudioLease {
    return { get path() { return active.published ? active.cachedPath : active.path; }, sampleRate: active.sampleRate,
      streaming: true, baseMs: active.baseFrame * 1000 / active.sampleRate, frames: active.frames, durationMs: active.durationMs,
      completion: active.completion, release: this.onceRelease(() => this.releaseActive(active)) };
  }

  private cachedLease(key: string, path: string, manifest: Manifest): NativeAudioLease {
    this.leases.set(key, (this.leases.get(key) ?? 0) + 1);
    return { path, sampleRate: manifest.sampleRate, baseMs: manifest.baseFrame * 1000 / manifest.sampleRate, streaming: false,
      frames: manifest.frames, durationMs: (manifest.baseFrame + manifest.frames) * 1000 / manifest.sampleRate,
      completion: Promise.resolve({ ok: true }), release: this.onceRelease(() => {
        const count = (this.leases.get(key) ?? 1) - 1; if (count) this.leases.set(key, count); else this.leases.delete(key); return Promise.resolve();
      }) };
  }

  private onceRelease(release: () => Promise<void>): () => Promise<void> {
    let operation: Promise<void> | null = null;
    return () => { operation ??= release(); return operation; };
  }

  private async makeRoom(bytes: number): Promise<void> {
    if (bytes > this.budgetBytes) throw new Error('本次音频超过解码缓存预算，请增加缓存预算；原素材未修改');
    const entries: Manifest[] = []; let used = 0;
    for (const name of await readdir(this.directory)) {
      if (/^[a-f0-9]{64}-(44100|48000)-\d+(\.pcm|\.[a-f0-9-]+\.partial)$/.test(name)) used += (await stat(join(this.directory, name))).size;
      if (!/^[a-f0-9]{64}-(44100|48000)-\d+\.json$/.test(name)) continue;
      if ((await stat(join(this.directory, name))).size > 16384) throw new Error('音频缓存元数据超过容量');
      const entry = manifestSchema.parse(JSON.parse(await readFile(join(this.directory, name), 'utf8')));
      if (`${entry.key}.json` !== name) throw new Error('音频缓存身份不一致'); entries.push(entry);
    }
    // Reserve the whole bounded decode, not only the bytes produced so far.
    // Otherwise two growing files could each pass the same disk/cache budget.
    for (const active of this.active.values()) used += Math.max(0, active.reserve - (await stat(active.path)).size);
    let count = entries.length + this.active.size;
    for (const entry of entries.sort((a, b) => a.lastUsed - b.lastUsed)) {
      if (used + bytes <= this.budgetBytes && count < this.maxEntries) break;
      if (this.leases.has(entry.key)) continue;
      await unlink(join(this.directory, `${entry.key}.pcm`)); await unlink(join(this.directory, `${entry.key}.json`)); used -= entry.bytes; count--;
    }
    if (used + bytes > this.budgetBytes || count >= this.maxEntries) throw new Error('正在播放或准备的音频占满缓存，不能淘汰活动资源');
  }
}

async function digest(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted(); const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { signal, highWaterMark: 64 * 1024 })) {
    if (!Buffer.isBuffer(chunk)) throw new Error('音频读取返回了无效数据'); hash.update(chunk);
  }
  return hash.digest('hex');
}
function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
