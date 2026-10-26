import { requestMidiAccess, type MidiInput } from './midi-access';
export class PlaybackMidiInput {
  private input: { port: MidiInput; unsubscribe: () => void } | null = null;
  private generation = 0;
  constructor(private readonly receive: (bytes: Uint8Array) => void, private readonly fail: (message: string) => void) {}
  async connect(portName: string): Promise<void> {
    this.dispose(); const generation = this.generation;
    const access = await requestMidiAccess();
    if (generation !== this.generation) return;
    const matches = [...access.inputs.values()].filter((port) => port.name === portName && port.state === 'connected');
    const input = matches[0];
    if (matches.length !== 1 || !input) throw new Error(`播放控制 MIDI 输入不存在或名称不唯一：${portName}`);
    await input.open();
    if (generation !== this.generation) { void input.close().catch((error: unknown) => console.error(`MIDI 接口「${portName}」关闭失败`, error)); return; }
    const unsubscribeMessages = input.onMessage(message => this.receive(message.data));
    const unsubscribeState = input.onStateChange(() => {
      if (this.input?.port !== input) return;
      if (input.state === 'disconnected') this.fail('播放控制 MIDI 输入已断开');
      else if (input.connection === 'closed') this.fail(input.closedReason ?? '播放控制 MIDI 输入已关闭');
      else return;
      this.dispose();
    });
    this.input = { port: input, unsubscribe: () => { unsubscribeMessages(); unsubscribeState(); } };
  }
  dispose(): void {
    this.generation += 1;
    const input = this.input; this.input = null;
    if (!input) return;
    input.unsubscribe();
    void input.port.close().catch((error: unknown) => console.error(`MIDI 接口「${input.port.name}」关闭失败`, error));
  }
}
