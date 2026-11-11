import type { NativePlayerStatus } from '@tb/schema';

/** Only display observations are coalesced. Output services receive every clock. */
export class NativePlayerUiPublisher {
  private previous: NativePlayerStatus | null = null;
  private publishedAt = -Infinity;
  constructor(private readonly send: (status: NativePlayerStatus) => void, private readonly now = () => performance.now()) {}
  publish(status: NativePlayerStatus): void {
    const previous = this.previous, now = this.now();
    const changed = !previous || previous.sessionId !== status.sessionId || previous.generation !== status.generation
      || previous.status !== status.status || previous.itemId !== status.itemId || previous.enginePid !== status.enginePid
      || previous.audioError !== status.audioError || previous.mtcError !== status.mtcError
      || previous.mtcPortName !== status.mtcPortName || previous.underruns !== status.underruns || previous.outputFault !== status.outputFault;
    if (!changed && now - this.publishedAt < 50) return;
    this.previous = status; this.publishedAt = now; this.send(status);
  }
}
