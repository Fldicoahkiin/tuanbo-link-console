/** Permission rejection also covers the desktop's isolated driver health check. */
export async function requestMidiAccess(options: MIDIOptions): Promise<MIDIAccess> {
  try { return await navigator.requestMIDIAccess(options); }
  catch (error) {
    if (error instanceof Error && (error.name === 'NotAllowedError' || /permission denied/i.test(error.message))) {
      throw new Error('MIDI 设备检测未通过。请检查 Windows MIDI 服务和设备连接，再到“音频与 MIDI”重新检测。依赖 MIDI 的播放暂不可用，工程仍可编辑。', { cause: error });
    }
    throw error;
  }
}
