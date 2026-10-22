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
export type PrunedRecoveryCopy = { reason: 'expired' | 'over-limit'; manifest: RecoveryCopyManifest } | { reason: 'orphan'; file: string };

/** Copies older than this go to the recycle bin at startup. */
const MAX_COPY_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** At most this many copies stay; older ones beyond it go to the recycle bin at startup. */
const MAX_COPIES = 20;
/** A temporary file this old is left from an interrupted write. */
const STALE_TEMPORARY_MS = 60 * 60 * 1000;

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
    return latest((await this.all()).filter(copy => copy.manifest.projectPath === null));
  }

  /**
   * Startup cleanup: copies older than 30 days and all but the newest 20 go to the recycle bin,
   * with copy files that have no record, records without a copy and leftovers of interrupted writes.
   */
  async prune(trash: (path: string) => Promise<void>): Promise<PrunedRecoveryCopy[]> {
    const names = await this.names();
    const pruned: PrunedRecoveryCopy[] = [];
    const now = this.now().getTime();
    const kept: RecoveryCopy[] = [];
    for (const name of names.filter(value => value.endsWith('.json'))) {
      const id = name.slice(0, -5);
      const copy = await this.serialize(id, () => this.load(id));
      if (!copy) {
        await this.serialize(id, () => unlink(this.manifestPath(id)));
        pruned.push({ reason: 'orphan', file: this.manifestPath(id) });
      } else if (now - Date.parse(copy.manifest.savedAt) > MAX_COPY_AGE_MS) {
        await this.remove(copy, trash);
        pruned.push({ reason: 'expired', manifest: copy.manifest });
      } else kept.push(copy);
    }
    for (const copy of kept.sort((a, b) => b.manifest.savedAt.localeCompare(a.manifest.savedAt)).slice(MAX_COPIES)) {
      await this.remove(copy, trash);
      pruned.push({ reason: 'over-limit', manifest: copy.manifest });
    }
    const records = new Set(names.filter(value => value.endsWith('.json')).map(value => value.slice(0, -5)));
    for (const name of names) {
      const path = join(this.directory, name);
      const orphanCopy = name.endsWith('.tblink') && !records.has(name.slice(0, -7));
      const staleTemporary = name.startsWith('.') && name.endsWith('.tmp') && now - (await stat(path)).mtime.getTime() > STALE_TEMPORARY_MS;
      if (!orphanCopy && !staleTemporary) continue;
      await trash(path);
      pruned.push({ reason: 'orphan', file: path });
    }
    return pruned;
  }

  private remove(copy: RecoveryCopy, trash: (path: string) => Promise<void>): Promise<void> {
    const id = copyId(copy.manifest);
    return this.serialize(id, async () => {
      // The record goes first: a copy file without a record is never offered.
      await unlink(this.manifestPath(id));
      await trash(copy.copyPath);
    });
  }

  private async names(): Promise<string[]> {
    try { return await readdir(this.directory); }
    catch (error) { if (isMissing(error)) return []; throw error; }
  }

  private async all(): Promise<RecoveryCopy[]> {
    const copies: RecoveryCopy[] = [];
    for (const name of (await this.names()).filter(value => value.endsWith('.json'))) {
      const copy = await this.serialize(name.slice(0, -5), () => this.load(name.slice(0, -5)));
      if (copy) copies.push(copy);
    }
    return copies;
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

function latest(copies: RecoveryCopy[]): RecoveryCopy | null {
  return copies.sort((a, b) => b.manifest.savedAt.localeCompare(a.manifest.savedAt))[0] ?? null;
}

function copyId(owner: RecoveryCopyOwner): string {
  const key = owner.projectPath === null ? `unnamed:${owner.projectId}` : `file:${normalizePath(owner.projectPath)}`;
  return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

function normalizePath(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export type RecoveryOffer =
  | { kind: 'file'; name: string; copySavedAt: Date; fileModifiedAt: Date }
  | { kind: 'unnamed'; name: string; copySavedAt: Date };

/**
 * Before a project file is shown (or, for `projectPath: null`, at startup),
 * asks whether to restore its recovery copy. Returns the copy's content to
 * restore, or null to use the file. A discarded copy goes to the recycle bin.
 */
export async function offerRecoveryCopy(request: { projectPath: string | null; projectId?: string | undefined }, deps: {
  copies: Pick<RecoveryCopies, 'find' | 'latestUnnamed' | 'discard'>;
  /** Reads a project through the document worker, as normalized JSON. */
  read(path: string): Promise<string>;
  modifiedAt(path: string): Promise<Date>;
  ask(offer: RecoveryOffer): Promise<'restore' | 'discard'>;
  trash(path: string): Promise<void>;
  log(message: string): void;
}): Promise<string | null> {
  let copy: RecoveryCopy | null;
  let offer: RecoveryOffer;
  if (request.projectPath === null) {
    copy = await deps.copies.latestUnnamed();
    if (!copy) return null;
    offer = { kind: 'unnamed', name: copy.manifest.name, copySavedAt: new Date(copy.manifest.savedAt) };
  } else {
    if (!request.projectId) throw new Error('查找恢复副本需要工程身份');
    copy = await deps.copies.find({ projectPath: request.projectPath, projectId: request.projectId });
    if (!copy) return null;
    if (copy.manifest.projectId !== request.projectId) {
      deps.log(`恢复副本不是同一工程，未提示：${request.projectPath}`);
      return null;
    }
    const [copied, saved] = await Promise.all([deps.read(copy.copyPath), deps.read(request.projectPath)]);
    if (copied === saved) {
      await deps.copies.discard({ version: 1, projectPath: request.projectPath, projectId: request.projectId });
      deps.log(`恢复副本与工程文件相同，已清除：${request.projectPath}`);
      return null;
    }
    offer = { kind: 'file', name: copy.manifest.name, copySavedAt: new Date(copy.manifest.savedAt), fileModifiedAt: await deps.modifiedAt(request.projectPath) };
  }
  const owner = { version: 1 as const, projectPath: copy.manifest.projectPath, projectId: copy.manifest.projectId };
  if (await deps.ask(offer) === 'restore') return deps.read(copy.copyPath);
  await deps.trash(copy.copyPath);
  await deps.copies.discard(owner);
  return null;
}
