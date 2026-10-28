/** Decoded audio may come out this many frames short of the declared length and still count as complete (about 1 ms). */
export function decodeToleranceFrames(sampleRate: number): number {
  return Math.floor(sampleRate / 1000);
}

/**
 * Where playback stops. The engine refuses an end past the decoded audio, so a program end that runs past it
 * by no more than one timecode frame (a P1 trim such as 27466.7 ms, a container length rounded to 10 ms)
 * stops at the end of the audio instead. More than that is a real mismatch and is reported with both numbers.
 */
export function playableEndMs(input: { startMs: number; endMs: number; availableMs: number; frameRate: number }): number {
  const { startMs, endMs, availableMs, frameRate } = input;
  if (endMs <= availableMs) return endMs;
  if (endMs - availableMs <= 1000 / frameRate && availableMs > startMs) return availableMs;
  throw new Error(`这首歌要播到 ${seconds(endMs)} 秒，但解码出的音频只有 ${seconds(availableMs)} 秒。请在编辑器里把结尾往前调，或重新导入这首歌的音频`);
}

/** The words for an engine that refused a playback range; the numbers go to the log with it. */
export function rangeRejectedMessage(input: { startMs: number; endMs: number; availableMs: number; streaming: boolean; code: number }): string {
  return `播放引擎没有接受这段播放范围：从 ${seconds(input.startMs)} 秒播到 ${seconds(input.endMs)} 秒，音频有 ${seconds(input.availableMs)} 秒`
    + `（${input.streaming ? '边解码边播' : '用已解码的缓存'}，错误码 ${input.code}）。请重新播放；还是不行请导出诊断包发给售后`;
}

function seconds(ms: number): string { return (ms / 1000).toFixed(3); }
