import { nativeObsPrepareSchema, nativeObsStopSchema, type NativeObsPrepare, type NativeObsStop, type NativeObsStatus } from '@tb/schema';

type Service = { prepare(request: NativeObsPrepare): Promise<NativeObsStatus>; stopOwned(request: NativeObsStop): Promise<void> };
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
      throw new Error('后台画面准备请求已过期');
    }
    const pending: Pending = { request, cancelled: false, dispatched: false };
    this.current = pending;
    await this.authorize(request);
    await checkFiles?.(request);
    if (this.current !== pending || pending.cancelled) throw new Error('后台画面准备在等待许可时已取消');
    pending.dispatched = true;
    return this.service.prepare(request);
  }

  async stop(value: unknown): Promise<void> {
    const request = nativeObsStopSchema.parse(value), pending = this.current;
    if (!pending || pending.request.sessionId !== request.sessionId || pending.request.generation !== request.generation) {
      throw new Error('后台画面停止请求属于旧准备会话');
    }
    pending.cancelled = true;
    if (pending.dispatched) await this.service.stopOwned(request);
  }
}
