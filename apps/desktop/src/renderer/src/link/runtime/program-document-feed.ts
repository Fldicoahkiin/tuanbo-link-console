import { projectItemsChange, toUserErrorMessage } from '@tb/core/link';
import type { LinkProject, NativeProgramDocument, NativeProgramDocumentAnswer, NativeProgramDocumentVersion, NativeProgramItemsChange } from '@tb/schema';

/** The window's project as the program is sent it: the document store's project, its path, and which version it is. */
export type ProgramDocument = { project: LinkProject; path: string; sessionId: string; revision: number };

/** The same version of the same file: nothing new for the program. */
export function sameProgramDocument(a: Pick<ProgramDocument, 'path' | 'sessionId' | 'revision'>, b: Pick<ProgramDocument, 'path' | 'sessionId' | 'revision'>): boolean {
  return a.path === b.path && a.sessionId === b.sessionId && a.revision === b.revision;
}
/** One key per version, as the program names the version it plays (NativeProgramEvent.documentVersion). */
export function programVersionKey(version: NativeProgramDocumentVersion): string { return `${version.sessionId}:${version.revision}`; }

/** How many of the versions sent last are kept besides the one the program plays: only what a held song's marks and the
 * version the program takes next can name. */
const KEPT_VERSIONS = 4;

/**
 * The version stream of one window's page (0.5.9 S7, S9; design 02 §3.3, §3.7): every newer version of the project goes
 * to the program it opened, one at a time. A version is sent as what changed since the one sent before it (the songs
 * that are not the same objects, the songs gone, the order, the project's own fields: the document store keeps every
 * branch an edit did not touch), on that version as `base`. The program puts it only on the version it has; on any
 * other it answers `resync`, and the whole document goes once; still refused, it is said in red and not sent again.
 * The whole document also goes for a new file or session, for a version whose send failed and after many songs
 * changed; it is encoded by its own worker (`encode`), never on this thread and never in the queue of saving.
 *
 * While one is on its way, newer edits wait; when it is answered the newest is sent, so a drag sends a few versions,
 * not one per frame. `flush` sends the newest at once, also with one on its way, on the version on its way as `base`
 * (the program takes them in order, and answers `resync` if that one did not reach it): a song started right after an
 * edit plays that edit (the control goes after it, in order). Only the answer to the newest send counts: an older one
 * is decided by it. A version the program could not take is said once in red and logged (`failed`), not sent again by
 * itself; the next edit, or the next control that may start a song, sends the newest.
 *
 * Only this page writes the project file; this sends nothing to disk. It also remembers the projects it sent, so the
 * window can show what a held song plays (`project`).
 */
export class ProgramDocumentFeed {
  /** The version the program has, or was sent last; null while the page has no open program. */
  private sent: ProgramDocument | null = null;
  /** The newest send on its way, until it is answered. */
  private inFlight: object | null = null;
  /** The last send failed: the program may not have `sent`. Only the next control that may start a song sends it again
   * (`flush`, the operator's own action), whole; nothing sends it again by itself. */
  private unsent = false;
  /** Answers to a send made before the program was opened again are not this program's. */
  private epoch = 0;
  /** Versions leave in the order they were made: one waits for the one before it to be encoded and handed over. */
  private issuing: Promise<void> = Promise.resolve();
  /** The projects sent, oldest first; `onAir` is the version the program was last seen playing, kept however many
   * newer ones follow while a song is held. */
  private readonly versions = new Map<string, LinkProject>();
  private onAir: string | null = null;

  constructor(private readonly ownerId: string, private readonly read: () => ProgramDocument | null,
    private readonly send: (request: NativeProgramDocument) => Promise<NativeProgramDocumentAnswer>,
    private readonly failed: (message: string) => void,
    /** The whole project as the program reads it, encoded off this thread. */
    private readonly encode: (project: LinkProject) => Promise<string>) {}

