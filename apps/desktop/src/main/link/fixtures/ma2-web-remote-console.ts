import { Ma2LivePlayback } from '../ma2-live-playback';

/**
 * A console's web remote as the real Ma2LivePlayback sees it (tests only): every socket it opens logs in, and each
 * `playbacks` request is answered after `delayMs` from what `running` says, the way onPC answers the fader view (items
 * type 2) and the Button area (items type 3). Every request is kept, by the socket that sent it.
 */
export class Ma2WebRemoteConsole {
  /** Whether "page.slot" runs; an executor not here is an empty slot. */
  readonly running = new Map<string, boolean>();
  /** "socket page.start" for each `playbacks` request, in the order sent. */
  readonly requests: string[] = [];
  readonly logins: string[] = [];
  /** Answers for these pages come back for another page, which no parser accepts, while it is above 0. */
  garble: { page: number; count: number } = { page: 0, count: 0 };
  delayMs = 5;
  private readonly opened = new Map<string, number>();

  /** A Ma2LivePlayback on this console; its sockets are named `name`, then `name#2` and on. */
  playback(name: string): Ma2LivePlayback {
    return new Ma2LivePlayback('192.0.2.1', () => {
      const count = (this.opened.get(name) ?? 0) + 1; this.opened.set(name, count);
      const socket = new WebRemoteSocket(this, count === 1 ? name : `${name}#${count}`);
      setTimeout(() => socket.message({ status: 'server ready' }), 0);
      return socket as unknown as WebSocket;
    });
  }

  /** The answer onPC gives to one `playbacks` request. */
  answer(request: { pageIndex: number; startIndex: number[]; itemsType: number[] }): unknown {
    const page = request.pageIndex + 1, start = (request.startIndex[0] ?? 0) + 1, type = request.itemsType[0] ?? 2;
    const garbled = this.garble.page === page && this.garble.count > 0;
    if (garbled) this.garble.count -= 1;
    const items = [...this.running].flatMap(([executor, running]) => {
      const [at, slot] = executor.split('.').map(Number) as [number, number];
      if (at !== page || slot < start || slot >= start + 15) return [];
      return [{ iExec: slot - 1, combinedItems: 1, isRun: running ? 1 : 0, tt: { t: `Exec ${executor}` }, oType: { t: 'Exec' }, oI: { t: '1' },
        cues: { items: [{ t: '' }, { t: '1 Cue' }] }, executorBlocks: [{ button1: { id: 0, t: 'Go', s: false } }] }];
    });
    return { responseType: 'playbacks', responseSubType: 2, iPage: garbled ? page + 1 : page, itemGroups: [{ itemsType: type, items: [items] }] };
  }
}

class WebRemoteSocket extends EventTarget {
  readyState = WebSocket.OPEN;
  constructor(private readonly console: Ma2WebRemoteConsole, readonly name: string) { super(); }
  message(value: unknown): void { if (this.readyState === WebSocket.OPEN) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  send(raw: string): void {
    const data = JSON.parse(raw) as { requestType?: string; pageIndex: number; startIndex: number[]; itemsType: number[] };
    if (!data.requestType) { setTimeout(() => this.message({ session: 7 }), 0); return; }
    if (data.requestType === 'login') { this.console.logins.push(this.name); setTimeout(() => this.message({ session: 7, responseType: 'login', result: true }), 0); return; }
    if (data.requestType !== 'playbacks') return;
    this.console.requests.push(`${this.name} ${data.pageIndex + 1}.${(data.startIndex[0] ?? 0) + 1}`);
    setTimeout(() => this.message({ session: 7, ...this.console.answer(data) as object }), this.console.delayMs);
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
}
