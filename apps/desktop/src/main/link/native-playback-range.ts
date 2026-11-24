export function playableEndMs(input: { startMs: number; endMs: number; availableMs: number; frameRate: number }): number {
  const { startMs, endMs, availableMs } = input;
  if (endMs <= availableMs) return endMs;
  if (availableMs > startMs) return availableMs;
  throw new Error(`这首歌要播到 ${seconds(endMs)} 秒，但解码出的音频只有 ${seconds(availableMs)} 秒。请在编辑器里把结尾往前调，或重新导入这首歌的音频`);
}

/** The words for an engine that refused a playback range; the numbers go to the log with it. */
export function rangeRejectedMessage(input: { startMs: number; endMs: number; availableMs: number; streaming: boolean; code: number }): string {
  return `播放引擎没有接受这段播放范围：从 ${seconds(input.startMs)} 秒播到 ${seconds(input.endMs)} 秒，音频有 ${seconds(input.availableMs)} 秒`
    + `（${input.streaming ? '边解码边播' : '用已解码的缓存'}，错误码 ${input.code}）。请重新播放；还是不行请导出诊断包发给售后`;
}

function seconds(ms: number): string { return (ms / 1000).toFixed(3); }