  /** The program opened with `document`: from now on it gets every newer version. */
  attached(document: ProgramDocument): void {
    this.epoch += 1; this.inFlight = null; this.unsent = false; this.sent = document;
    this.remember(document);
    this.changed();
  }
  /** The program is opening again, closed or gone: nothing is sent until it is attached. */
  detached(): void { this.epoch += 1; this.inFlight = null; this.unsent = false; this.sent = null; }
  /** The window's project changed. */
  changed(): void { if (!this.inFlight) void this.push(); }
  /** The newest version goes now, before a control that starts a song (0.5.9 S7); also a version whose send failed.
   * Settles once it and every version before it were handed to the program, never rejected. */
  flush(): Promise<void> { return this.push(false, true); }
  /** The project of the version `key` (programVersionKey), if this page sent it; null when another page did (a
   * program taken over after a reload) or it is long past. Asked with the version the program plays, it forgets older
   * ones. */
  project(key: string): LinkProject | null {
    const project = this.versions.get(key);
    if (!project) return null;
    this.onAir = key;
    for (const kept of [...this.versions.keys()]) { if (kept === key) break; this.versions.delete(kept); }
    return project;
  }

  private push(resync = false, again = false): Promise<void> {
    const previous = this.sent, document = previous ? this.read() : null;
    if (!document || !previous || (!resync && !(again && this.unsent) && sameProgramDocument(document, previous))) return this.issuing;
    const whole = resync || this.unsent || previous.sessionId !== document.sessionId || previous.path !== document.path;
    const epoch = this.epoch, token = {};
    this.inFlight = token; this.unsent = false; this.sent = document; this.remember(document);
    let change: NativeProgramItemsChange | null;
    try {
      change = whole ? null : projectItemsChange(previous.project, document.project);
    } catch (error) { this.notSent(epoch, token, error); return this.issuing; }
    const base = change ? previous.revision : null;
    this.issuing = this.issuing.then(() => this.issue(epoch, token, document, base, change, resync));
    return this.issuing;
  }
  /** Encodes `document` if it goes whole and hands it to the program. Never rejected. */
  private async issue(epoch: number, token: object, document: ProgramDocument, base: number | null,
    increment: NativeProgramItemsChange | null, resync: boolean): Promise<void> {
    if (epoch !== this.epoch) return;
    let request: NativeProgramDocument;
    try {
      const change: NativeProgramDocument['change'] = increment ?? { kind: 'full', document: await this.encode(document.project) };
      request = { version: 1, ownerId: this.ownerId, key: { sessionId: document.sessionId, projectId: document.project.projectId, projectPath: document.path },
        revision: document.revision, base, change };
    } catch (error) { this.notSent(epoch, token, error); return; }
    if (epoch !== this.epoch) return;
    let answered: Promise<NativeProgramDocumentAnswer>;
    try { answered = this.send(request); } catch (error) { this.notSent(epoch, token, error); return; }
    void answered.then(answer => {
      if (epoch !== this.epoch || this.inFlight !== token) return;
      this.inFlight = null;
      if (answer.kind === 'resync') {
        // The whole document was refused as well: said once, not sent again by itself.
        if (resync) { this.unsent = true; this.failed(`这次修改没送进节目：${answer.reason}`); return; }
        void this.push(true); return;
      }
      this.changed();
    }, (error: unknown) => { this.notSent(epoch, token, error); });
  }
  /** The send `token` failed. Said once; the next edit sends the newest version, nothing is sent again by itself. A
   * newer version sent since decides by its own answer. */
  private notSent(epoch: number, token: object, error: unknown): void {
    if (epoch !== this.epoch || this.inFlight !== token) return;
    this.inFlight = null; this.unsent = true; this.failed(`这次修改没送进节目：${toUserErrorMessage(error)}`);
  }
  private remember(document: ProgramDocument): void {
    const key = programVersionKey(document);
    this.versions.delete(key); this.versions.set(key, document.project);
    for (const kept of [...this.versions.keys()]) {
      if (this.versions.size <= KEPT_VERSIONS + 1) break;
      if (kept !== this.onAir) this.versions.delete(kept);
    }
  }
}
