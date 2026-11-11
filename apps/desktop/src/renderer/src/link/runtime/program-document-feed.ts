import { toUserErrorMessage } from '@tb/core/link';
import type { LinkProject, NativeProgramDocument, NativeProgramDocumentAnswer, NativeProgramDocumentVersion } from '@tb/schema';

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
 * The version stream of one window's page (0.5.9 S7, design 02 §3.7): every newer version of the project goes to the
 * program it opened, whole, one at a time. While one is on its way, newer edits wait; when it is answered the newest is
 * sent, so a drag sends a few versions, not one per frame. `flush` sends the newest at once, also with one on its way:
 * a song started right after an edit plays that edit (the control goes after it, in order). A version the program could
 * not take is said once in red and logged (`failed`), not sent again by itself; the next edit, or the next control that
 * may start a song, sends the newest. The program
 * answering `resync` gets the whole document once more.
 *
 * Only this page writes the project file; this sends nothing to disk. It also remembers the projects it sent, so the
 * window can show what a held song plays (`project`).
 */
export class ProgramDocumentFeed {
  /** The version the program has, or was sent last; null while the page has no open program. */
  private sent: Pick<ProgramDocument, 'path' | 'sessionId' | 'revision'> | null = null;
  private inFlight = false;
  /** The last send failed: the program may not have `sent`. Only the next control that may start a song sends it again
   * (`flush`, the operator's own action); nothing sends it again by itself. */
  private unsent = false;
  /** Answers to a send made before the program was opened again are not this program's. */
  private epoch = 0;
  /** The projects sent, oldest first; `onAir` is the version the program was last seen playing, kept however many
   * newer ones follow while a song is held. */
  private readonly versions = new Map<string, LinkProject>();
  private onAir: string | null = null;

  constructor(private readonly ownerId: string, private readonly read: () => ProgramDocument | null,
    private readonly send: (request: NativeProgramDocument) => Promise<NativeProgramDocumentAnswer>,
    private readonly failed: (message: string) => void) {}

  /** The program opened with `document`: from now on it gets every newer version. */
  attached(document: ProgramDocument): void {
    this.epoch += 1; this.inFlight = false; this.unsent = false; this.sent = document;
    this.remember(document);
    this.changed();
  }
  /** The program is opening again, closed or gone: nothing is sent until it is attached. */
  detached(): void { this.epoch += 1; this.inFlight = false; this.unsent = false; this.sent = null; }
  /** The window's project changed. */
  changed(): void { if (!this.inFlight) this.push(); }
  /** The newest version goes now, before a control that starts a song (0.5.9 S7); also a version whose send failed. */
  flush(): void { this.push(false, true); }
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

  private push(resync = false, again = false): void {
    const document = this.sent ? this.read() : null;
    if (!document || !this.sent || (!resync && !(again && this.unsent) && sameProgramDocument(document, this.sent))) return;
    const epoch = this.epoch;
    this.inFlight = true; this.unsent = false; this.sent = document; this.remember(document);
    let request: NativeProgramDocument;
    try {
      request = { version: 1, ownerId: this.ownerId, key: { sessionId: document.sessionId, projectId: document.project.projectId, projectPath: document.path },
        revision: document.revision, base: null, change: { kind: 'full', document: JSON.stringify(document.project) } };
    } catch (error) { this.inFlight = false; this.unsent = true; this.failed(`这次修改没送进节目：${toUserErrorMessage(error)}`); return; }
    void this.send(request).then(answer => {
      if (epoch !== this.epoch) return;
      this.inFlight = false;
      if (answer.kind === 'resync') {
        if (resync) { this.unsent ||= document === this.sent; this.failed(`这次修改没送进节目：${answer.reason}`); return; }
        this.push(true); return;
      }
      this.changed();
    }, (error: unknown) => {
      if (epoch !== this.epoch) return;
      // Said once; the next edit sends the newest version, nothing is sent again by itself.
      // A newer version sent since decides by its own answer.
      this.inFlight = false; this.unsent ||= document === this.sent; this.failed(`这次修改没送进节目：${toUserErrorMessage(error)}`);
    });
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
