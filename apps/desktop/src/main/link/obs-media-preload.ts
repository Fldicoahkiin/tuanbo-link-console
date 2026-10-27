import { SceneOutputTimeline, materialSceneNames, playbackFramesPerSecond, type ManagedMediaEvent } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import type { ObsMediaScenes } from './obs-media-scenes';

type Slot = { event: ManagedMediaEvent; sourceName: string; ready: boolean };
type Media = { path: string; current: Slot | null; pending: Slot | null; following: Slot | null; touched: Set<string>; retained: Set<string> };
type Scenes = Pick<ObsMediaScenes, 'prepareStandby' | 'copyPresentation' | 'prime' | 'execute' | 'seek'>;

/** Two decoders per material, at most one future clip per material. Preparation
 * never starts output and is driven by the formal audio clock, not the UI. */
export class ObsMediaPreload {
  private readonly media = new Map<string, Media>();
  private readonly timeline: SceneOutputTimeline;
  private readonly starts: ManagedMediaEvent[];
  /** Clips prepared after their boundary (recovery rule B); each at most once. */
  private readonly late = new Set<string>();
  private readonly lookaheadFrames: number;
  private readonly preparationSpacingFrames: number;
  private nextPreparationFrame = -Infinity;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(project: LinkProject, itemId: string, private readonly scenes: Scenes,
    private readonly native: { prime: (name: string, restartRetained: boolean, kind: 'audio' | 'video') => Promise<void>; seek: (name: string, positionMs: number) => Promise<void> }) {
    this.timeline = new SceneOutputTimeline(project, itemId);
    this.starts = this.timeline.preloadEntries();
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
    this.media.set(sourceName, { path, current: null, pending: null, following: null, touched: previous?.touched ?? new Set(), retained: previous?.retained ?? new Set() });
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
  resolveSource(logicalName: string): string { return this.media.get(logicalName)?.current?.sourceName ?? logicalName; }

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
    slot.ready = true;
    media.retained.delete(sourceName);
  }

  /** Prepares at most one clip and returns it. A clip on air now whose decoder
   * missed its boundary goes first, once, so the program can start it late at
   * the current position. */
  async upcoming(frame: number, assertCurrent: () => void): Promise<ManagedMediaEvent | null> {
    assertCurrent();
    if (frame < this.nextPreparationFrame) return null;
    const overdue = this.timeline.at(frame).media.find(event => (event.assetKind === 'audio' || event.assetKind === 'video')
      && !this.late.has(event.clipId) && this.require(event).current?.event.clipId !== event.clipId && this.require(event).pending === null);
    if (overdue) {
      this.late.add(overdue.clipId); this.nextPreparationFrame = frame + this.preparationSpacingFrames;
      await this.prime(overdue, assertCurrent); return overdue;
    }
    const next = new Map<string, ManagedMediaEvent>();
    let low = 0, high = this.starts.length;
    while (low < high) { const middle = (low + high) >>> 1; if (this.starts[middle]!.frameNumber <= frame) low = middle + 1; else high = middle; }
    for (let index = low; index < this.starts.length; index++) {
      const event = this.starts[index]!;
      if (event.frameNumber > frame + this.lookaheadFrames) break;
      if (next.has(event.sourceName)) continue;
      if (this.require(event).current?.event.clipId === event.clipId) continue;
      next.set(event.sourceName, event);
    }
    const targets = [...next.values()].filter(event => {
      const media = this.require(event);
      // The opening or immediately next clip still owns the only standby slot.
      // A later audio observation will prepare its successor after it enters.
      return media.current?.event.clipId !== event.clipId && media.pending === null;
    });
    const target = targets[0];
    if (!target) return null;
    // Keep initial preparation separate. While output is live, spreading GPU
    // uploads across audio observations avoids a four-decoder burst. Preparation
    // remains inside the same ten-second horizon and never delays an event.
    this.nextPreparationFrame = frame + this.preparationSpacingFrames;
    await this.prime(target, assertCurrent); return target;
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
      const current = media.current; media.current = null;
      await this.scenes.execute({ ...event, sourceName: current.sourceName }, path, undefined, retirement);
      if (retain) media.retained.add(current.sourceName);
      if (!retain) media.touched.delete(current.sourceName);
      return;
    }
    const next = media.pending;
    if (!next?.ready || next.event.clipId !== event.clipId) throw new Error(`下一个素材没能在切换前准备好：${event.assetName}`);
    const previous = media.current;
    media.current = next; media.pending = media.following; media.following = null;
    await this.scenes.execute({ ...event, sourceName: next.sourceName }, path, previous?.sourceName, retirement);
    // A successfully stopped input needs no further cleanup; a paused one
    // remains owned until its next use or explicit session shutdown.
    if (previous && previous.sourceName !== next.sourceName) {
      if (retain) media.retained.add(previous.sourceName);
      else media.touched.delete(previous.sourceName);
    }
  }

  async seek(event: ManagedMediaEvent, path: string): Promise<void> {
    if (event.assetKind === 'image') return this.scenes.seek(event, path, this.native.seek);
    const media = this.require(event);
    if (media.path !== path || this.closed) throw new Error('素材的定位路径或状态已改变');
    const sourceName = media.pending?.sourceName ?? media.current?.sourceName ?? event.sourceName;
    media.touched.add(sourceName); media.pending = null; media.following = null;
    media.retained.delete(sourceName);
    media.current = { event, sourceName, ready: true };
    await this.scenes.seek({ ...event, sourceName }, path, this.native.seek);
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
