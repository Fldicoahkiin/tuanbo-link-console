import { SceneOutputTimeline, compileManagedMediaTimeline, materialSceneNames, playbackFramesPerSecond, type ManagedMediaEvent } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import { MediaOutOfStepError, failureReason, type ObsMediaScenes } from './obs-media-scenes';

/** A clip's preparation that failed once the clip was already on air, playing on
 * from the decoder of the clip it continues: nothing went wrong on air, and the
 * prepared decoder is not needed for it. */
export class ObsPreparationNotNeeded extends Error {
  constructor(readonly event: ManagedMediaEvent, readonly decoder: string, readonly reason: string) { super(reason); }
}

type Slot = { event: ManagedMediaEvent; sourceName: string; ready: boolean;
  /** The clip's start (or the seek that put it on air from the middle) failed
   * before OBS showed this decoder: it still stands for the clip (its stop and the
   * material's next clip reach it), but nothing of the clip is on air, so pauses,
   * resumes and the drift check have nothing to reach. */
  offAir?: true };
type Media = { path: string; current: Slot | null; pending: Slot | null; following: Slot | null; touched: Set<string>; retained: Set<string>;
  /** Starts, stops and seeks of this material that OBS has not answered yet. */
  busy: number };
type Scenes = Pick<ObsMediaScenes, 'prepareStandby' | 'copyPresentation' | 'prime' | 'execute' | 'seek' | 'isActive' | 'continueClip'>;

/** The red text of a clip playing on from the decoder of the clip it continues,
 * when its on-air step went wrong. The decoder plays on and stands for the clip
 * either way. When OBS carried the step out and only the position came out of
 * step with the music, the clip is on air with its scene and sound: nothing is
 * for the operator to do, the drift check puts it back in step once it is off by
 * more than its tolerance. Otherwise OBS may not show it, or not with its sound. */
function continuationFailure(event: ManagedMediaEvent, error: unknown): string {
  const reason = failureReason(error), what = event.assetKind === 'audio' ? '声音' : '画面';
  if (error instanceof MediaOutOfStepError) return `${what}接着上一段往下播，切到了这一段，但和音乐没对齐。原因：${reason}。差得多时联动台过几秒会自动按音乐校正，不用处理；后面的素材照常播`;
  return event.assetKind === 'audio'
    ? `声音接着上一段往下播，切到这一段时出了错。原因：${reason}。如果这一段的声音不对，在 OBS 混音器里调整；后面的素材照常播`
    : `画面接着上一段往下播，切到这一段时出了错。原因：${reason}。如果 OBS 节目画面上不是这段素材，在 OBS 里切到它的场景；后面的素材照常播`;
}
/** A clip as the timeline places it: its first and real end frame (a camera covering
 * it does not end it) and where in the file it starts. */
type Clip = { start: number; end: number; sourceOffsetMs: number };

/** Two decoders per material, at most one future clip per material. Preparation
 * never starts output and is driven by the formal audio clock, not the UI. */
