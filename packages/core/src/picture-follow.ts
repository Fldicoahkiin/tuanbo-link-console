/**
 * Whether OBS shows what the timeline wants now (0.5.9 design 01 §4.8, root cause 8 of the 2026-11-09 report): the
 * picture's "控台在不在跟", written like `console-follow.ts`. "Shown as fine" needs a reading of OBS: what cannot be read
 * is "无法确认" with its reason, never fine. Someone switching the program scene in OBS by hand (or another plugin doing
 * it) is a takeover (2026-11-10 decision 5): a waiting state, not a failure.
 */

/** What the status shows: `checking` until the first comparison, `not-following` after two misses in a row,
 * `taken-over` while the program scene was switched in OBS and the timeline has not moved on to its next segment. */
export type PictureFollow = { state: 'unknown' | 'checking' | 'following' | 'not-following' | 'taken-over'; detail: string; misses: number };

export const PICTURE_FOLLOW_START: PictureFollow = { state: 'checking', detail: '正在读回 OBS 的画面', misses: 0 };
/** A part of the picture switched this recently is not judged: OBS may still be carrying it out. */
export const PICTURE_FOLLOW_SETTLE_MS = 1000;
/** Misses in a row before "not following" is shown: one reading can fall between a switch and OBS showing it. */
export const PICTURE_FOLLOW_MISSES = 2;
/** A material this far off the music is out of step (the drift tolerance of the material scenes). */
export const PICTURE_DRIFT_TOLERANCE_MS = 300;
/** Material decoders read at most per reading; with more on air they take turns. */
export const PICTURE_READ_DECODERS = 4;

/** What a reading is compared with. `programScene`: the scene that should be on program, null when it is not judged
 * this time (`programWait` says why); `takenOver`: the scene switched to by hand, while that takeover lasts;
 * `decoders`: the materials that should be on air, each playing or paused with the music. */
export type PictureFollowTarget = {
  programScene: string | null; programWait: string | null; takenOver: string | null;
  decoders: readonly { sourceName: string; assetName: string; mode: 'playing' | 'paused' }[];
};

/** One material's decoder as OBS reported it. `absent`: nothing of this material is on air in OBS's media scenes.
 * `driftMs`: how far its position is ahead (positive) or behind the music, while it plays; null otherwise. */
export type DecoderReading = { sourceName: string; state: 'playing' | 'paused' | 'stopped' | 'ended' | 'opening' | 'error' | 'absent' | 'other'; driftMs: number | null };
/** Whether the scene on program carries the console's own music item (directly or one nested scene down): `not-used`
 * when the music does not go through that item (OBS's desktop audio carries it, or this reading did not check). */
export type MusicReading = { kind: 'carried' | 'missing' | 'not-used' } | { kind: 'unknown'; reason: string };
export type PictureReading =
  | { kind: 'unreadable'; reason: string }
  | { kind: 'read'; programScene: string; transitioning: boolean; decoders: readonly DecoderReading[]; music: MusicReading };

export type PictureFollowVerdict =
  | { kind: 'wait'; reason: string }
  | { kind: 'unknown'; reason: string }
  | { kind: 'taken-over'; detail: string }
  | { kind: 'judged'; following: boolean; detail: string };

const STATE_TEXT: Record<DecoderReading['state'], string> = { playing: '在播', paused: '停着', stopped: '已经停止', ended: '已经播完',
  opening: '还在打开', error: '出错了', absent: '不在画面上', other: '状态不明' };

/** Where a material should be when the music is at `musicMs`: its start offset plus the time since its start. */
export function materialPositionMs(startOffsetMs: number, startMs: number, musicMs: number): number {
  return startOffsetMs + Math.max(0, musicMs - startMs);
}

/** A program scene change OBS reported is a hand switch when it is neither the scene the timeline wants nor the one
 * this song last put on program. Nothing wanted (before the first camera): never a takeover. */
export function isHandSwitch(sceneName: string, wanted: string | null, ours: string | null): boolean {
  return wanted !== null && sceneName !== wanted && sceneName !== ours;
}

