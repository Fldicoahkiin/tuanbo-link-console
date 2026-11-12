import { createObsProgramSnapshot, itemNeedsObs, toUserErrorReason, type P1FollowMode, type P1FollowOutputs, type ProgramClock } from '@tb/core/link';
import type { LinkProject, NativeObsStatus, P1FollowPicture } from '@tb/schema';
import type { NativeObsHost, PictureClockSource, PictureSongNow } from './native-obs-host';
import { ObsPreparationCancelled } from './native-obs-outputs';
import { ObsPreloadRefused, type NativeObsPreloadPool } from './native-obs-preload';

/*
 * The OBS picture of a P1 follow (0.5.9): what `P1FollowSession` tells its outputs, as the one `NativeObsHost` of the
 * app understands it, the way P1MidiOutput does it for the action MIDI. The host runs the same `ObsProgramSession` as
 * for the internal player (the last frame kept on a stop, OBS reconnects, the read-back); here only the follow's clocks
 * become its prepare, observe and stop, through one `PictureClockSource` for the whole follow:
 * - `ready` of a song this output does not hold: its picture is prepared in the background, from the song's head (or the
 *   resync position); the song does not wait for it (decision 3). Once it is up it joins at P1's position then (the
 *   host's late rejoin, quiet for P1: only a part that did not come back is red). A song with no picture work prepares
 *   nothing; its positions still reach the host, which takes off the last frame of the song before as for any song
 *   without a picture.
 * - `running`: to the host, once the picture is up.
 * - `hold`: the timecode froze. Point actions and camera switches stop where they are, nothing between is sent later
 *   (AGENTS §4.9); the clips go on in manual mode (the timecode was lost or jumped, the music plays on) and pause in auto
 *   mode (P1 paused or stopped), as each did before 0.5.9 P4 (decision 4).
 * - `reconcileAt`: `playsOn` (auto, P1 went on from where it stopped): the same pass, the clips go on, put where the music
 *   is; what was sent is not sent again. Otherwise (manual resync): the picture is placed once at this position, the
 *   camera and clips of now on air and no point action of the past sent, as a program's song prepared at a position;
 *   the frame before stays until then (decision 5).
 * - `stopped`: the song's picture stops on its last frame, as the program's (R14); `close` (the follow is over) takes it off.
 * - `expect`: the song P1 is expected to play from its head next is made ready, so its picture is not late (user,
 *   2026-11-12). Nothing of it reaches what OBS shows: with nothing of the follow on, the preload pool makes it ready as the
 *   program's selected song (`preload`); while a song of the follow is on, as that song's next one (`nextFiles`). Both
 *   without our music item. Its own preparation at its start takes what was made ready; a wrong guess is let go. Never
 *   red, never waited for: a refusal or failure is one line in the run log, and the song prepares at its start as before.
 * One picture session for the whole follow and a generation of its own for each pass and resume, so the pool hands what it
 * made ready over (it does only within one session); a clock still belongs to a song by the follow's own session.
 * Nothing here throws into the follow: a picture error is the picture's (red in the follow's state) and goes to the run log.
 */

type Host = Pick<NativeObsHost, 'prepare' | 'observe' | 'stopSource' | 'closeSource' | 'prepareNext'>;
type Pool = Pick<NativeObsPreloadPool, 'preload' | 'cancel' | 'cancelNext'>;
/** The longest reason and fault the follow's state carries (`p1FollowPictureSchema`); the host's own status has no limit. */
const TEXT_LIMIT = 8192;
const cut = (text: string | null): string | null => text === null ? null : text.slice(0, TEXT_LIMIT);
type Log = (level: 'info' | 'warning' | 'error', message: string) => void;

export type P1PictureOutputDependencies = {
  host: Host;
  /** The one preload pool beside the host (pictures made ready ahead); null: nothing is made ready ahead. */
  pool: Pool | null;
  project: LinkProject;
  projectPath: string;
  mode: P1FollowMode;
  /** This computer's display preference, as the program's picture takes it. */
  preciseSeeking: boolean;
  /** The license check of every output. */
  authorize(): Promise<void>;
  /** The picture's own state changed (P1FollowState `outputs.picture`). */
  changed(): void;
  log: Log;
};

/** `preparing`: the host prepares it; `following`: clocks go to the host; `held`: frozen; `off`: not prepared (refused or
 * failed), only positions go; `none`: no picture work, only positions go. `sessionId` and `clockGeneration`: the
 * follow's own clock of the song. `generation`: the picture's, one per pass and resume; `prepared`: the one its
 * preparation was asked with (null: not asked yet). */
