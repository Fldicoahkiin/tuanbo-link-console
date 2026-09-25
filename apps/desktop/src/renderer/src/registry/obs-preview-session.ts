import type { LinkDesktopApi } from '@tb/core/link';

type PreviewApi = Pick<LinkDesktopApi, 'getObsLiveFrame' | 'closeObsLivePreview'>;
type Frame = Awaited<ReturnType<PreviewApi['getObsLiveFrame']>>;

/** Canvas and connection checks share one stream; the last consumer releases it. */
export class ObsPreviewSession {
  private consumers = 0;
  private pending: Promise<Frame> | null = null;
  private closing: Promise<void> = Promise.resolve();

  constructor(private readonly api: PreviewApi) {}

  open(): { next: () => Promise<Frame>; close: () => Promise<void> } {
    this.consumers++;
    let released = false;
    return {
      next: async () => {
        await this.closing;
        if (released) throw new Error('预览请求已取消');
        if (!this.pending) {
          const request = this.api.getObsLiveFrame().finally(() => {
            if (this.pending === request) this.pending = null;
          });
          this.pending = request;
        }
        return this.pending;
      },
      close: async () => {
        if (released) return;
        released = true;
        this.consumers--;
        if (this.consumers !== 0) return;
        const pending = this.pending;
        const closing = this.closing.then(async () => {
          // The requester receives frame failures; teardown waits for settlement only.
          if (pending) await pending.then(() => undefined, () => undefined);
          if (this.consumers === 0) await this.api.closeObsLivePreview();
        });
        // Report close failures to the releasing consumer, without poisoning a new session.
        this.closing = closing.then(() => undefined, () => undefined);
        await closing;
      }
    };
  }
}