export class ObsMediaPreload {
  private readonly media = new Map<string, Media>();
  private readonly timeline: SceneOutputTimeline;
  private readonly starts: ManagedMediaEvent[];
  private readonly clips: ReadonlyMap<string, Clip>;
  private readonly frameMs: number;
  /** Clips prepared after their boundary (recovery rule B); each at most once. */
  private readonly late = new Set<string>();
  /** Clips whose preparation failed: shown in red and never prepared again. */
  private readonly failed = new Set<string>();
  /** Prepared clips that reached their end without starting; their slot went to the next clip. */
  private readonly expired = new Set<string>();
  /** Decoders whose retirement already went out once, whatever OBS answered.
   * Nothing retires them again by itself (no automatic retry). */
  private readonly retirementSent = new WeakSet<Slot>();
  private readonly lookaheadFrames: number;
  private readonly preparationSpacingFrames: number;
  private nextPreparationFrame = -Infinity;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(project: LinkProject, itemId: string, private readonly scenes: Scenes,
    private readonly native: { prime: (name: string, restartRetained: boolean, kind: 'audio' | 'video') => Promise<void>; seek: (name: string, positionMs: number) => Promise<void> }) {
    const events = compileManagedMediaTimeline(project, itemId).events;
    this.timeline = new SceneOutputTimeline(project, itemId, events);
    this.starts = this.timeline.preloadEntries();
    const ends = new Map(events.filter(event => event.phase === 'stop').map(event => [event.clipId, event.frameNumber]));
    this.clips = new Map(events.filter(event => event.phase === 'start').map(event => [event.clipId,
      { start: event.frameNumber, end: ends.get(event.clipId) ?? Infinity, sourceOffsetMs: event.sourceOffsetMs }]));
    this.frameMs = 1000 / playbackFramesPerSecond(project.timebase.frameRate);
    this.lookaheadFrames = Math.ceil(10 * playbackFramesPerSecond(project.timebase.frameRate));
    // Eight live layers can still prepare inside the ten-second horizon.
    // Leave rendering time between decoder flush/upload bursts, rather than
    // starting another full-resolution preheat on the next clock sample.
    this.preparationSpacingFrames = Math.ceil(0.5 * playbackFramesPerSecond(project.timebase.frameRate));
  }
  register(projectId: string, asset: { id: string; name: string }, path: string, sourceName = materialSceneNames(projectId, asset).sourceName): void {
    // Registering again after OBS reconnects starts the decoder slots over; inputs
    // this session already used are still cleaned up when it stops.
    const previous = this.media.get(sourceName);
    this.media.set(sourceName, { path, current: null, pending: null, following: null, touched: previous?.touched ?? new Set(), retained: previous?.retained ?? new Set(), busy: 0 });
    // The operator reconnected OBS: the picture goes on from the next action, so
    // a clip that failed to prepare while OBS was gone is prepared once more.
    if (previous) for (const event of this.starts) if (event.sourceName === sourceName) this.failed.delete(event.clipId);
  }
  /** After OBS reconnects, standby decoders this session already used are prepared
   * again (hidden and muted), so the rebuild starts from the primary decoder and
   * stop can still clean them up. */
  async restoreStandby(assertCurrent: () => void): Promise<void> {
    for (const [primary, media] of this.media) {
      if (!media.touched.has(`${primary}·预备`)) continue;
      await this.scenes.prepareStandby(primary); assertCurrent();
    }
  }
  /** The decoder that stands for the material's clip now, or the name itself for
   * a name that is not one of this song's materials (an OBS input of the user's). */
  resolveSource(logicalName: string): string { return this.media.get(logicalName)?.current?.sourceName ?? logicalName; }
  /** Where a pause, a resume or the drift check of the material's clip goes: the
   * decoder of the clip on air now. Null when nothing of the material is on air
   * (its start was refused, its start or seek failed before OBS showed it, or its
   * clip ended), so such an action reaches no decoder: a stopped decoder is not
   * woken, nor one primed for a later clip moved off its frame. A name that is not
   * one of this song's materials is the user's own OBS input and passes as it is
   * (every material of the song is registered before its picture can play). */
  onAirSource(logicalName: string): string | null {
    const media = this.media.get(logicalName);
    if (!media) return logicalName;
    return media.current && !media.current.offAir ? media.current.sourceName : null;
  }