/** The materials read back that are out of step with the music while they play. */
export function driftedDecoders(target: PictureFollowTarget, reading: PictureReading): { sourceName: string; driftMs: number }[] {
  if (reading.kind !== 'read') return [];
  return target.decoders.flatMap(wanted => {
    const read = reading.decoders.find(entry => entry.sourceName === wanted.sourceName);
    return wanted.mode === 'playing' && read?.state === 'playing' && read.driftMs !== null && Math.abs(read.driftMs) >= PICTURE_DRIFT_TOLERANCE_MS
      ? [{ sourceName: wanted.sourceName, driftMs: Math.round(read.driftMs) }] : [];
  });
}

/** What one reading says against the target. A transition in progress is not judged; while taken over the program
 * is the hand switch's (the materials are still reconciled, so a drift is still corrected). */
export function pictureFollowVerdict(target: PictureFollowTarget, reading: PictureReading): PictureFollowVerdict {
  if (reading.kind === 'unreadable') return { kind: 'unknown', reason: `读不到 OBS 现在的画面：${reading.reason}` };
  if (target.takenOver !== null) return { kind: 'taken-over', detail: `有人在 OBS 里切到了「${reading.transitioning ? target.takenOver : reading.programScene}」，联动台不切回去；到下一段画面按时间线照常切换` };
  if (reading.transitioning) return { kind: 'wait', reason: 'OBS 正在转场，转场完了再核对' };
  const misses: string[] = [];
  if (target.programScene !== null && reading.programScene !== target.programScene)
    misses.push(`OBS 现在播的是「${reading.programScene}」，按时间线这时应该是「${target.programScene}」`);
  for (const wanted of target.decoders) {
    const read = reading.decoders.find(entry => entry.sourceName === wanted.sourceName);
    const state = read?.state ?? 'absent', name = `素材“${wanted.assetName}”`;
    if (wanted.mode === 'paused') {
      if (state === 'playing') misses.push(`${name}还在播，音乐停着它应该暂停`);
      else if (state !== 'paused') misses.push(`${name}在 OBS 里${STATE_TEXT[state]}，按时间线这时应该停在当前位置`);
    } else if (state !== 'playing') misses.push(`${name}在 OBS 里${STATE_TEXT[state]}，按时间线这时应该在播`);
    else if (read?.driftMs !== null && read?.driftMs !== undefined && Math.abs(read.driftMs) >= PICTURE_DRIFT_TOLERANCE_MS)
      misses.push(`${name}和音乐差了 ${Math.round(Math.abs(read.driftMs))} ms`);
  }
  if (misses.length) return { kind: 'judged', following: false, detail: misses.join('；') };
  if (reading.music.kind === 'unknown') return { kind: 'unknown', reason: `无法确认「${reading.programScene}」里有没有联动台的音乐：${reading.music.reason}` };
  if (target.programScene === null && !target.decoders.length) return { kind: 'wait', reason: target.programWait ?? '这时没有要核对的画面' };
  const parts = [target.programScene !== null ? `OBS 在播「${target.programScene}」，和时间线一致` : null,
    target.decoders.length ? `${target.decoders.length} 段素材跟着音乐` : null].filter((part): part is string => part !== null);
  return { kind: 'judged', following: true, detail: parts.join('，') };
}

/** The next state after one verdict. A wait keeps a following or not-following conclusion; before one (still checking,
 * after "cannot confirm", or once a takeover ended) it says what is waited for. */
export function nextPictureFollow(previous: PictureFollow, verdict: PictureFollowVerdict): PictureFollow {
  switch (verdict.kind) {
    case 'wait': return previous.state === 'following' || previous.state === 'not-following' ? previous
      : { state: 'checking', detail: verdict.reason, misses: previous.misses };
    case 'unknown': return { state: 'unknown', detail: verdict.reason, misses: 0 };
    case 'taken-over': return { state: 'taken-over', detail: verdict.detail, misses: 0 };
    case 'judged': {
      if (verdict.following) return { state: 'following', detail: verdict.detail, misses: 0 };
      const misses = previous.misses + 1;
      return misses >= PICTURE_FOLLOW_MISSES ? { state: 'not-following', detail: verdict.detail, misses }
        : { ...previous, state: previous.state === 'unknown' || previous.state === 'taken-over' ? 'checking' : previous.state, misses };
    }
  }
}

/** The red text when the scene on program would not carry the music to the audience. */
export function musicMissingText(sceneName: string): string {
  return `当前场景「${sceneName}」里没有联动台的音乐，观众听不到歌。请在 OBS 里切回联动台的场景，或者在这个场景里加上「团播联动台·内部正式音频」`;
}
