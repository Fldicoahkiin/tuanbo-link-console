import { createObsProgramSnapshot, itemNeedsObs, toUserErrorReason, type P1FollowMode, type P1FollowOutputs, type ProgramClock } from '@tb/core/link';
import type { LinkProject, NativeObsStatus, P1FollowPicture } from '@tb/schema';
import type { NativeObsHost, PictureClockSource, PictureSongNow } from './native-obs-host';

/*
 * The OBS picture of a P1 follow (0.5.9): what `P1FollowSession` tells its outputs, as the one `NativeObsHost` of the
 * app understands it, the way P1MidiOutput does it for the action MIDI. The host runs the same `ObsProgramSession` as
 * for the internal player (the last frame kept on a stop, OBS reconnects, the read-back); here only the follow's clocks
 * become its prepare, observe and stop, through one `PictureClockSource` for the whole follow:
 * - `ready` of a song this output does not hold: its picture is prepared in the background, at where P1 is by then; the
 *   song does not wait for it (decision 3). Once it is up it joins at the position then (the host's late rejoin, quiet
 *   for P1: only a part that did not come back is red). A song with no picture work prepares nothing; its positions
 *   still reach the host, which takes off the last frame of the song before as for any song without a picture.
 * - `running`: to the host, once the picture is up.
 * - `hold`: the timecode froze. Point actions and camera switches stop where they are, nothing between is sent later
 *   (AGENTS §4.9); the clips go on in manual mode (the timecode was lost or jumped, the music plays on) and pause in auto
 *   mode (P1 paused or stopped), as each did before 0.5.9 P4 (decision 4).
 * - `reconcileAt`: `playsOn` (auto, P1 went on from where it stopped): the same pass, the clips go on, put where the music
 *   is; what was sent is not sent again. Otherwise (manual resync): the picture is placed once at this position, the
 *   camera and clips of now on air and no point action of the past sent, as a program's song prepared at a position;
 *   the frame before stays until then (decision 5).
 * - `stopped`: the song's picture stops on its last frame, as the program's (R14); `close` (the follow is over) takes it off.
 * Nothing here throws into the follow: a picture error is the picture's (red in the follow's state) and goes to the run log.
 */

type Host = Pick<NativeObsHost, 'prepare' | 'observe' | 'stopSource' | 'closeSource'>;
type Log = (level: 'info' | 'warning' | 'error', message: string) => void;

export type P1PictureOutputDependencies = {
  host: Host;
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
 * failed), only positions go; `none`: no picture work, only positions go. */
type Song = { sessionId: string; generation: number; itemId: string; phase: 'preparing' | 'following' | 'held' | 'off' | 'none'; latest: ProgramClock | null; fromMs: number };

