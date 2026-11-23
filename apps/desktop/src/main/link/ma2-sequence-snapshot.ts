import { createHash } from 'node:crypto';
import { isUtf8 } from 'node:buffer';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { MA2_GZIP_PREFIX, MA2_MAX_SEQUENCE_BYTES, MA2_PLAIN_SEQUENCE_BYTES, packedMa2SequenceHeader, packedProjectSequences, type LinkProject } from '@tb/schema';

const compress = promisify(gzip);
const decompress = promisify(gunzip);
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Only confirmed native XML belongs here. Old projects and small bindings retain their original representation. */
export async function storeMa2Sequence(xml: string): Promise<string> {
  const size = Buffer.byteLength(xml);
  if (size <= MA2_PLAIN_SEQUENCE_BYTES) return xml;
  if (size > MA2_MAX_SEQUENCE_BYTES) throw new Error('单条灯光序列超过 256 MiB，无法完整保存');
  const bytes = Buffer.from(xml);
  const packed = await compress(bytes, { level: 1 });
  return `${MA2_GZIP_PREFIX}${size}:${digest(bytes)}:${packed.toString('base64')}`;
}

async function checkedBytes(snapshot: string): Promise<Buffer> {
  const header = packedMa2SequenceHeader(snapshot);
  if (!header) throw new Error('工程中的压缩灯光数据格式无效');
  const base64 = snapshot.slice(header.offset);
  const packed = Buffer.from(base64, 'base64');
  if (packed.toString('base64') !== base64) throw new Error('工程中的压缩灯光数据不完整');
  let bytes: Buffer;
  try { bytes = await decompress(packed, { maxOutputLength: header.bytes }); }
  catch (cause) { throw new Error('工程中的灯光数据解压失败，请检查工程备份', { cause }); }
  if (bytes.length !== header.bytes || digest(bytes) !== header.sha256) throw new Error('工程中的灯光数据校验失败，请检查工程备份');
  if (!isUtf8(bytes)) throw new Error('工程中的灯光数据文字编码无效，请检查工程备份');
  return bytes;
}

export async function loadMa2Sequence(snapshot: string): Promise<string> {
  if (!snapshot.startsWith(MA2_GZIP_PREFIX)) return snapshot;
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await checkedBytes(snapshot));
}

/** Verify once per distinct snapshot in this document before accepting a file or replacing the last good copy. */
export async function verifyProjectSequences(project: LinkProject): Promise<void> {
  for (const snapshot of new Set(packedProjectSequences(project))) await checkedBytes(snapshot);
}
