import type { P1FollowOutputs, ProgramClock } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import type { MidiClockSource, MidiSongNow, NativeMidiHost } from './native-midi-host';

/*
 * The action MIDI of a P1 follow (0.5.9 P3d): what `P1FollowSession` tells its outputs, as the shared `NativeMidiHost`
 * of the internal player understands it. The host runs the same `MidiProgramSession` (late rule, port recovery of
 * 2026-10-24, versions); here only the follow's clocks become its prepare, observe and stop:
 * - `ready` of a song this output does not hold: a new pass, prepared at the song's head with the opening of a follow
 *   (MidiProgramSession.prepare `opening`); the host lets go of the song it held. P1's positions that come while the
 *   host prepares are kept, the latest goes to the host once it is ready: the host takes no running clock while it
 *   prepares (NativeMidiHost.observe).
 * - `running`: to the host, once it is ready.
 * - `hold`: the timecode froze; the host closes the session (sounding notes released, nothing queued goes out later).
 * - `reconcileAt`: prepared again at that position; `playsOn` keeps the pass and starts where the host stopped, so what
 *   was handled is not sent twice and what lies in the gap is judged by the late rule; otherwise a new pass from there.
 * - `stopped`: the host lets go of the song.
 * Nothing here throws into the follow: an output error is the host's (its state is red) and goes to the run log.
 */

type Host = Pick<NativeMidiHost, 'prepare' | 'observe' | 'stop' | 'holds'>;
type Log = (level: 'info' | 'warning' | 'error', message: string) => void;

/** `preparing`: the host prepares from `fromMs`; `following`: clocks go to the host; `held`: closed at a freeze;
 * `off`: the host could not prepare it, its clocks are not sent until the follow prepares it again. */
type Song = { sessionId: string; generation: number; itemId: string; pass: number; phase: 'preparing' | 'following' | 'held' | 'off';
  fromMs: number; latest: ProgramClock | null };

export class P1MidiOutput implements P1FollowOutputs {
  private song: Song | null = null;
  private passes = 0;
  /** Where the song is, for the host (MidiClockSource `now`): one function for the whole follow. */
  private readonly now = (): MidiSongNow | null => {
    const song = this.song;
    if (!song || song.phase === 'off') return null;
    const status = song.phase === 'preparing' ? 'ready' : song.phase === 'following' ? 'playing' : 'paused';
    const positionMs = song.phase === 'preparing' ? song.fromMs : song.latest?.positionMs ?? song.fromMs;
    return { sessionId: song.sessionId, generation: song.generation, itemId: song.itemId, status, positionMs, audioError: null };
  };

  constructor(private readonly project: LinkProject, private readonly host: Host, private readonly log: Log) {}

  observe(clock: ProgramClock): void {
    const song = this.song;
    switch (clock.state) {
      case 'ready':
        if (song?.sessionId !== clock.sessionId) this.begin(clock, 0, ++this.passes, true);
        return;
      case 'running': case 'ended':
        if (!song || song.sessionId !== clock.sessionId || clock.generation < song.generation) return;
        if (song.phase === 'preparing' || song.phase === 'following') song.latest = clock;
        if (song.phase === 'following') this.guard(() => this.host.observe(clock));
        return;
      case 'held': case 'lost':
        if (song?.sessionId === clock.sessionId) this.hold();
        return;
      case 'stopped':
        if (song?.sessionId !== clock.sessionId) return;
        this.song = null; this.letGo(song);
        return;
    }
  }

  hold(): void {
    const song = this.song;
    if (!song || song.phase === 'held' || song.phase === 'off') return;
    song.phase = 'held'; this.letGo(song);
  }

  reconcileAt(clock: ProgramClock, playsOn: boolean): void {
    const song = this.song;
    if (!song || song.sessionId !== clock.sessionId) {
      // A resync of a song not begun yet (frozen while still waiting): it begins here, nothing of the past sent.
      if (!playsOn) this.begin(clock, clock.positionMs, ++this.passes, false);
      return;
    }
    const fromMs = playsOn ? Math.min(song.latest?.positionMs ?? song.fromMs, clock.positionMs) : clock.positionMs;
    this.begin(clock, fromMs, playsOn ? song.pass : ++this.passes, false);
  }

  private begin(clock: ProgramClock, fromMs: number, pass: number, opening: boolean): void {
    const song: Song = { sessionId: clock.sessionId, generation: clock.generation, itemId: clock.itemId, pass, phase: 'preparing', fromMs,
      latest: clock.state === 'running' ? clock : null };
    this.song = song;
    const source: MidiClockSource = { now: this.now, opening: opening ? message => this.log('info', message) : null };
    this.host.prepare(this.project, { sessionId: song.sessionId, generation: song.generation, itemId: song.itemId }, pass, source).then(() => {
      if (this.song !== song || song.phase !== 'preparing') { this.letGo(song); return; }
      song.phase = 'following';
      const latest = song.latest;
      if (latest) this.guard(() => this.host.observe(latest));
    }, (error: unknown) => this.failed(song, error));
  }

  /** The host could not prepare this song: red there, one line here; another song or a newer preparation cancelled it. */
  private failed(song: Song, error: unknown): void {
    if (this.song !== song || song.phase !== 'preparing') return;
    song.phase = 'off';
    this.log('error', `跟随 P1 时动作 MIDI 没有准备好，这首歌这一段不发动作：${message(error)}`);
  }

  /** Only a song of this follow that the host still holds, as this output began it (session and generation), also while
   * the host opens its lost port again. */
  private letGo(song: Song): void {
    if (!this.host.holds(song.sessionId, song.generation)) return;
    void this.host.stop().catch((error: unknown) => this.log('error', `关闭跟随 P1 的动作 MIDI 失败：${message(error)}`));
  }

  private guard(step: () => void): void {
    try { step(); } catch (error) { this.log('error', `跟随 P1 时动作 MIDI 出错：${message(error)}`); }
  }
}

function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