  async prime(event: ManagedMediaEvent, assertCurrent: () => void): Promise<void> {
    assertCurrent(); if (this.closed) throw new Error('素材准备已关闭');
    const kind = event.assetKind;
    if (kind !== 'audio' && kind !== 'video') throw new Error('只有音频和视频需要解码预热');
    const media = this.require(event);
    if (media.pending?.event.clipId === event.clipId) {
      if (!media.pending.ready) throw new Error(`素材正在准备，不能重复准备：${event.assetName}`);
      return;
    }
    if (media.pending) throw new Error(`已经有下一个素材在等待播放：${event.assetName}`);
    const primary = event.sourceName;
    const sourceName = media.current?.sourceName === primary ? `${primary}·预备` : primary;
    const slot = { event, sourceName, ready: false }; media.pending = slot;
    // Retain ownership before any write: cancellation still has to close a
    // decoder which was created but whose acknowledgement has not arrived.
    media.touched.add(sourceName);
    try {
      if (sourceName !== primary) await this.scenes.prepareStandby(primary);
      else if (media.current) await this.scenes.copyPresentation(media.current.sourceName, primary);
      assertCurrent();
      await this.scenes.prime({ ...event, sourceName }, media.path, async () => {
        assertCurrent();
        // Only our previously decoded and paused input can take this path. An
        // initial decoder's PAUSED flag may precede its asynchronous reset. A
        // retained input near EOF needs an explicit restart and advancing-frame
        // confirmation; seeking an inactive EOF decoder is otherwise ignored.
        await this.native.prime(sourceName, media.retained.has(sourceName), kind); assertCurrent();
        if (event.sourceOffsetMs !== 0) await this.native.seek(sourceName, Math.round(event.sourceOffsetMs));
        assertCurrent();
      });
      assertCurrent(); if (this.closed || media.pending !== slot) throw new Error('素材准备结果已过期');
    } catch (error) {
      // The slot goes back, so later clips on this input still get prepared
      // and played; this clip is not prepared again (no automatic retry).
      if (media.pending === slot) media.pending = null;
      this.failed.add(event.clipId);
      // Failed after the clip went on air on the decoder of the clip it continues
      // (see the late-ready case below): the picture plays on as it should.
      const playing = media.current;
      if (this.media.get(event.sourceName) === media && playing?.event.clipId === event.clipId && playing.sourceName !== sourceName) {
        throw new ObsPreparationNotNeeded(event, sourceName, failureReason(error));
      }
      throw error;
    }
    if (media.current?.event.clipId === event.clipId) {
      // Ready too late: the clip already plays on, on the decoder of the clip it
      // continues. This decoder stays off air, decoded and paused, and the slot
      // goes to the material's next clip, which restarts it.
      media.pending = null; media.retained.add(sourceName);
      return;
    }
    slot.ready = true;
    media.retained.delete(sourceName);
  }

