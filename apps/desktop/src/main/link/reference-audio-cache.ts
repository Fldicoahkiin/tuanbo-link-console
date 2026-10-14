import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { referenceAudioSourceSchema } from '@tb/schema';
import { VerifiedMediaFiles } from './verified-media-files';
import { writeFileAtomically } from './atomic-file';
import type { ImportedReferenceAudio } from './link-project-service';

const entrySchema = z.object({ version: z.literal(1), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  audio: referenceAudioSourceSchema.nullable() }).strict();

/** Only full, untrimmed 48 kHz stereo extraction is reusable. Cache metadata is
 * local to the project; it never replaces the saved audio or its checksum. */
export class ReferenceAudioCache {
  private readonly files: VerifiedMediaFiles;
  private readonly pending = new Map<string, Promise<ImportedReferenceAudio>>();

  constructor(hash: (path: string) => Promise<string>) { this.files = new VerifiedMediaFiles(hash); }

  async ensure(projectPath: string, sourcePath: string, extract: () => Promise<ImportedReferenceAudio>): Promise<ImportedReferenceAudio> {
    const digest = await this.files.digest(sourcePath);
    const directory = dirname(resolve(projectPath));
    const manifest = join(directory, 'cache', 'reference-audio', `${digest}.json`);
    let operation = this.pending.get(manifest);
    if (!operation) {
      operation = this.prepare(directory, manifest, digest, sourcePath, extract).finally(() => this.pending.delete(manifest));
      this.pending.set(manifest, operation);
    }
    const audio = await operation;
    if (!await this.files.verify(sourcePath, digest)) throw new Error('原素材在音轨准备期间发生变化，请重新导入');
    return { ...audio, assetId: crypto.randomUUID() };
  }

  private async prepare(directory: string, manifest: string, digest: string, sourcePath: string,
    extract: () => Promise<ImportedReferenceAudio>): Promise<ImportedReferenceAudio> {
    let content: string | null;
    try { content = await readFile(manifest, 'utf8'); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      content = null;
    }
    if (content !== null) {
      const entry = entrySchema.parse(JSON.parse(content));
      if (entry.sourceSha256 !== digest) throw new Error('原声音轨缓存身份不一致，请检查缓存');
      if (entry.audio === null) throw new Error('素材不包含音频轨道');
      if (!await this.files.verify(join(directory, entry.audio.relativePath), entry.audio.sha256)) {
        throw new Error('原声音轨文件已改变，请恢复原文件后重试');
      }
      return entry.audio;
    }
    let audio: ImportedReferenceAudio;
    try { audio = referenceAudioSourceSchema.parse(await extract()); }
    catch (error) {
      if (error instanceof Error && error.message === '素材不包含音频轨道') {
        if (!await this.files.verify(sourcePath, digest)) throw new Error('原素材在音轨准备期间发生变化，请重新导入');
        await writeFileAtomically(manifest, JSON.stringify(entrySchema.parse({ version: 1, sourceSha256: digest, audio: null })));
      }
      throw error;
    }
    if (!await this.files.verify(sourcePath, digest)) throw new Error('原素材在音轨准备期间发生变化，请重新导入');
    if (!await this.files.verify(join(directory, audio.relativePath), audio.sha256)) throw new Error('提取的原声音轨校验失败');
    await writeFileAtomically(manifest, JSON.stringify(entrySchema.parse({ version: 1, sourceSha256: digest, audio })));
    return audio;
  }
}