export class P1PictureOutput implements P1FollowOutputs {
  private song: Song | null = null;
  private shown: P1FollowPicture | null = null;
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
        if (!song || song.sessionId !== clock.sessionId || clock.generation < song.generation) return;
        song.latest = clock;
        if (song.phase !== 'preparing' && song.phase !== 'held') this.forward(clock);
        return;
      case 'held': case 'lost':
        if (song?.sessionId === clock.sessionId) this.hold();
        return;
      case 'stopped':
        if (song?.sessionId !== clock.sessionId) return;
        this.song = null; this.show(null);
        // On its last frame, as the program's song (R14): the next song's picture takes it off once it is on.
        void this.dependencies.host.stopSource(this.source, song.sessionId).catch((error: unknown) => this.dependencies.log('error', `停下跟随 P1 的画面失败：${toUserErrorReason(error)}`));
        return;
    }
  }

  hold(): void {
    const song = this.song;
    if (!song || song.phase === 'held' || song.phase === 'off' || song.phase === 'none') return;
    const following = song.phase === 'following';
    song.phase = 'held';
    // Auto: P1 paused or stopped, the clips pause with it. Manual: the music plays on, so do the clips; nothing is sent.
    if (following && this.dependencies.mode === 'auto' && song.latest) this.forward({ ...song.latest, state: 'held', observedAtMs: null });
  }

  reconcileAt(clock: ProgramClock, playsOn: boolean): void {
    const song = this.song;
    if (!song || song.sessionId !== clock.sessionId) return;
    if (song.phase === 'none' || playsOn && song.phase === 'off') { song.generation = clock.generation; song.latest = clock; this.forward(clock); return; }
    if (!playsOn) { this.begin(clock, clock.positionMs, clock); return; }
    // The same pass: the clips go on from where they paused, put where the music is now.
    song.generation = clock.generation; song.latest = clock;
    if (song.phase === 'held') { song.phase = 'following'; this.forward(clock); }
  }

  /** The follow is over: its song's picture stops and what its songs left on their last frame is taken off. */
  close(): Promise<void> {
    this.song = null; this.shown = null;
    return this.dependencies.host.closeSource(this.source);
  }

  /** Where the song is for the host: P1 plays it (preparing, following, and frozen in manual mode), or it is paused (auto). */
  private now(): PictureSongNow | null {
    const song = this.song;
    if (!song || song.phase === 'off' || song.phase === 'none') return null;
    const status = song.phase === 'held' && this.dependencies.mode === 'auto' ? 'paused' : 'playing';
    return { sessionId: song.sessionId, generation: song.generation, itemId: song.itemId, status, positionMs: song.latest?.positionMs ?? song.fromMs };
  }

  /** A new pass of the song's picture from `fromMs`, prepared in the background; the song does not wait for it. */
  private begin(clock: ProgramClock, fromMs: number, latest: ProgramClock | null): void {
    const { project, projectPath, preciseSeeking, host } = this.dependencies;
    const needs = itemNeedsObs(project, clock.itemId);
    const song: Song = { sessionId: clock.sessionId, generation: clock.generation, itemId: clock.itemId, phase: needs ? 'preparing' : 'none', latest, fromMs };
    this.song = song;
    if (!needs) { this.show(null); return; }
    void (async () => {
      await this.dependencies.authorize();
      if (this.song !== song) return;
      const snapshot = createObsProgramSnapshot(project, song.itemId, 0);
      await host.prepare({ version: 1, sessionId: song.sessionId, generation: song.generation, projectPath, preciseSeeking, snapshot }, this.source);
      if (this.song !== song) {
        // Stopped or replaced meanwhile: a picture nobody plays any more stops (a newer pass of it took it over already).
        if (this.song?.sessionId !== song.sessionId) await host.stopSource(this.source, song.sessionId);
        return;
      }
      if (song.phase === 'held') return;
      song.phase = 'following';
      if (song.latest) this.forward(song.latest);
    })().catch((error: unknown) => this.failed(song, error));
  }

  /** The picture of this song could not be prepared, or was not this follow's to have: red, with why; the rest goes on. */
  private failed(song: Song, error: unknown): void {
    if (this.song !== song) return;
    song.phase = 'off';
    const reason = toUserErrorReason(error);
    this.dependencies.log('error', `跟随 P1 时这首歌的画面没有准备好，音乐、动作 MIDI 和灯光照常：${reason}`);
    // A preparation the host had begun keeps the parts it listed; one it refused has none.
    const shown = this.shown?.itemId === song.itemId ? this.shown : null;
    this.show({ itemId: song.itemId, state: 'failed', reason, fault: shown?.fault ?? null, items: shown?.items ?? [], follow: null });
  }

  private forward(clock: ProgramClock): void {
    try { this.dependencies.host.observe(clock); }
    catch (error) { this.dependencies.log('error', `跟随 P1 时画面出错：${toUserErrorReason(error)}`); }
  }

  /** The host's status of this follow's picture, as the follow's state shows it (the same parts and read-back as the program). */
  private statusChanged(status: NativeObsStatus): void {
    // Only the song this follow holds now: what a song let go of (stopping, on its last frame) shows nothing more.
    if (this.song?.sessionId !== status.sessionId) return;
    this.show({ itemId: status.itemId, state: status.state, reason: status.reason, fault: status.fault ?? null, items: status.items ?? [],
      follow: status.follow ?? null });
  }

  private show(picture: P1FollowPicture | null): void {
    this.shown = picture;
    this.dependencies.changed();
  }
}
