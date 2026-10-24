import { mkdir, rename, open } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

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

/** Streams `chunks` (optionally gzipped) into a temporary file, syncs it, then renames it over `filePath`;
 * memory stays at one chunk however long the content is. */
export async function writeChunksAtomically(filePath: string, chunks: AsyncIterable<string>, options: { gzip?: boolean } = {}): Promise<void> {
  const parentDirectory = dirname(filePath);
  await mkdir(parentDirectory, { recursive: true });
  const temporaryPath = join(parentDirectory, `.${crypto.randomUUID()}.tmp`);
  // flush: the data is synced to disk before the file closes.
  const sink = createWriteStream(temporaryPath, { flags: 'wx', flush: true });
  const source = Readable.from(batched(chunks));
  await (options.gzip ? pipeline(source, createGzip(), sink) : pipeline(source, sink));
  try {
    await rename(temporaryPath, filePath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`原子替换失败，原文件保持不变；${detail}；临时文件：${temporaryPath}`, { cause: error });
  }
}

/** Joins small chunks into pieces of about 64 KB so streaming many short lines stays fast. */
async function* batched(chunks: AsyncIterable<string>): AsyncGenerator<string> {
  let pending = '';
  for await (const chunk of chunks) {
    pending += chunk;
    if (pending.length >= 65_536) { yield pending; pending = ''; }
  }
  if (pending) yield pending;
}