type Song = { sessionId: string; clockGeneration: number; itemId: string; phase: 'preparing' | 'following' | 'held' | 'off' | 'none';
  latest: ProgramClock | null; fromMs: number; generation: number; prepared: number | null };
/** The song made ready ahead: as the selected song (`generation` of the pool's request), or as `pass`'s next one. */
type Ahead = { itemId: string; via: 'selection'; generation: number } | { itemId: string; via: 'next'; pass: Song };

export class P1PictureOutput implements P1FollowOutputs {
  private song: Song | null = null;
  private shown: P1FollowPicture | null = null;
  private ahead: Ahead | null = null;
  /** The follow's one picture session (all its songs, passes and the pictures made ready ahead) and its generations. */
  private readonly session = crypto.randomUUID();
  private generations = 0;
  /** Where the follow's song is, for the host: one source for the whole follow, so its songs and last frames are its own. */
  readonly source: PictureClockSource;

  constructor(private readonly dependencies: P1PictureOutputDependencies) {
    this.source = { owner: `工程「${dependencies.project.name}」`, now: () => this.now(), changed: status => this.statusChanged(status) };
  }

  /** The picture of the song this follow holds, as the host reported it last; null for a song with no picture work. */
  get state(): P1FollowPicture | null { return this.shown; }

  observe(clock: ProgramClock): void {
    const song = this.song;
    switch (clock.state) {
      case 'ready':
        if (song?.sessionId !== clock.sessionId) this.begin(clock, 0, null);
        return;
      case 'running': case 'ended':
        if (!song || song.sessionId !== clock.sessionId || clock.generation < song.clockGeneration) return;
        song.latest = clock;
        if (song.phase !== 'preparing' && song.phase !== 'held') this.forward(song, clock);
        return;
      case 'held': case 'lost':
        if (song?.sessionId === clock.sessionId) this.hold();
        return;
      case 'stopped':
        if (song?.sessionId !== clock.sessionId) return;
        this.song = null; this.show(null);
        // On its last frame, as the program's song (R14): the next song's picture takes it off once it is on.
        if (song.prepared !== null) this.stopPass(song.prepared);
        return;
    }
  }

  hold(): void {
    const song = this.song;
    if (!song || song.phase === 'held' || song.phase === 'off' || song.phase === 'none') return;
    const following = song.phase === 'following';
    song.phase = 'held';
    // Auto: P1 paused or stopped, the clips pause with it. Manual: the music plays on, so do the clips; nothing is sent.
    if (following && this.dependencies.mode === 'auto' && song.latest) this.forward(song, { ...song.latest, state: 'held', observedAtMs: null });
  }

  reconcileAt(clock: ProgramClock, playsOn: boolean): void {
    const song = this.song;
    if (!song || song.sessionId !== clock.sessionId) {
      // A resync of a song not begun yet (frozen while still waiting): placed once at this position, as any resync.
      if (!playsOn) this.begin(clock, clock.positionMs, clock);
      return;
    }
    if (song.phase === 'none' || playsOn && song.phase === 'off') { this.resume(song, clock); this.forward(song, clock); return; }
    if (!playsOn) { this.begin(clock, clock.positionMs, clock); return; }
    // The same pass: the clips go on from where they paused, put where the music is now.
    this.resume(song, clock);
    if (song.phase === 'held') { song.phase = 'following'; this.forward(song, clock); }
  }

  /** The song P1 is expected to play from its head next (`P1FollowOutputs.expect`): made ready ahead, what was made ready
   * for another one let go. A song with no picture work needs nothing. */
  expect(itemId: string | null): void {
    const wanted = itemId !== null && itemNeedsObs(this.dependencies.project, itemId) ? itemId : null;
    if (wanted === this.ahead?.itemId || wanted === null && this.ahead === null) return;
    this.letGoAhead();
    if (wanted !== null) this.makeReady(wanted);
  }

  /** The follow is over: its song's picture stops, what its songs left on their last frame is taken off, and nothing it
   * made ready ahead stays in the pool. */
  async close(): Promise<void> {
    this.song = null; this.shown = null;
    const ahead = this.ahead; this.ahead = null;
    const pool = this.dependencies.pool;
    await Promise.all([this.dependencies.host.closeSource(this.source),
      pool ? this.cleaned(Promise.all([ahead?.via === 'selection' ? pool.cancel({ version: 1, sessionId: this.session, generation: ahead.generation }) : undefined,
        pool.cancelNext(this.session)])) : undefined]);
  }

