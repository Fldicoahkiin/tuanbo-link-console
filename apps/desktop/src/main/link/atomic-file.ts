import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeFileAtomically(filePath: string, content: string | Uint8Array): Promise<void> {
  const parentDirectory = dirname(filePath);
  await mkdir(parentDirectory, { recursive: true });
  const temporaryPath = join(parentDirectory, `.${crypto.randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { flag: 'wx' });

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    throw new Error(`原子替换失败，原文件保持不变；临时文件：${temporaryPath}`, { cause: error });
  }
}
