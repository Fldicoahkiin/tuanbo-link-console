import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fileSha512, verifySignedRelease } from './release-signature';

const installer = Buffer.from('installer bytes');
const sha512 = createHash('sha512').update(installer).digest('base64');
const file = 'Tuanbo-Link-Console-0.5.0-x64.exe';

function keyPair(): { publicKey: string; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'] } {
  const keys = generateKeyPairSync('ed25519');
  return { publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey: keys.privateKey };
}

function signedInfo(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], payloadOverrides: Record<string, unknown> = {}, kid = 'release-test-a'): Record<string, unknown> {
  const payload = Buffer.from(JSON.stringify({ schemaVersion: 1, product: 'tuanbo-link-console', channel: 'release', version: '0.5.0',
    releaseDate: '2026-11-02T03:04:05.678Z', file, size: installer.length, sha512, ...payloadOverrides }));
  return {
    version: '0.5.0', path: file, sha512, releaseDate: '2026-11-02T03:04:05.678Z',
    files: [{ url: file, sha512, size: installer.length }],
    tblinkRelease: { kid, payload: payload.toString('base64url'), signature: sign(null, payload, privateKey).toString('base64url') }
  };
}

describe('verifySignedRelease', () => {
  const active = keyPair();
  const keys = { 'release-test-a': active.publicKey };

  it('accepts a release signed by a known key that matches latest.yml', () => {
    expect(verifySignedRelease(signedInfo(active.privateKey), keys)).toEqual({ version: '0.5.0', releaseDate: '2026-11-02T03:04:05.678Z', file, size: installer.length, sha512 });
  });

  it('accepts a second embedded key, so the release key can rotate', () => {
    const next = keyPair();
    expect(verifySignedRelease(signedInfo(next.privateKey, {}, 'release-test-b'), { ...keys, 'release-test-b': next.publicKey }).version).toBe('0.5.0');
  });

  it('refuses a missing signature, an unknown key and a signature by another key', () => {
    const unsigned = signedInfo(active.privateKey);
    delete unsigned.tblinkRelease;
    expect(() => verifySignedRelease(unsigned, keys)).toThrow('没有发布签名');
    expect(() => verifySignedRelease(signedInfo(active.privateKey, {}, 'release-test-z'), keys)).toThrow('不认识的密钥 release-test-z');
    const forger = keyPair();
    expect(() => verifySignedRelease(signedInfo(forger.privateKey), keys)).toThrow('发布签名无效');
  });

  it('refuses a latest.yml that points at another installer than the signed one', () => {
    const forged = signedInfo(active.privateKey);
    const other = createHash('sha512').update('forged installer').digest('base64');
    expect(() => verifySignedRelease({ ...forged, sha512: other, files: [{ url: file, sha512: other, size: installer.length }] }, keys)).toThrow('摘要或大小');
    expect(() => verifySignedRelease({ ...forged, version: '0.6.0' }, keys)).toThrow('签名版本 0.5.0 与更新信息版本 0.6.0 不一致');
    expect(() => verifySignedRelease({ ...forged, path: 'other.exe', files: [{ url: 'other.exe', sha512, size: installer.length }] }, keys)).toThrow('安装包与更新信息不一致');
  });

  it('refuses a payload that was signed but is not a release of this product', () => {
    expect(() => verifySignedRelease(signedInfo(active.privateKey, { channel: 'test' }), keys)).toThrow();
    expect(() => verifySignedRelease(signedInfo(active.privateKey, { product: 'other' }), keys)).toThrow();
  });
});

type SignUpdateMetadata = (text: string, options: { installerName: string; installerBytes: Buffer; privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; kid: string; publicKeys: Record<string, string> }) => string;

describe('release signing scripts and the client agree', () => {
  it('accepts the latest.yml that scripts/sign-release.mjs writes', async () => {
    const scripts = new URL('../../../../../scripts/release-config.mjs', import.meta.url).href;
    const { signUpdateMetadata } = await import(/* @vite-ignore */ scripts) as { signUpdateMetadata: SignUpdateMetadata };
    // electron-updater parses latest.yml with js-yaml, which ships without type declarations.
    const yaml = 'js-yaml';
    const { load } = await import(/* @vite-ignore */ yaml) as { load: (text: string) => unknown };
    const key = keyPair();
    const latest = `version: 0.5.0\nfiles:\n  - url: ${file}\n    sha512: ${sha512}\n    size: ${installer.length}\npath: ${file}\nsha512: ${sha512}\nreleaseDate: '2026-11-02T03:04:05.678Z'\n`;
    const signed = signUpdateMetadata(latest, { installerName: file, installerBytes: installer, privateKey: key.privateKey, kid: 'release-2026-10-a', publicKeys: { 'release-2026-10-a': key.publicKey } });
    expect(verifySignedRelease(load(signed), { 'release-2026-10-a': key.publicKey })).toEqual({ version: '0.5.0', releaseDate: '2026-11-02T03:04:05.678Z', file, size: installer.length, sha512 });
  });
});

describe('fileSha512', () => {
  it('hashes a file the way latest.yml states it', async () => {
    const path = join(await mkdtemp(join(tmpdir(), 'tblink-sha512-')), file);
    await writeFile(path, installer);
    await expect(fileSha512(path)).resolves.toEqual({ sha512, size: installer.length });
  });
});
