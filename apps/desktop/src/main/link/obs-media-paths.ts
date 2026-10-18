import { dirname, join, win32 } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hashFile } from './link-project-service';
import { VerifiedMediaFiles } from './verified-media-files';

const verified = new VerifiedMediaFiles(hashFile);

/** All cache generations belonging to this exact project and source digest.
 * Editor preview and formal playback must agree on input ownership. */
export function obsMediaCachePaths(projectPath: string, sha256: string): string[] {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('素材 SHA-256 无效');
  return ['.mkv', '.rgba.mkv', '.source-pixels.mkv', '.seek-ready.mkv', '.seek-intra.mkv']
    .map(extension => join(dirname(projectPath), 'cache', 'obs-seek-jpeg2000', `${sha256}${extension}`));
}

export function sameObsMediaPath(left: string, right: string): boolean {
  const identity = (path: string): string => win32.isAbsolute(path) ? win32.normalize(path).toLowerCase() : path;
  return identity(left) === identity(right);
}

export function includesObsMediaPath(paths: readonly string[], path: string): boolean {
  return paths.some(candidate => sameObsMediaPath(candidate, path));
}

/** A copied/moved project retains its scene identity. Rebind only when file
 * contents prove the old input belongs to the same asset. A cache is named by
 * the asset digest and checked against its own sidecar; a regenerated cache is
 * never byte-identical (Matroska writes a random segment UID), so the old and
 * new cache digests are not compared. */
export async function verifyRelocatedObsMediaPath(existing: string, source: string, sha256: string, caches: readonly string[]): Promise<boolean> {
  try {
    if (win32.basename(existing).toLowerCase() === win32.basename(source).toLowerCase()) {
      return await verified.verify(source, sha256) && await verified.verify(existing, sha256);
    }
    const cache = caches.find(candidate => win32.basename(candidate).toLowerCase() === win32.basename(existing).toLowerCase());
    if (!cache || win32.basename(win32.dirname(existing)).toLowerCase() !== 'obs-seek-jpeg2000'
      || win32.basename(win32.dirname(win32.dirname(existing))).toLowerCase() !== 'cache') return false;
    const previous = (await readFile(`${existing}.sha256`, 'utf8')).trim();
    if (!/^[a-f0-9]{64}$/.test(previous)) return false;
    return await verified.verify(source, sha256) && await verified.verify(existing, previous);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
