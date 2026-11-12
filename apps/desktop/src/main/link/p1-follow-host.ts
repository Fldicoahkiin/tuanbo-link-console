import { P1FollowSession, type OutputMode, type P1FollowOutputs } from '@tb/core/link';
import { p1FollowStateSchema, type LinkProject, type P1FollowRequest, type P1FollowState } from '@tb/schema';
import type { MidiInputClaim, MidiInputListener } from './midi-port-broker';

/*
 * P1 follow in the main process (0.5.9 P3, design 03 §4.1.4). The host owns P1's MTC input (claimed from the MIDI broker
 * as 「P1 时间码」, never through the window), runs one `P1FollowSession` (packages/core p1-follow-session.ts, where every
 * rule of the follow is decided) and shows the window its state (link:p1-follow-state, packages/schema p1-follow.ts).
 * The outputs are the shared ones of the internal player, reached only through `P1FollowOutputs`; wiring them, the
 * window's commands and the show state into link-main.ts is P3f.
 *
 * As on the page today (runtime-midi-session.ts, link-midi-adapter.ts `subscribeMtc`): the input is opened when the
 * follow starts and closed when it is left; unplugged, it is not opened again by itself (the 2026-10-24 recovery covers
 * the outputs only): what ran freezes, and the operator starts again.
 */

export type P1FollowHostDependencies = {
  /** The broker's `claimInput(name, 'P1 时间码', listener)`. */
  claimInput(name: string, listener: MidiInputListener): Promise<MidiInputClaim>;
  /** The window's document, parsed and checked as an opened project. */
  openProject(document: string, projectPath: string): LinkProject;
  /** The shared outputs for this follow of this project. */
  outputs(project: LinkProject, runMode: OutputMode): P1FollowOutputs;
  /** Auto-follow: P1 started this song; resolves when its outputs may start (today the page's per-song preflight,
   * `useP1AutoFollow` → `runDesktopPreflight`), rejects with what the operator reads. */
  prepareSong(project: LinkProject, itemId: string): Promise<void>;
  changed(state: P1FollowState): void;
  log(level: 'info' | 'warning' | 'error', message: string): void;
};

type Follow = {
  ownerId: string;
  project: LinkProject;
  runMode: OutputMode;
  session: P1FollowSession;
  input: NonNullable<P1FollowState['input']>;
  claim: MidiInputClaim | null;
};

/** The state goes to the window at once when anything but the position or the timecode changed, and otherwise at most
 * every this many ms of interface time (P1 sends 120 quarter frames a second). */
const POSITION_EVERY_MS = 100;

const CLOSED: P1FollowState = {
  version: 1, phase: 'closed', projectId: null, mode: null, runMode: null, itemId: null, sessionId: null, generation: 0,
  positionMs: null, cause: null, reason: null, input: null, mtc: null
};

export class P1FollowHost {
  private follow: Follow | null = null;
  /** Commands one at a time, in the order the window sent them. */
  private turn: Promise<unknown> = Promise.resolve();
  private shown: { key: string; atMs: number | null } | null = null;
  private nowMs: number | null = null;

  constructor(private readonly dependencies: P1FollowHostDependencies) {}

  get state(): P1FollowState { return this.snapshot(); }

  command(request: P1FollowRequest): Promise<P1FollowState> {
    const next = this.turn.then(() => this.run(request));
    this.turn = next.catch(() => undefined);
    return next;
  }

  /** The window's page that started the follow is gone (reloaded or closed): the follow ends with it. */
  pageGone(ownerId: string): Promise<void> {
    const next = this.turn.then(async () => { if (this.follow?.ownerId === ownerId) await this.close(); });
    this.turn = next.catch(() => undefined);
    return next;
  }

  private async run(request: P1FollowRequest): Promise<P1FollowState> {
    const command = request.command;
    if (command.kind === 'start') {
      await this.start(request.ownerId, command);
      return this.publish(true);
    }
    const follow = this.follow;
    if (!follow) throw new Error('还没打开要跟随 P1 的工程');
    if (follow.ownerId !== request.ownerId) throw new Error('另一个界面正在跟随 P1，这里不能操作');
    switch (command.kind) {
      case 'arm':
        if (follow.input.state !== 'open') throw new Error(follow.input.reason ?? `MTC 输入口「${follow.input.portName}」没有打开`);
        follow.session.arm(command.itemId);
        this.dependencies.log('info', command.itemId === null ? '开始自动监听 P1' : `从头待命：${this.title(follow, command.itemId)}`);
        break;
      case 'resync': follow.session.resync(); this.dependencies.log('info', '按当前时间重新同步'); break;
      case 'rearm': follow.session.rearm(); this.dependencies.log('info', '从头重新待命'); break;
      case 'manualTakeover': follow.session.takeover(); this.dependencies.log('info', '确认手动接管'); break;
      case 'stop': follow.session.stop(); this.dependencies.log('info', '停止跟随 P1'); break;
      case 'close': await this.close(); break;
    }
    return this.publish(true);
  }

