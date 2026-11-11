/** AUDCLNT_E_DEVICE_INVALIDATED: the output device was unplugged, disabled or replaced as default. */
const AUDIO_DEVICE_GONE = -2004287484;

/** What a playback engine audio error means for the operator: what happened, then what to do. The code stays for the log.
 * A dropout is not one of them: the engine counts it and plays on (2026-11-10 decision 2; native-player-service carryOn). */
export function audioErrorMessage(code: number): string {
  if (code === AUDIO_DEVICE_GONE) return `声卡输出设备不见了：可能被拔掉、禁用或换了默认设备（错误码 ${code}）。请检查声卡后重新播放`;
  if (code === 0) return '播放引擎报告出错，但没有给出错误码。请重新播放';
  return `Windows 音频错误 ${code}`;
}
