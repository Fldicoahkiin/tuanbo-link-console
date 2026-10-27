import type { NativePlayerStatus } from '@tb/schema';

/** The song's timecode output as already shown: the error that turned it red, the recovery already announced. */
export type TimecodeOutputMemory = { error: string | null; recoveredAt: string | null };
export const idleTimecodeOutput: TimecodeOutputMemory = { error: null, recoveredAt: null };

/**
 * What one engine status changes for the song's timecode output. A new error turns it red once.
 * When the same port came back and timecode resumed (authorised 2026-10-24), that red is cleared
 * if it is still the one shown, and the recovery is announced once.
 */
export function timecodeOutputChange(memory: TimecodeOutputMemory, status: Pick<NativePlayerStatus, 'mtcError' | 'mtcRecovered'>, fault: string | null | undefined): {
  memory: TimecodeOutputMemory; fault: string | null; clearFault: boolean; notice: string | null;
} {
  const recovered = status.mtcRecovered;
  if (recovered && recovered.recoveredAt !== memory.recoveredAt) {
    return { memory: { error: null, recoveredAt: recovered.recoveredAt }, fault: null,
      clearFault: memory.error !== null && fault === timecodeFault(memory.error),
      notice: `时间码中断 ${(recovered.durationMs / 1000).toFixed(1)} 秒后已恢复（${recovered.portName}）` };
  }
  if (status.mtcError && status.mtcError !== memory.error) {
    return { memory: { ...memory, error: status.mtcError }, fault: timecodeFault(status.mtcError), clearFault: false, notice: null };
  }
  return { memory, fault: null, clearFault: false, notice: null };
}

function timecodeFault(error: string): string { return `时间码没有发出，音频照常播放。原因：${error}`; }
