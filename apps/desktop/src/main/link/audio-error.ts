/** AUDCLNT_E_BUFFER_ERROR: the engine found the sound card empty mid-song, or its own buffer ran dry. */
const AUDIO_STARVED = -2004287464;
/** AUDCLNT_E_DEVICE_INVALIDATED: the output device was unplugged, disabled or replaced as default. */
const AUDIO_DEVICE_GONE = -2004287484;

/** What a playback engine audio error means for the operator: what happened, then what to do. The code stays for the log. */
export function audioErrorMessage(code: number): string {
  if (code === AUDIO_STARVED) return `声音断了一下：送往声卡的音频没跟上，这首歌已停下（错误码 ${code}）。重新播放即可；经常出现时请关掉占用电脑的程序，或换一个声卡输出`;
  if (code === AUDIO_DEVICE_GONE) return `声卡输出设备不见了：可能被拔掉、禁用或换了默认设备（错误码 ${code}）。请检查声卡后重新播放`;
  if (code === 0) return '播放引擎报告出错，但没有给出错误码。请重新播放';
  return `Windows 音频错误 ${code}`;
}
