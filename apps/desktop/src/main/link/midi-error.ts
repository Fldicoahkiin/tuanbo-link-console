/** 4 (allocated) and 7 (no memory): a single-client USB MIDI driver refuses a second opener with one of these. */
export function midiPortBusy(code: number): boolean { return code === 4 || code === 7; }

/** What a Windows MIDI open failure means for the operator: what happened, then what to do. */
export function midiErrorMessage(code: number, portName: string): string {
  const port = `MIDI 接口「${portName}」`;
  if (midiPortBusy(code)) return `${port}正被其他软件占用（错误码 ${code}）。请关闭 P1 等正在使用它的软件后再试。`;
  if (code === 2 || code === 5 || code === 6 || code === -2) return `${port}没有连接（错误码 ${code}）。请检查 USB 线和驱动。`;
  if (code === -3) return `电脑上有多个叫「${portName}」的 MIDI 接口，分不清用哪个。请拔掉多余的一个。`;
  if (code === -5) return `${port}在打开的同时换成了别的设备。请重新插好后再试。`;
  return `${port}打不开（Windows 错误 ${code}）。请重新插拔接口后再试。`;
}

/** The same output is set for two uses of one playback; a single-client driver lets only one of them open it. */
export function sharedPortMessage(portName: string, owner: string, others: readonly string[]): string {
  return `MIDI 接口「${portName}」同时设成了${[...new Set([...others, owner])].join('、')}的输出，但它一次只能给一处用。请到 设置 → 音频与 MIDI 给它们选不同的接口。`;
}
