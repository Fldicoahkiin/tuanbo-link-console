import { nativeObsNextSchema, nativeObsPrepareSchema, nativeObsRetargetSchema, nativeObsStopSchema, type NativeObsNext, type NativeObsPrepare, type NativeObsRetarget, type NativeObsStop, type NativeObsStatus } from '@tb/schema';

type Service = { prepare(request: NativeObsPrepare): Promise<NativeObsStatus>; stopOwned(request: NativeObsStop): Promise<void>;
  prepareNext(request: NativeObsNext): Promise<void>; retarget(request: NativeObsRetarget): void };
type Pending = { request: NativeObsPrepare; cancelled: boolean; dispatched: boolean };

/** Capture intent before asynchronous license checks. Cancellation is tied to
 * the preparation identity, and cannot operate on a later song. */
export class NativeObsRequests {
  private current: Pending | null = null;
  constructor(private readonly service: Service, private readonly authorize: (value: NativeObsPrepare) => Promise<void>) {}

  /** `checkFiles`: the window's request names its media files; the program's own requests pass none. */
  async prepare(value: unknown, checkFiles?: (request: NativeObsPrepare) => Promise<void>): Promise<NativeObsStatus> {
    const request = nativeObsPrepareSchema.parse(value);
    if (this.current?.request.sessionId === request.sessionId && request.generation <= this.current.request.generation) {
      throw new Error('画面准备请求已过期');
    }
    const pending: Pending = { request, cancelled: false, dispatched: false };
    this.current = pending;
    await this.authorize(request);
    await checkFiles?.(request);
    if (this.current !== pending || pending.cancelled) throw new Error('画面准备在排队时被取消');
    pending.dispatched = true;
    return this.service.prepare(request);
  }

  /** The next song prepared again while this picture runs (0.5.9 S8b). Bound to the same preparation as a stop; it starts
   * no output, so no license check of its own. */
  async next(value: unknown): Promise<void> {
    const request = nativeObsNextSchema.parse(value), pending = this.current;
    if (!pending || pending.request.sessionId !== request.sessionId || pending.request.generation !== request.generation || !pending.dispatched || pending.cancelled) {
      throw new Error('下一首的画面准备请求已过期');
    }
    await this.service.prepareNext(request);
  }

  /** A newer version of the held song's picture plan (0.5.9 R9), for the preparation that went out and was not stopped.
   * It starts no output, so no license check of its own. */
  retarget(value: unknown): void {
    const request = nativeObsRetargetSchema.parse(value), pending = this.current;
    if (!pending || pending.request.sessionId !== request.sessionId || !pending.dispatched || pending.cancelled) {
      throw new Error('这一版画面来晚了，这首歌的画面已经换了或停了，没有用上');
    }
    this.service.retarget(request);
  }

  async stop(value: unknown): Promise<void> {
    const request = nativeObsStopSchema.parse(value), pending = this.current;
    if (!pending || pending.request.sessionId !== request.sessionId || pending.request.generation !== request.generation) {
      throw new Error('这是上一次准备的停止请求，已忽略');
    }
    pending.cancelled = true;
    if (pending.dispatched) await this.service.stopOwned(request);
  }
}
