import { stat } from 'node:fs/promises';

/** Reuse a digest only while the file identity and nanosecond metadata match. */
export class VerifiedMediaFiles {
  private readonly verified = new Map<string, { signature: string; digest: string }>();

  constructor(private readonly hashFile: (path: string) => Promise<string>) {}

  async verify(path: string, expected: string): Promise<boolean> {
    const before = await signature(path);
    const cached = this.verified.get(path);
    if (cached?.signature === before) return cached.digest === expected;
    this.verified.delete(path);
    const digest = await this.hashFile(path);
    if (before !== await signature(path)) throw new Error('素材在完整性校验期间发生变化，请停止修改后重新导入');
    if (this.verified.size >= 256) {
      const oldest = this.verified.keys().next().value;
      if (oldest !== undefined) this.verified.delete(oldest);
    }
    this.verified.set(path, { signature: before, digest });
    return digest === expected;
  }
}

async function signature(path: string): Promise<string> {
  const value = await stat(path, { bigint: true });
  if (!value.isFile()) throw new Error('素材路径不是文件');
  return [value.dev, value.ino, value.size, value.mtimeNs, value.ctimeNs].join(':');
}
