import { requestMidiAccess } from './midi-access';
export class PlaybackMidiInput {
  private input: MIDIInput | null = null;
  private generation = 0;
  constructor(private readonly receive: (bytes: Uint8Array) => void, private readonly fail: (message: string) => void) {}
  private readonly onMessage = (event: MIDIMessageEvent): void => { if (event.data) this.receive(event.data); };
  private readonly onState = (): void => { if (this.input?.state === 'disconnected') this.fail('播放控制 MIDI 输入已断开'); };
  async connect(portName: string): Promise<void> {
    this.dispose(); const generation = this.generation;
    const access = await requestMidiAccess({ sysex: false });
    if (generation !== this.generation) return;
    const matches = [...access.inputs.values()].filter((port) => port.name === portName && port.state === 'connected');
    const input = matches[0];
    if (matches.length !== 1 || !input) throw new Error(`播放控制的 MIDI 输入找不到，或有多个同名端口：${portName}`);
    await input.open();
    if (generation !== this.generation) return;
    this.input = input; input.addEventListener('midimessage', this.onMessage); input.addEventListener('statechange', this.onState);
  }
  dispose(): void {
    this.generation += 1;
    this.input?.removeEventListener('midimessage', this.onMessage); this.input?.removeEventListener('statechange', this.onState); this.input = null;
  }
}
