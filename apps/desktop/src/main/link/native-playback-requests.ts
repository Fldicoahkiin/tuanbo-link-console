import { nativePlayerControlSchema, nativePlayerPrepareSchema, type NativePlayerControl,
  type NativePlayerPrepare, type NativePlayerStatus } from '@tb/schema';

type Service = { prepare: (request: NativePlayerPrepare) => Promise<NativePlayerStatus>;
  control: (request: NativePlayerControl) => Promise<NativePlayerStatus> };
type Session = { request: NativePlayerPrepare; generation: number; transport: number; dispatched: boolean; cancelled: boolean; authorization: AbortController };

/** Capture request order before any asynchronous authorization. The service's
 * queue alone cannot reject a stale request which has not reached it yet. */
export class NativePlaybackRequests {
  private session: Session | null = null;
  constructor(private readonly service: () => Service,
    private readonly authorize: (channel: string, value: unknown) => Promise<void>) {}

  /** `checkFiles`: the window's request names its song files; the program's own requests pass none. */
  async prepare(value: unknown, checkFiles?: (request: NativePlayerPrepare) => Promise<void>): Promise<NativePlayerStatus> {
    const request = nativePlayerPrepareSchema.parse(value);
    if (this.session?.request.sessionId === request.sessionId && request.generation <= this.session.generation) throw new Error('播放准备请求已过期');
    this.session?.authorization.abort();
    const session: Session = { request, generation: request.generation, transport: 0, dispatched: false, cancelled: false, authorization: new AbortController() };
    this.session = session;
    await this.authorized(session, 'link:native-player-prepare', request);
    await checkFiles?.(request);
    this.requireCurrent(session, 0);
    session.dispatched = true;
    return this.service().prepare(request);
  }

  async control(value: unknown): Promise<NativePlayerStatus> {
    const request = nativePlayerControlSchema.parse(value), session = this.session;
    if (!session || request.sessionId !== session.request.sessionId || request.generation < session.generation) throw new Error('这个播放控制请求已失效');
    session.generation = request.generation;
    if (request.kind !== 'volume' && request.kind !== 'stop-mtc') {
      session.transport++; session.authorization.abort(); session.authorization = new AbortController();
    }
    const transport = session.transport;
    if (request.kind === 'stop') session.cancelled = true;
    await this.authorized(session, 'link:native-player-control', request);
    if (this.session !== session || transport !== session.transport) throw new Error('播放控制请求已被新的操作取消');
    if (!session.dispatched && request.kind === 'stop') return cancelledStatus(session, request.generation);
    if (!session.dispatched || session.cancelled && request.kind !== 'stop') throw new Error('音频还没准备好或已取消，请重新播放');
    return this.service().control(request);
  }

  private requireCurrent(session: Session, transport: number): void {
    if (this.session !== session || session.transport !== transport || session.cancelled) throw new Error('播放准备已被停止或切歌取消');
  }

  private async authorized(session: Session, channel: string, value: unknown): Promise<void> {
    const signal = session.authorization.signal;
    let cancel: (() => void) | undefined;
    try {
      await Promise.race([this.authorize(channel, value), new Promise<never>((_resolve, reject) => {
        cancel = () => reject(new Error('播放请求在排队时被取消'));
        if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true });
      })]);
    } finally { if (cancel) signal.removeEventListener('abort', cancel); }
  }
}

function cancelledStatus(session: Session, generation: number): NativePlayerStatus {
  const request = session.request, snapshot = request.snapshot;
  return { version: 1, sessionId: request.sessionId, generation, itemId: snapshot.itemId, status: 'stopped',
    positionMs: snapshot.positionMs, offsetMs: snapshot.offsetMs, sampleRate: snapshot.sampleRate,
    enginePid: null, engineTitle: null, mtcPortName: null, mtcSent: 0, audioError: null, mtcError: null,
    underruns: 0, mtcInterruptions: 0, gain: snapshot.volume, analysis: null };
}