  /** Where the song is for the host: P1 plays it (preparing, following, and frozen in manual mode), or it is paused (auto).
   * While its pass is prepared, where that pass is prepared from: so a picture made ready at the head is the one taken,
   * and the host's late rejoin puts it where P1 is on the first clock. */
  private now(): PictureSongNow | null {
    const song = this.song;
    if (!song || song.phase === 'off' || song.phase === 'none') return null;
    const status = song.phase === 'held' && this.dependencies.mode === 'auto' ? 'paused' : 'playing';
    const positionMs = song.phase === 'preparing' ? song.fromMs : song.latest?.positionMs ?? song.fromMs;
    return { sessionId: this.session, generation: song.generation, itemId: song.itemId, status, positionMs };
  }

  /** P1 went on (or the song without a picture goes on): the follow's clock and the picture's generation move on. */
  private resume(song: Song, clock: ProgramClock): void {
    song.clockGeneration = clock.generation; song.latest = clock; song.generation = ++this.generations;
  }

  /** A new pass of the song's picture from `fromMs`, prepared in the background; the song does not wait for it. */
  private begin(clock: ProgramClock, fromMs: number, latest: ProgramClock | null): void {
    const { project, projectPath, preciseSeeking, host } = this.dependencies;
    // What was made ready for this song is taken by its preparation below (or let go there if it no longer fits); what
    // was made ready for another one is let go now.
    if (this.ahead?.itemId === clock.itemId) this.ahead = null; else this.letGoAhead();
    const needs = itemNeedsObs(project, clock.itemId);
    const song: Song = { sessionId: clock.sessionId, clockGeneration: clock.generation, itemId: clock.itemId, phase: needs ? 'preparing' : 'none',
      latest, fromMs, generation: ++this.generations, prepared: null };
    this.song = song;
    if (!needs) { this.show(null); return; }
    void (async () => {
      await this.dependencies.authorize();
      if (this.song !== song) return;
      const snapshot = createObsProgramSnapshot(project, song.itemId, 0);
      // The song expected after this one, if that is known by now (auto: told right after this song's start).
      const ahead = this.ahead?.via === 'next' && this.ahead.pass === song ? this.ahead : null;
      song.prepared = song.generation;
      await host.prepare({ version: 1, sessionId: this.session, generation: song.prepared, projectPath, preciseSeeking, snapshot,
        ...ahead ? { nextFiles: { snapshot: createObsProgramSnapshot(project, ahead.itemId, 0), positionMs: 0 } } : {} }, this.source);
      if (this.song !== song) {
        // Stopped or replaced meanwhile: a picture nobody plays any more stops (a newer pass of it took it over already).
        if (this.song?.sessionId !== song.sessionId) await host.stopSource(this.source, song.prepared);
        return;
      }
      if (song.phase === 'held') return;
      song.phase = 'following';
      if (song.latest) this.forward(song, song.latest);
    })().catch((error: unknown) => this.failed(song, error));
  }

  /** Makes `itemId` ready ahead without touching what OBS shows. */
  private makeReady(itemId: string): void {
    const { pool, project, projectPath, preciseSeeking, host } = this.dependencies;
    if (!pool) return;
    const song = this.song;
    const snapshot = createObsProgramSnapshot(project, itemId, 0);
    if (song && (song.phase === 'preparing' || song.phase === 'following' || song.phase === 'held')) {
      // A song of the follow is on: as its next song (its preparation carries it, or the host takes it now).
      if (song.itemId === itemId) return;
      this.ahead = { itemId, via: 'next', pass: song };
      if (song.prepared === null) return;
      host.prepareNext({ version: 1, sessionId: this.session, generation: song.prepared, nextFiles: { snapshot, positionMs: 0 } })
        .catch((error: unknown) => this.dependencies.log('info', `「${titleOf(project, itemId)}」的画面没有提前准备，歌开始时再准备：${toUserErrorReason(error)}`));
      return;
    }
    // Nothing of the follow on air: as the selected song, through the pool's own admission.
    const ahead: Ahead = { itemId, via: 'selection', generation: ++this.generations };
    this.ahead = ahead;
    const started = performance.now(), title = titleOf(project, itemId);
    pool.preload({ version: 1, sessionId: this.session, generation: ahead.generation, projectPath, preciseSeeking, snapshot, positionMs: 0 }, undefined, false)
      .then(() => this.dependencies.log('info', `「${title}」的画面已提前准备好，用了 ${Math.round(performance.now() - started)} 毫秒`), (error: unknown) => {
        // Let go or taken over by the song itself (which then hears how it went): nothing to say here.
        if (error instanceof ObsPreparationCancelled || this.ahead !== ahead) return;
        if (error instanceof ObsPreloadRefused) this.dependencies.log('info', `「${title}」的画面没有提前准备：${toUserErrorReason(error)}。歌开始时再准备`);
        else this.dependencies.log('warning', `「${title}」的画面没能提前准备好，歌开始时再准备：${toUserErrorReason(error)}`);
      });
  }

