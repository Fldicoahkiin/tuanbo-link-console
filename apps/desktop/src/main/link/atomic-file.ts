import { mkdir, rename, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function writeFileAtomically(filePath: string, content: string | Uint8Array): Promise<void> {
  const parentDirectory = dirname(filePath);
  await mkdir(parentDirectory, { recursive: true });
  const temporaryPath = join(parentDirectory, `.${crypto.randomUUID()}.tmp`);
  const file = await open(temporaryPath, 'wx');
  try { await file.writeFile(content); await file.sync(); }
  finally { await file.close(); }

  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`原子替换失败，原文件保持不变；${detail}；临时文件：${temporaryPath}`, { cause: error });
  }
}