  /** Prepares at most one clip and returns it once it is ready. A clip on air now
   * whose decoder missed its boundary goes first, once, so the program can start
   * it late at the current position; one that meanwhile plays on from the clip it
   * continues is not returned, so nothing starts it a second time. A material
   * whose start, stop or seek OBS has not answered yet waits for a later clock
   * sample: until the answer, its books may name a decoder OBS still shows, and
   * preparing that one would be refused or would race the retirement. */
  async upcoming(frame: number, assertCurrent: () => void): Promise<ManagedMediaEvent | null> {
    assertCurrent();
    this.expire(frame);
    if (frame < this.nextPreparationFrame) return null;
    const overdue = this.timeline.at(frame).media.find(event => {
      if (event.assetKind !== 'audio' && event.assetKind !== 'video' || this.late.has(event.clipId) || this.failed.has(event.clipId)) return false;
      const media = this.require(event);
      return !media.busy && media.current?.event.clipId !== event.clipId && media.pending === null;
    });
    if (overdue) {
      this.late.add(overdue.clipId); this.nextPreparationFrame = frame + this.preparationSpacingFrames;
      return this.prepared(overdue, assertCurrent);
    }
    const next = new Map<string, ManagedMediaEvent>();
    let low = 0, high = this.starts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.starts[middle]!.frameNumber <= frame) low = middle + 1; else high = middle; }
    for (let index = low; index < this.starts.length; index++) {
      const event = this.starts[index]!;
      if (event.frameNumber > frame + this.lookaheadFrames) break;
      if (next.has(event.sourceName) || this.failed.has(event.clipId)) continue;
      if (this.require(event).current?.event.clipId === event.clipId) continue;
      next.set(event.sourceName, event);
    }
    const targets = [...next.values()].filter(event => {
      const media = this.require(event);
      // The opening or immediately next clip still owns the only standby slot.
      // A later audio observation will prepare its successor after it enters.
      return !media.busy && media.current?.event.clipId !== event.clipId && media.pending === null;
    });
    const target = targets[0];
    if (!target) return null;
    // Keep initial preparation separate. While output is live, spreading GPU
    // uploads across audio observations avoids a four-decoder burst. Preparation
    // remains inside the same ten-second horizon and never delays an event.
    this.nextPreparationFrame = frame + this.preparationSpacingFrames;
    return this.prepared(target, assertCurrent);
  }
  private async prepared(event: ManagedMediaEvent, assertCurrent: () => void): Promise<ManagedMediaEvent | null> {
    await this.prime(event, assertCurrent);
    return this.require(event).pending?.event.clipId === event.clipId ? event : null;
  }

  /** A prepared clip past its real end can no longer go on air: its start was
   * merged away while OBS was busy, skipped after a position gap, or it ended
   * before a late start. Its slot goes to the next clip of the material
   * (2026-11-09: later clips must still play). The decoder stays owned and paused,
   * so its next preparation restarts it. A clip a camera covers keeps its slot
   * until its real end, since the camera's end shows it again. */
  private expire(frame: number): void {
    for (const media of this.media.values()) {
      for (let slot = media.pending; slot?.ready && frame >= (this.clips.get(slot.event.clipId)?.end ?? Infinity); slot = media.pending) {
        this.expired.add(slot.event.clipId);
        media.retained.add(slot.sourceName);
        media.pending = media.following; media.following = null;
      }
    }
  }

  /** Allocate and warm the second decoder before the formal clock starts.
   * Once the opening clip enters, this becomes the ordinary pending slot;
   * live playback never owns more than the same pair of decoders. */
  async primeFollowing(opening: ManagedMediaEvent, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    const media = this.require(opening);
    if (this.closed || media.current || !media.pending?.ready || media.pending.event.clipId !== opening.clipId || media.following) {
      throw new Error('接续准备只能在第一个素材准备好、还没开始播放时进行');
    }
    const next = this.starts.find(event => event.sourceName === opening.sourceName && event.clipId !== opening.clipId && event.frameNumber > opening.frameNumber
      && event.frameNumber <= opening.frameNumber + 2 * this.lookaheadFrames);
    if (!next) return;
    if (next.assetKind !== 'audio' && next.assetKind !== 'video') throw new Error('接续准备只支持音频和视频');
    const sourceName = `${opening.sourceName}·预备`, kind = next.assetKind;
    media.touched.add(sourceName);
    await this.scenes.prepareStandby(opening.sourceName); assertCurrent();
    await this.scenes.prime({ ...next, sourceName }, media.path, async () => {
      assertCurrent(); await this.native.prime(sourceName, false, kind); assertCurrent();
      if (next.sourceOffsetMs !== 0) await this.native.seek(sourceName, Math.round(next.sourceOffsetMs));
      assertCurrent();
    });
    assertCurrent();
    if (this.closed) throw new Error('接续准备已关闭');
    media.following = { event: next, sourceName, ready: true };
  }

  async execute(event: ManagedMediaEvent, path: string): Promise<void> {
    if (event.assetKind === 'image') return this.scenes.execute(event, path);
    const media = this.require(event);
    if (media.path !== path || this.closed) throw new Error('素材的播放路径或状态已改变');
    // Keep at most the existing pair of decoders. Retain an inactive input only
    // when its next preparation window is within one lookahead interval. Pause
    // stops decoding and hide/mute keep it off air, without repeatedly freeing
    // full-size asynchronous frames on OBS's graphics thread.
    const retain = this.starts.some(next => next.sourceName === event.sourceName
      && next.frameNumber > event.frameNumber && next.frameNumber <= event.frameNumber + 2 * this.lookaheadFrames);
    const retirement = retain ? 'pause' : 'stop';
    if (event.phase === 'stop') {
      if (!media.current || media.current.event.clipId !== event.clipId) return;
      return this.retire(media, media.current, event, path, retain, retirement);
    }
    const next = media.pending;
    if (!next?.ready || next.event.clipId !== event.clipId) {
      const previous = media.current, expired = this.expired.has(event.clipId);
      // A clip that continues the playing one in the file (one video cut in two)
      // is on air already: the decoder playing the clip before it plays on and
      // stands for this clip, as after a failed handover. The clip's stop, pause,
      // resume and the drift check reach that decoder, and the material's next
      // clip hands over from it. It still gets this clip's on-air step (shown, its
      // own sound, its scene on program), as a continuing start: its media clock
      // is not moved while it is in step. The clip counts as started; a step OBS
      // did not carry out is reported once and not sent again.
      if (!expired && previous && !this.retirementSent.has(previous) && this.continues(previous.event, event)
        && this.scenes.continueClip(previous.sourceName, previous.event.clipId, event)) {
        media.current = { event, sourceName: previous.sourceName, ready: true };
        try { await this.answered(media, () => this.scenes.execute({ ...event, sourceName: previous.sourceName }, path, undefined, retirement)); }
        catch (error) { throw new Error(continuationFailure(event, error), { cause: error }); }
        return;
      }
      // Otherwise nothing of this clip goes on air, but the timeline still ends
      // the clip before it. Back to back on one decoder pair, that end was left to
      // this start's handover (its own stop is not sent), so the old decoder would
      // play on past its end. A previous clip whose end has passed and whose
      // retirement never went out is retired now, when this start is refused. Its
      // retirement goes out once, whatever OBS answers: one OBS did not carry out
      // leaves that decoder the material's current one, and the material's next
      // handover retires it as usual. Pauses, resumes and the drift check of this
      // clip then reach no decoder (onAirSource).
      const refused = expired ? '这一段素材没有播出：轮到它时这一段已经结束了，电脑或 OBS 当时太忙' : `下一个素材没能在切换前准备好：${event.assetName}`;
      try {
        if (previous && !this.retirementSent.has(previous) && (this.clips.get(previous.event.clipId)?.end ?? Infinity) <= event.frameNumber) {
          try { await this.retire(media, previous, { ...previous.event, phase: 'stop' }, path, retain, retirement); }
          catch (error) {
            throw new Error(`${refused}。上一段的画面也没能退下，可能还留在 OBS 节目画面上。原因：${failureReason(error)}。如果 OBS 画面上还是上一段，在 OBS 里把它隐藏；后面的素材照常播`);
          }
        }
      } finally {
        // The material's main decoder stays owned, also one stopped here or
        // before: the song's stop stops it.
        media.touched.add(event.sourceName);
      }
      // A clip that ended unplayed needs nothing from the operator: later clips play as usual.
      throw new Error(expired ? `${refused}。后面的素材照常播，不用处理` : refused);
    }
    const previous = media.current;
    const handover = previous && previous.sourceName !== next.sourceName ? previous : null;
    media.current = next; media.pending = media.following; media.following = null;
    try {
      await this.answered(media, () => this.scenes.execute({ ...event, sourceName: next.sourceName }, path, previous?.sourceName, retirement));
    } catch (error) {
      if (handover) this.handedOver(media, next, handover, retain, true);
      // OBS never showed the new decoder: it stands for the clip, off air.
      if (this.media.get(event.sourceName) === media && media.current === next && !this.scenes.isActive(next.sourceName)) media.current = { ...next, offAir: true };
      throw error;
    }
    if (handover) this.handedOver(media, next, handover, retain, false);
  }

  /** Takes the current decoder off air for the end of its clip, once. When OBS
   * did not carry it out the decoder may still be on air: it stays the
   * material's current decoder. Transport controls reach it, and the material's
   * next clip hands over from it (retiring it) instead of starting underneath
   * it. The retirement is not sent again. */
  private async retire(media: Media, current: Slot, stop: ManagedMediaEvent, path: string, retain: boolean, retirement: 'pause' | 'stop'): Promise<void> {
    media.current = null; this.retirementSent.add(current);
    try {
      await this.answered(media, () => this.scenes.execute({ ...stop, sourceName: current.sourceName }, path, undefined, retirement));
    } catch (error) {
      if (this.scenes.isActive(current.sourceName) && media.current === null && this.media.get(stop.sourceName) === media) media.current = current;
      throw error;
    }
    if (retain) media.retained.add(current.sourceName);
    else media.touched.delete(current.sourceName);
  }

  /** Whether `next` continues `previous` in the file without a cut: it starts on
   * the frame `previous` ends, at the place in the file `previous` has reached
   * by then (within a frame). The sound follows the clip: the start of `next`
   * sets the decoder's sound by its own setting. */
  private continues(previous: ManagedMediaEvent, next: ManagedMediaEvent): boolean {
    const before = this.clips.get(previous.clipId), after = this.clips.get(next.clipId);
    return before !== undefined && after !== undefined && previous.clipId !== next.clipId && before.end === after.start
      && Math.abs(before.sourceOffsetMs + (before.end - before.start) * this.frameMs - after.sourceOffsetMs) <= this.frameMs;
  }

  /** A successfully stopped input needs no further cleanup; a paused one remains
   * owned until its next use or explicit session shutdown. When OBS did not take
   * the handover (the old decoder still counts as on air), the old decoder stands
   * for this clip: the clip's stop retires it and transport controls reach it.
   * When this clip continues the old one in the file, the old decoder plays this
   * clip's picture: from here on it counts as started for it, so the drift check
   * follows it and the material's next clip can continue it in turn. Otherwise
   * the drift check leaves it alone. The new decoder stays paused for the next
   * clip of the material. When OBS took the old decoder off but never showed the
   * new one, the new one still stands for this clip, off air: its stop and the
   * material's next clip reach it, and it is not started again. Nothing is sent
   * again. */
  private handedOver(media: Media, next: Slot, previous: Slot, retain: boolean, failed: boolean): void {
    if (failed && this.scenes.isActive(previous.sourceName)) {
      if (this.media.get(next.event.sourceName) !== media || media.current !== next) return;
      if (this.continues(previous.event, next.event)) this.scenes.continueClip(previous.sourceName, previous.event.clipId, next.event);
      media.current = { event: next.event, sourceName: previous.sourceName, ready: true };
      media.retained.add(next.sourceName);
      return;
    }
    if (retain) media.retained.add(previous.sourceName);
    // After a failure the stop may not have reached OBS (the connection can be
    // gone), so the old decoder stays owned and the end of the song stops it.
    else if (!failed) media.touched.delete(previous.sourceName);
  }

  async seek(event: ManagedMediaEvent, path: string): Promise<void> {
    if (event.assetKind === 'image') return this.scenes.seek(event, path, this.native.seek);
    const media = this.require(event);
    if (media.path !== path || this.closed) throw new Error('素材的定位路径或状态已改变');
    const sourceName = media.pending?.sourceName ?? media.current?.sourceName ?? event.sourceName;
    media.touched.add(sourceName); media.pending = null; media.following = null;
    media.retained.delete(sourceName);
    const slot: Slot = { event, sourceName, ready: true };
    media.current = slot;
    try { await this.answered(media, () => this.scenes.seek({ ...event, sourceName }, path, this.native.seek)); }
    catch (error) {
      // OBS never showed this decoder: it stands for the clip, off air, as after a
      // start that failed before its show. The program's play after the rebuild
      // and later pauses reach no decoder; the clip's stop still reaches it.
      if (this.media.get(event.sourceName) === media && media.current === slot && !this.scenes.isActive(sourceName)) media.current = { ...slot, offAir: true };
      throw error;
    }
  }

  /** Runs one start, stop or seek of the material; its next preparation waits
   * until OBS answered it, whether it succeeded or not. */
  private async answered(media: Media, operation: () => Promise<void>): Promise<void> {
    media.busy++;
    try { await operation(); } finally { media.busy--; }
  }

  close(): Promise<void> {
    this.closed = true;
    // Host cancellation and a pending preparation can converge here. Share the
    // same cleanup result, including failure; do not silently repeat commands.
    this.closing ??= this.releaseTouched();
    return this.closing;
  }
  private async releaseTouched(): Promise<void> {
    const errors: string[] = [];
    for (const [logical, media] of this.media) {
      const event = this.starts.find(candidate => candidate.sourceName === logical);
      if (!event) continue;
      for (const sourceName of media.touched) {
        try {
          await this.scenes.execute({ ...event, sourceName, phase: 'stop' }, media.path);
          media.touched.delete(sourceName);
          media.retained.delete(sourceName);
        }
        catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
      }
    }
    if (errors.length) throw new Error(`清理准备好的素材失败：${errors.join('；')}`);
  }
  private require(event: ManagedMediaEvent): Media {
    const media = this.media.get(event.sourceName);
    if (!media) throw new Error(`当前画面里没有这个素材：${event.assetName}`);
    return media;
  }
}
