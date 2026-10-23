import { createHash, createPublicKey, verify } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { z } from 'zod';

/** What the release key signed for one installer; scripts/sign-release.mjs writes it into latest.yml. */
export type SignedRelease = {
  version: string;
  releaseDate: string;
  file: string;
  size: number;
  sha512: string;
};

const envelopeSchema = z.object({ kid: z.string().min(1), payload: z.string().min(1), signature: z.string().min(1) }).strict();
const payloadSchema = z.object({
  schemaVersion: z.literal(1),
  product: z.literal('tuanbo-link-console'),
  channel: z.literal('release'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  releaseDate: z.iso.datetime(),
  file: z.string().min(1),
  size: z.number().int().positive(),
  sha512: z.string().min(1)
}).strict();
const updateInfoSchema = z.looseObject({
  version: z.string(),
  path: z.string(),
  sha512: z.string(),
  files: z.array(z.looseObject({ url: z.string(), sha512: z.string(), size: z.number().optional() })),
  tblinkRelease: z.unknown().optional()
});

/** The release key's signature over latest.yml's installer, checked against latest.yml itself. A server that
 * serves a forged latest.yml cannot produce this signature, so it cannot point clients at another installer. */
export function verifySignedRelease(info: unknown, keys: Readonly<Record<string, string>>): SignedRelease {
  const update = updateInfoSchema.parse(info);
  if (update.tblinkRelease === undefined) throw new Error('更新信息没有发布签名');
  const envelope = envelopeSchema.parse(update.tblinkRelease);
  const key = keys[envelope.kid];
  if (!key) throw new Error(`发布签名使用了本版本不认识的密钥 ${envelope.kid}`);
  const payload = Buffer.from(envelope.payload, 'base64url');
  if (!verify(null, payload, createPublicKey(key), Buffer.from(envelope.signature, 'base64url'))) throw new Error('发布签名无效');
  const signed = payloadSchema.parse(JSON.parse(payload.toString('utf8')));
  const [file] = update.files;
  if (signed.version !== update.version) throw new Error(`签名版本 ${signed.version} 与更新信息版本 ${update.version} 不一致`);
  if (update.files.length !== 1 || !file || signed.file !== update.path || signed.file !== file.url) throw new Error('签名中的安装包与更新信息不一致');
  if (signed.sha512 !== update.sha512 || signed.sha512 !== file.sha512 || signed.size !== file.size) throw new Error('签名中的安装包摘要或大小与更新信息不一致');
  return { version: signed.version, releaseDate: signed.releaseDate, file: signed.file, size: signed.size, sha512: signed.sha512 };
}

/** Base64 SHA-512 of a file, the form electron-builder writes into latest.yml. */
export async function fileSha512(path: string): Promise<{ sha512: string; size: number }> {
  const hash = createHash('sha512');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    const bytes = chunk as Buffer;
    hash.update(bytes);
    size += bytes.length;
  }
  return { sha512: hash.digest('base64'), size };
}
