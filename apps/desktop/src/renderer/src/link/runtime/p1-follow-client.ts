import type { LinkDesktopApi, LinkRuntimeState } from '@tb/core/link';
import type { IntegrationProfile, LinkProject, P1FollowCommand, P1FollowState } from '@tb/schema';

/*
 * The window's only way to P1 follow (0.5.9 P4): the main process follows P1 (apps/desktop/src/main/link/p1-follow-host.ts)
 * and this sends the operator's commands to it (link:p1-follow) and shows its state (link:p1-follow-state). Nothing here
 * decodes timecode or drives an output. Commands go one at a time, in order; a command that fails is reported with its
 * reason and never sent again by this client.
 */

type Api = Pick<LinkDesktopApi, 'p1Follow' | 'getP1FollowState' | 'onP1FollowState'>;

/** This page's id toward the follow, made once when the page loads (a reloaded page has a new one). */
export const P1_FOLLOW_PAGE = crypto.randomUUID();

/** What a start needs from the window: the project as the document store has it now, and this computer's settings. */
export type P1FollowStartInput = {
  project: LinkProject;
  path: string | null;
  /** The document store's version of it (`documentId`, `revision`): a start is sent again only when this changed. */
  documentId: number;
  revision: number;
  profile: IntegrationProfile | null;
  /** How the picture locates its clips on this computer (display preferences), as for the program. */
  preciseSeeking: boolean;
  encode(project: LinkProject): Promise<string>;
};

export type P1FollowClientDependencies = {
  api: Api;
  ownerId: string;
  /** A state this page should show: its own follow's, or one that goes on without a page (to adopt or to stop). */
  shown(state: P1FollowState): void;
  /** True once this page listens to the main process's red text (LinkApp useDesktopIntegrationEvents): a start
   * makes the main process send there what no follow state shows (the lights it could not switch off). */
  errorsShown(): boolean;
};

export class P1FollowClient {
  private turn: Promise<unknown> = Promise.resolve();
  /** The document version the follow was last started with (documentId:revision); null when none of this page. */
  private started: string | null = null;
  private latest: P1FollowState | null = null;

  constructor(private readonly dependencies: P1FollowClientDependencies) {}

  /** Listens for the state and reads it once (a new page sees a follow that went on without one). */
  connect(): () => void {
    let pushed = false;
    const stop = this.dependencies.api.onP1FollowState(state => { pushed = true; this.receive(state); });
    void this.dependencies.api.getP1FollowState().then(state => { if (!pushed) this.receive(state); },
      (error: unknown) => { console.error('没读到跟随 P1 的状态', error); });
    return stop;
  }

  get state(): P1FollowState | null { return this.latest; }

  /** Starts following this project, or does nothing when this page follows the same version of it already. `read`: the
   * project as the window has it when this start's turn comes. */
  start(read: () => P1FollowStartInput, mode: 'manual' | 'auto'): Promise<P1FollowState> {
    return this.queue(async () => {
      // Read when its turn comes: starts queued behind one another all send the newest version, or none when it is sent.
      const input = read();
      const version = `${input.documentId}:${input.revision}`;
      const current = this.latest;
      if (current && current.ownerId === this.dependencies.ownerId && current.phase !== 'closed' && this.started === version && current.mode === mode) return current;
      if (!this.dependencies.errorsShown()) throw new Error('界面还没准备好显示出错提示，请稍等再开始跟随 P1');
      if (!input.path) throw new Error('工程还没保存，请先保存再跟随 P1');
      if (input.project.playbackSource === 'internal') throw new Error('这个工程由联动台播放，不跟随 P1');
      const profile = input.profile;
      if (!profile) throw new Error('连接设置还没读取，请在设置里检查 MIDI 连接');
      const port = profile.midiPortProfiles.filter(entry => entry.id === profile.p1.mtcInputPortProfileId && entry.direction === 'input');
      if (port.length !== 1 || !port[0]?.portName) throw new Error('还没设置 P1 的 MTC 输入端口');
      const document = await input.encode(input.project);
      const state = await this.send({ kind: 'start', projectPath: input.path, sessionId: crypto.randomUUID(), revision: input.revision, document,
        mode, runMode: 'live', inputPortName: port[0].portName, lightingProfile: profile,
        preciseSeeking: input.preciseSeeking });
      this.started = version;
      return state;
    });
  }

  arm(itemId: string | null): Promise<P1FollowState> { return this.queue(() => this.send({ kind: 'arm', itemId })); }
  resync(): Promise<P1FollowState> { return this.queue(() => this.send({ kind: 'resync' })); }
  stop(): Promise<P1FollowState> { return this.queue(() => this.send({ kind: 'stop' })); }
  close(): Promise<P1FollowState> { return this.queue(async () => { const state = await this.send({ kind: 'close' }); this.started = null; return state; }); }
  /** Takes back the follow that went on while this page loaded; only for the project this page has open. */
  adopt(projectPath: string): Promise<P1FollowState> { return this.queue(() => this.send({ kind: 'adopt', projectPath })); }

  private queue<T>(step: () => Promise<T>): Promise<T> {
    const next = this.turn.then(step);
    this.turn = next.catch(() => undefined);
    return next;
  }

  private async send(command: P1FollowCommand): Promise<P1FollowState> {
    const state = await this.dependencies.api.p1Follow({ version: 1, ownerId: this.dependencies.ownerId, command });
    this.receive(state);
    return state;
  }

  /** Another page's follow is not this page's to show. */
  private receive(state: P1FollowState): void {
    if (state.ownerId !== null && state.ownerId !== this.dependencies.ownerId) return;
    if (state.phase === 'closed' || state.ownerId === null) this.started = null;
    this.latest = state;
    this.dependencies.shown(state);
  }
}

/** The follow as the window's runtime state names it (stores/runtime-store.ts), as the window's own run named it: auto
 * listening for its first song was idle. While the window checks before arming (`checking`), standby shows the check. */
export function followRuntimeState(state: P1FollowState, checking: boolean): LinkRuntimeState {
  switch (state.phase) {
    case 'closed': case 'standby': return checking ? 'preflight' : 'idle';
    case 'waiting': return state.mode === 'auto' && state.itemId === null ? checking ? 'preflight' : 'idle' : 'armed';
    case 'preparing': return 'preflight';
    case 'running': return 'running';
    case 'frozen': return 'timecodeLost';
    case 'takeover': return 'paused';
    case 'failed': return 'error';
  }
}

/** A follow that goes on without a page: what this page offers (adopt it when it has that project open, else stop it). */
export function orphanFollow(state: P1FollowState | null): { projectName: string; projectPath: string } | null {
  if (!state || state.phase === 'closed' || state.ownerId !== null || state.projectName === null || state.projectPath === null) return null;
  return { projectName: state.projectName, projectPath: state.projectPath };
}
