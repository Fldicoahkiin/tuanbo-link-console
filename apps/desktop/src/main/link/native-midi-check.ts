import { nativeMidiCheckSchema, type NativeMidiCheck } from '@tb/schema';
import { NativeMidiOutput } from './native-midi-output';
import type { MidiClaim } from './midi-port-broker';

/** Opens and closes the exact WinMM endpoint without sending any messages. */
export class NativeMidiCheckService {
  private pending: Promise<void> | null = null;
  constructor(private readonly executable: string, private readonly active: () => boolean,
    private readonly create: () => Pick<NativeMidiOutput, 'open' | 'close'> = () => new NativeMidiOutput(executable, error => console.error(error.message)),
    /** Takes the output from the editor for the check. */
    private readonly claim: (portName: string) => Promise<MidiClaim | null> = () => Promise.resolve(null)) {}

  check(input: NativeMidiCheck): Promise<void> {
    const request = nativeMidiCheckSchema.parse(input);
    if (this.active()) return Promise.reject(new Error('播放中不能重新打开 MIDI 接口，请先停止播放'));
    if (this.pending) return Promise.reject(new Error('MIDI 接口正在检查，请等待完成'));
    const task = this.run(request.portName).finally(() => { if (this.pending === task) this.pending = null; });
    this.pending = task;
    return task;
  }
  private async run(name: string): Promise<void> {
    const claim = await this.claim(name);
    const output = this.create();
    let failure: Error | null = null;
    try { await output.open(name); }
    catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
    try { await output.close(); }
    catch (error) { failure = new Error(`${failure ? `${failure.message}；` : ''}接口清理失败：${String(error)}`); }
    finally { claim?.release(); }
    if (failure) throw new Error(`MIDI 接口 ${name} 检查失败：${failure.message}`);
  }
}
