import { SceneOutputTimeline, materialSceneNames, playbackFramesPerSecond, type ManagedMediaEvent } from '@tb/core/link';
import type { LinkProject } from '@tb/schema';
import type { ObsMediaScenes } from './obs-media-scenes';

type Slot = { event: ManagedMediaEvent; sourceName: string; ready: boolean };
type Media = { path: string; current: Slot | null; pending: Slot | null; touched: Set<string>; retained: Set<string> };
type Scenes = Pick<ObsMediaScenes, 'prepareStandby' | 'copyPresentation' | 'prime' | 'execute' | 'seek'>;

/** Two decoders per material, at most one future clip per material. Preparation
 * never starts output and is driven by the formal audio clock, not the UI. */
export class ObsMediaPreload {
  private readonly media = new Map<string, Media>();
  private readonly starts: ManagedMediaEvent[];
  private readonly lookaheadFrames: number;
  private readonly preparationSpacingFrames: number;
  private nextPreparationFrame = -Infinity;
  private closed = false;
  private closing: Promise<void> | null = null;
  constructor(project: LinkProject, itemId: string, private readonly scenes: Scenes,
    private readonly native: { prime: (name: string, restartRetained: boolean, kind: 'audio' | 'video') => Promise<void>; seek: (name: string, positionMs: number) => Promise<void> }) {
    this.starts = new SceneOutputTimeline(project, itemId).preloadEntries();
    this.lookaheadFrames = Math.ceil(10 * playbackFramesPerSecond(project.timebase.frameRate));
    this.preparationSpacingFrames = Math.ceil(0.1 * playbackFramesPerSecond(project.timebase.frameRate));
  }
  register(projectId: string, asset: { id: string; name: string }, path: string, sourceName = materialSceneNames(projectId, asset).sourceName): void {
    this.media.set(sourceName, { path, current: null, pending: null, touched: new Set(), retained: new Set() });
  }
  resolveSource(logicalName: string): string { return this.media.get(logicalName)?.current?.sourceName ?? logicalName; }

  async prime(event: ManagedMediaEvent, assertCurrent: () => void): Promise<void> {
    assertCurrent(); if (this.closed) throw new Error('素材预备会话已关闭');
    const kind = event.assetKind;
    if (kind !== 'audio' && kind !== 'video') throw new Error('只有音频和视频需要解码预热');
    const media = this.require(event);
    if (media.pending?.event.clipId === event.clipId) {
      if (!media.pending.ready) throw new Error(`素材正在准备，不能重复准备：${event.assetName}`);
      return;
    }
    if (media.pending) throw new Error(`已有下一素材待播放：${event.assetName}`);
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
    assertCurrent(); if (this.closed || media.pending !== slot) throw new Error('素材预备结果已过期');
    slot.ready = true;
    media.retained.delete(sourceName);
  }

  async upcoming(frame: number, assertCurrent: () => void): Promise<void> {
    assertCurrent();
    if (frame < this.nextPreparationFrame) return;
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
    if (!target) return;
    // Keep initial preparation separate. While output is live, spreading GPU
    // uploads across audio observations avoids a four-decoder burst. Preparation
    // remains inside the same ten-second horizon and never delays an event.
    this.nextPreparationFrame = frame + this.preparationSpacingFrames;
    await this.prime(target, assertCurrent);
  }

  async execute(event: ManagedMediaEvent, path: string): Promise<void> {
    if (event.assetKind === 'image') return this.scenes.execute(event, path);
    const media = this.require(event);
    if (media.path !== path || this.closed) throw new Error('素材播放路径或会话已改变');
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
    if (!next?.ready || next.event.clipId !== event.clipId) throw new Error(`下一素材未在播放边界前准备完成：${event.assetName}`);
    const previous = media.current;
    media.current = next; media.pending = null;
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
    if (media.path !== path || this.closed) throw new Error('素材定位路径或会话已改变');
    const sourceName = media.pending?.sourceName ?? media.current?.sourceName ?? event.sourceName;
    media.touched.add(sourceName); media.pending = null;
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
    if (errors.length) throw new Error(`预备素材清理失败：${errors.join('；')}`);
  }
  private require(event: ManagedMediaEvent): Media {
    const media = this.media.get(event.sourceName);
    if (!media) throw new Error(`素材未注册到当前画面会话：${event.assetName}`);
    return media;
  }
}
