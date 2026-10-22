import { createHash } from 'node:crypto';
import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { recoveryCopyDiscardSchema, recoveryCopyWriteSchema, type RecoveryCopyDiscard, type RecoveryCopyWrite } from '@tb/schema';
import { writeFileAtomically } from './atomic-file';

const manifestSchema = z.object({ version: z.literal(1), projectPath: z.string().min(1).nullable(), projectId: z.string().min(1),
  name: z.string(), sessionId: z.uuid(), revision: z.number().int().nonnegative(), savedAt: z.iso.datetime() }).strict();
export type RecoveryCopyManifest = z.infer<typeof manifestSchema>;
export type RecoveryCopyOwner = { projectPath: string | null; projectId: string };
export type RecoveryCopy = { manifest: RecoveryCopyManifest; copyPath: string };

const isMissing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

/**
 * Unsaved edits of each document, one copy per project file (or per unnamed project).
 * Copies live in the program's data folder and never replace the project file;
 * a save or an explicit discard removes them.
 */
export class RecoveryCopies {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private readonly directory: string,
    private readonly documents: { writeCopy(path: string, content: string): Promise<void> },
    private readonly now: () => Date = () => new Date()
  ) {}

  write(input: RecoveryCopyWrite): Promise<void> {
    const request = recoveryCopyWriteSchema.parse(input);
    const id = copyId(request);
    return this.serialize(id, async () => {
      // The copy is complete on disk before its record points at the new revision.
      await this.documents.writeCopy(this.copyPath(id), request.content);
      const manifest: RecoveryCopyManifest = { version: 1, projectPath: request.projectPath, projectId: request.projectId, name: request.name,
        sessionId: request.sessionId, revision: request.revision, savedAt: this.now().toISOString() };
      await writeFileAtomically(this.manifestPath(id), JSON.stringify(manifest));
    });
  }

  /** Removes the owner's copy. With `keep`, a copy that session wrote after that revision stays. */
  discard(input: RecoveryCopyDiscard): Promise<boolean> {
    const request = recoveryCopyDiscardSchema.parse(input);
    const id = copyId(request);
    return this.serialize(id, async () => {
      const manifest = await this.readManifest(id);
      if (!manifest) return false;
      if (request.keep && manifest.sessionId === request.keep.sessionId && manifest.revision > request.keep.revision) return false;
      // The record goes first: a copy file without a record is never offered.
      await unlink(this.manifestPath(id));
      await unlink(this.copyPath(id)).catch((error: unknown) => { if (!isMissing(error)) throw error; });
      return true;
    });
  }

  find(owner: RecoveryCopyOwner): Promise<RecoveryCopy | null> {
    const id = copyId(owner);
    return this.serialize(id, () => this.load(id));
  }

  /** The most recently written copy of an unnamed project. */
  async latestUnnamed(): Promise<RecoveryCopy | null> {
    let names: string[];
    try { names = await readdir(this.directory); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    const copies: RecoveryCopy[] = [];
    for (const name of names.filter(value => value.endsWith('.json'))) {
      const copy = await this.serialize(name.slice(0, -5), () => this.load(name.slice(0, -5)));
      if (copy && copy.manifest.projectPath === null) copies.push(copy);
    }
    return copies.sort((a, b) => b.manifest.savedAt.localeCompare(a.manifest.savedAt))[0] ?? null;
  }

  private async load(id: string): Promise<RecoveryCopy | null> {
    const manifest = await this.readManifest(id);
    if (!manifest) return null;
    const copyPath = this.copyPath(id);
    // A record whose copy file was moved away has nothing left to restore.
    try { await stat(copyPath); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    return { manifest, copyPath };
  }

  private async readManifest(id: string): Promise<RecoveryCopyManifest | null> {
    const path = this.manifestPath(id);
    let text: string;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if (isMissing(error)) return null; throw error; }
    try { return manifestSchema.parse(JSON.parse(text)); }
    catch (error) { throw new Error(`恢复副本记录无法读取：${path}`, { cause: error }); }
  }

  private serialize<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const result = (this.queues.get(id) ?? Promise.resolve()).then(operation);
    // Callers own the errors; the settled tail only orders the next operation.
    const tail = result.then(() => undefined, () => undefined);
    this.queues.set(id, tail);
    void tail.then(() => { if (this.queues.get(id) === tail) this.queues.delete(id); });
    return result;
  }

  private copyPath(id: string): string { return join(this.directory, `${id}.tblink`); }
  private manifestPath(id: string): string { return join(this.directory, `${id}.json`); }
}

function copyId(owner: RecoveryCopyOwner): string {
  const key = owner.projectPath === null ? `unnamed:${owner.projectId}` : `file:${normalizePath(owner.projectPath)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function normalizePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}
