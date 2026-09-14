export function formatRuntimeTimecode(value: { hours: number; minutes: number; seconds: number; frames: number } | null): string {
  if (!value) return '00:00:00:00';
  return [value.hours, value.minutes, value.seconds, value.frames].map((part) => String(part).padStart(2, '0')).join(':');
}

export function mtcDevicePresentation(value: {
  runtimeState: string;
  detectedFrameRate: string | null;
  lastMtcAt: number | null;
  now: number;
}): { state: 'running' | 'notRunning' | 'error'; detail: string } {
  if (value.runtimeState === 'timecodeLost') {
    return {
      state: 'error',
      detail: value.detectedFrameRate ? `${value.detectedFrameRate} · 已丢失` : '已丢失'
    };
  }
  const age = value.lastMtcAt === null ? null : value.now - value.lastMtcAt;
  const updating = age !== null && age >= 0 && age <= 500;
  return updating
    ? { state: 'running', detail: value.detectedFrameRate ?? '检测中' }
    : { state: 'notRunning', detail: '无信号' };
}
