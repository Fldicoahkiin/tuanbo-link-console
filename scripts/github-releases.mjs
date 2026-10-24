// GitHub releases of this repository through the REST API, for the release workflow: the cloud build drafts the
// release, the builder downloads it, and the builder publishes it once the update feed serves it. The pinned build
// assets live in releases of their own. Needs GITHUB_TOKEN.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const REPOSITORY = 'Fldicoahkiin/tuanbo-link-console';

export async function github(path, { method = 'GET', body, base = 'https://api.github.com', type = 'application/json', timeout = 60_000, allow404 = false } = {}) {
  if (!process.env.GITHUB_TOKEN) throw new Error('需要 GITHUB_TOKEN');
  const response = await fetch(base + path, {
    method, signal: AbortSignal.timeout(timeout),
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(body ? { 'content-type': type } : {}) },
    body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body)
  });
  if (allow404 && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub ${method} ${path} 失败：HTTP ${response.status} ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

/** The one release of a tag, draft or published, or null. Drafts have no tag yet, so they are found by listing. */
export function releaseOf(releases, tag) {
  const matches = releases.filter(release => release.tag_name === tag);
  if (matches.length > 1) throw new Error(`${tag} 有 ${matches.length} 个 release（含草稿），先在 GitHub 上删掉多余的`);
  return matches[0] ?? null;
}

export async function findRelease(tag) {
  return releaseOf(await github(`/repos/${REPOSITORY}/releases?per_page=100`), tag);
}

export async function uploadAsset(release, name, bytes) {
  await github(`/repos/${REPOSITORY}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`,
    { method: 'POST', base: 'https://uploads.github.com', body: bytes, type: 'application/octet-stream', timeout: 60 * 60_000 });
}

/** Streams a release asset into `sink` (a file path or a writable stream) and returns its sha256 and size. The API
 * redirects to the storage host; fetch drops the Authorization header on that cross-origin redirect. */
export async function downloadAsset(asset, sink) {
  if (!process.env.GITHUB_TOKEN) throw new Error('需要 GITHUB_TOKEN');
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`, {
    signal: AbortSignal.timeout(60 * 60_000),
    headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, accept: 'application/octet-stream', 'x-github-api-version': '2022-11-28' }
  });
  if (!response.ok) throw new Error(`下载 ${asset.name} 失败：HTTP ${response.status}`);
  const hash = createHash('sha256');
  let size = 0;
  const count = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); size += chunk.length; done(null, chunk); } });
  await pipeline(Readable.fromWeb(response.body), count, typeof sink === 'string' ? createWriteStream(sink) : sink, { end: typeof sink === 'string' });
  return { sha256: hash.digest('hex'), size };
}
