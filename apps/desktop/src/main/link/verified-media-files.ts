import { stat } from 'node:fs/promises';

/** Reuse a digest only while the file identity and nanosecond metadata match. */
export class VerifiedMediaFiles {
  private readonly verified = new Map<string, { signature: string; digest: string; bytes: number }>();
  private bytes = 0;

  constructor(private readonly hashFile: (path: string) => Promise<string>,
    private readonly maximumEntries = 8192, private readonly maximumBytes = 4 * 1024 * 1024) {}

  async verify(path: string, expected: string): Promise<boolean> {
    return await this.digest(path) === expected;
  }

  async digest(path: string): Promise<string> {
    const before = await signature(path);
    const cached = this.verified.get(path);
    if (cached?.signature === before) {
      this.verified.delete(path); this.verified.set(path, cached);
      return cached.digest;
    }
    if (cached) { this.bytes -= cached.bytes; this.verified.delete(path); }
    const digest = await this.hashFile(path);
    if (before !== await signature(path)) throw new Error('素材在完整性校验期间发生变化，请停止修改后重新导入');
    const bytes = (path.length + before.length + digest.length) * 2 + 64;
    if (bytes > this.maximumBytes || this.maximumEntries < 1) return digest;
    const concurrent = this.verified.get(path);
    if (concurrent) { this.bytes -= concurrent.bytes; this.verified.delete(path); }
    while (this.verified.size >= this.maximumEntries || this.bytes + bytes > this.maximumBytes) {
      const oldest = this.verified.keys().next().value;
      if (oldest === undefined) break;
      this.bytes -= this.verified.get(oldest)!.bytes; this.verified.delete(oldest);
    }
    this.verified.set(path, { signature: before, digest, bytes }); this.bytes += bytes;
    return digest;
  }
}

async function signature(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  if (!value.isFile()) throw new Error('素材路径不是文件');
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
}