  /** Lets go of what was made ready ahead, and nothing else. */
  private letGoAhead(): void {
    const ahead = this.ahead, pool = this.dependencies.pool;
    this.ahead = null;
    if (!ahead || !pool) return;
    if (ahead.via === 'selection') { void this.cleaned(pool.cancel({ version: 1, sessionId: this.session, generation: ahead.generation })); return; }
    const song = this.song;
    // The song it was to follow is still on: it stops asking for it. Otherwise the pool lets go of it directly.
    if (ahead.pass === song && song.prepared !== null && song.phase !== 'off') {
      void this.cleaned(this.dependencies.host.prepareNext({ version: 1, sessionId: this.session, generation: song.prepared, nextFiles: null }));
    } else void this.cleaned(pool.cancelNext(this.session));
  }

  /** A cleanup of a picture made ready ahead: a failure is logged once and never reaches the follow. */
  private cleaned(work: Promise<unknown>): Promise<void> {
    return work.then(() => undefined, (error: unknown) => this.dependencies.log('warning', `提前准备的画面没有清理干净，不影响播放：${toUserErrorReason(error)}`));
  }

  private stopPass(generation: number): void {
    void this.dependencies.host.stopSource(this.source, generation).catch((error: unknown) => this.dependencies.log('error', `停下跟随 P1 的画面失败：${toUserErrorReason(error)}`));
  }

  /** The picture of this song could not be prepared, or was not this follow's to have: red, with why; the rest goes on. */
  private failed(song: Song, error: unknown): void {
    if (this.song !== song) return;
    song.phase = 'off';
    const reason = toUserErrorReason(error);
    this.dependencies.log('error', `跟随 P1 时这首歌的画面没有准备好，音乐、动作 MIDI 和灯光照常：${reason}`);
    // A preparation the host had begun keeps the parts it listed; one it refused has none.
    const shown = this.shown?.itemId === song.itemId ? this.shown : null;
    this.show({ itemId: song.itemId, state: 'failed', reason: cut(reason), fault: shown?.fault ?? null, items: shown?.items ?? [], follow: null });
  }

  /** P1's clock, as the picture session has it: the follow's one session, this pass's generation. */
  private forward(song: Song, clock: ProgramClock): void {
    try { this.dependencies.host.observe({ ...clock, sessionId: this.session, generation: song.generation }); }
    catch (error) { this.dependencies.log('error', `跟随 P1 时画面出错：${toUserErrorReason(error)}`); }
  }

  /** The host's status of this follow's picture, as the follow's state shows it (the same parts and read-back as the program). */
  private statusChanged(status: NativeObsStatus): void {
    // Only the pass of the song this follow holds now: what a song or an earlier pass let go of shows nothing more.
    const song = this.song;
    if (!song || song.prepared === null || status.sessionId !== this.session || status.itemId !== song.itemId || status.generation < song.prepared) return;
    this.show({ itemId: status.itemId, state: status.state, reason: cut(status.reason), fault: cut(status.fault ?? null), items: status.items ?? [],
      follow: status.follow ?? null });
  }

  /** The follow's state changes only when what it shows does: the host reports each position step of a running song. */
  private show(picture: P1FollowPicture | null): void {
    if (samePicture(this.shown, picture)) return;
    this.shown = picture;
    this.dependencies.changed();
  }
}

function titleOf(project: LinkProject, itemId: string): string {
  return project.rundown.find(item => item.id === itemId)?.title ?? itemId;
}

/** Two pictures show the same. The host's status is parsed anew on each report, so its parts and read-back are compared
 * by what they say, not by reference. */
function samePicture(a: P1FollowPicture | null, b: P1FollowPicture | null): boolean {
  if (a === null || b === null) return a === b;
  return a.itemId === b.itemId && a.state === b.state && a.reason === b.reason && a.fault === b.fault
    && JSON.stringify(a.items) === JSON.stringify(b.items) && JSON.stringify(a.follow) === JSON.stringify(b.follow);
}