  private async start(ownerId: string, command: Extract<P1FollowRequest['command'], { kind: 'start' }>): Promise<void> {
    const previous = this.follow;
    if (previous && previous.session.view.phase !== 'standby') throw new Error('正在跟随 P1，先停止再换工程');
    const project = this.dependencies.openProject(command.document, command.projectPath);
    const outputs = this.dependencies.outputs(project, command.runMode);
    let follow: Follow | null = null;
    const session = new P1FollowSession(project, command.mode, {
      outputs, prepare: (itemId, sessionId) => { if (follow) this.prepare(follow, itemId, sessionId); }
    });
    if (previous) await this.close();
    const opened: Follow = { ownerId, project, runMode: command.runMode, session, claim: null,
      input: { portName: command.inputPortName, state: 'opening', reason: null } };
    follow = opened; this.follow = opened; this.nowMs = null;
    this.publish(true);
    try {
      opened.claim = await this.dependencies.claimInput(command.inputPortName, this.listener(opened));
    } catch (error) {
      if (this.follow === opened) { this.follow = null; this.publish(true); }
      throw error instanceof Error ? error : new Error(String(error));
    }
    // A closed input reported while opening already set the state; otherwise it is open now.
    if (opened.input.state === 'opening') opened.input = { ...opened.input, state: 'open' };
    this.dependencies.log('info', `已打开 P1 时间码输入「${command.inputPortName}」`);
  }

  private async close(): Promise<void> {
    const follow = this.follow;
    if (!follow) return;
    follow.session.stop();
    this.follow = null;
    await follow.claim?.release();
    this.publish(true);
  }

  private listener(follow: Follow): MidiInputListener {
    const current = (): boolean => this.follow === follow;
    return {
      message: message => {
        if (!current()) return;
        this.advance(message.at100ns);
        this.guard(follow, () => follow.session.message(message.bytes, message.at100ns));
      },
      idle: at100ns => {
        if (!current()) return;
        this.advance(at100ns);
        this.guard(follow, () => follow.session.idle(at100ns));
      },
      closed: reason => { if (current()) this.inputClosed(follow, reason); }
    };
  }

  /** Whatever the timecode did is shown; a message the follow cannot take ends the input, as a failed helper does. */
  private guard(follow: Follow, step: () => void): void {
    try { step(); } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.dependencies.log('error', `P1 时间码处理失败：${reason}`);
      this.inputClosed(follow, `P1 时间码处理失败：${reason}`);
      return;
    }
    this.publish(false);
  }

  /** Unplugged or failed: what runs freezes; the input is let go and opened again only by a new start. */
  private inputClosed(follow: Follow, reason: string): void {
    follow.input = { ...follow.input, state: 'closed', reason };
    follow.session.inputGone();
    this.dependencies.log('warning', `P1 时间码输入停了：${reason}`);
    const claim = follow.claim; follow.claim = null;
    void claim?.release().catch((error: unknown) => this.dependencies.log('error', `关闭 P1 时间码输入未完成：${error instanceof Error ? error.message : String(error)}`));
    this.publish(true);
  }

  private prepare(follow: Follow, itemId: string, sessionId: string): void {
    this.dependencies.log('info', `P1 开始播放「${this.title(follow, itemId)}」，正在准备`);
    void this.dependencies.prepareSong(follow.project, itemId).then(() => {
      if (this.follow !== follow) return;
      follow.session.prepared(sessionId);
      this.publish(true);
    }, (error: unknown) => {
      if (this.follow !== follow) return;
      const reason = error instanceof Error ? error.message : String(error);
      this.dependencies.log('warning', `「${this.title(follow, itemId)}」没有开始：${reason}`);
      follow.session.preparationFailed(sessionId, reason);
      this.publish(true);
    });
  }

  private advance(at100ns: bigint): void {
    const atMs = Number(at100ns) / 10_000;
    if (this.nowMs === null || atMs > this.nowMs) this.nowMs = atMs;
  }

  private publish(force: boolean): P1FollowState {
    const state = this.snapshot();
    // Everything but the position and the timecode itself.
    const key = JSON.stringify({ ...state, positionMs: null, mtc: state.mtc ? { receiving: state.mtc.receiving, stable: state.mtc.stable, frameRate: state.mtc.frameRate } : null });
    const due = !this.shown || this.shown.key !== key || force
      || (this.nowMs !== null && (this.shown.atMs === null || this.nowMs - this.shown.atMs >= POSITION_EVERY_MS));
    if (due) {
      this.shown = { key, atMs: this.nowMs };
      this.dependencies.changed(p1FollowStateSchema.parse(state));
    }
    return state;
  }

  private snapshot(): P1FollowState {
    const follow = this.follow;
    if (!follow) return CLOSED;
    const view = follow.session.view;
    return {
      version: 1, phase: view.phase, projectId: follow.project.projectId, mode: view.mode, runMode: follow.runMode,
      itemId: view.itemId, sessionId: view.sessionId, generation: view.generation, positionMs: view.positionMs,
      cause: view.cause, reason: view.reason, input: follow.input,
      mtc: view.mtc ? { timecode: view.mtc.sample.timecode, frameRate: view.mtc.sample.frameRate, receiving: view.mtc.receiving, stable: view.mtc.stable } : null
    };
  }

  private title(follow: Follow, itemId: string): string {
    return follow.project.rundown.find(item => item.id === itemId)?.title ?? itemId;
  }
}
