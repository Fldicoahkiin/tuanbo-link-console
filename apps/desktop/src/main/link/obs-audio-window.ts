/** OBS encodes each field independently before joining title:class:executable. */
function decodeWindowField(value: string): string {
  return value.replaceAll('#3A', ':').replaceAll('#22', '#');
}

/** Only for the owned process whose actual window class was verified at its
 * startup handshake. OBS's enumerated property is still checked after creation. */
export function encodeObsAudioWindow(executable: string, title: string, windowClass: string): string {
  return [title, windowClass, executable].map(value => value.replaceAll('#', '#22').replaceAll(':', '#3A')).join(':');
}

export function selectObsAudioWindow(items: readonly { itemValue?: unknown; itemEnabled?: boolean }[], executable: string, title: string): string {
  const windows = items.filter(item => {
    if (item.itemEnabled === false || typeof item.itemValue !== 'string') return false;
    const fields = item.itemValue.split(':');
    return fields.length === 3 && decodeWindowField(fields[0] ?? '') === title
      && decodeWindowField(fields[2] ?? '').toLowerCase() === executable.toLowerCase();
  });
  if (windows.length === 0) throw new Error(`OBS 未找到当前联动台音频窗口「${title}」。请保持主窗口打开，并确认 OBS 与联动台使用相同的运行权限，然后重新点击播放。`);
  if (windows.length !== 1) throw new Error(`OBS 找到 ${windows.length} 个同名音频窗口「${title}」，无法安全选择。请关闭重复实例后重新点击播放。`);
  const value = windows[0]?.itemValue;
  if (typeof value !== 'string') throw new Error('OBS 音频窗口标识无效');
  return value;
}
