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
  /** "socket page.slot" for each control sent (a fader move, a key press or release), in the order sent. */
  readonly inputs: string[] = [];
  /** Answers for these pages come back for another page, which no parser accepts, while it is above 0. */
  garble: { page: number; count: number } = { page: 0, count: 0 };
  delayMs = 5;
  /** C2: while true, a new socket fails at once (the console is not reachable); `refuse`: logins are refused. */
  unreachable = false;
  refuse = false;
  /** Fader executors (items type 2) carry a fader from 0 to 1. */
  faders = false;
  private readonly opened = new Map<string, number>();
  private readonly sockets = new Map<string, WebRemoteSocket>();

  /** The newest socket opened as `name` (or `name#2` …) ends from the console's side, as a pulled cable would end it. */
  drop(name: string): void {
    const socket = [...this.sockets.values()].filter(value => value.name === name || value.name.startsWith(`${name}#`)).at(-1);
    socket?.end();
  }
  /** How many sockets were opened as `name` so far. */
  opens(name: string): number { return this.opened.get(name) ?? 0; }

  /** A Ma2LivePlayback on this console; its sockets are named `name`, then `name#2` and on. */
  playback(name: string, dropped?: (reason: string) => void): Ma2LivePlayback {
    return new Ma2LivePlayback('192.0.2.1', () => {
      const count = (this.opened.get(name) ?? 0) + 1; this.opened.set(name, count);
      const socket = new WebRemoteSocket(this, count === 1 ? name : `${name}#${count}`);
      this.sockets.set(socket.name, socket);
      if (this.unreachable) setTimeout(() => socket.dispatchEvent(new Event('error')), 0);
      else setTimeout(() => socket.message({ status: 'server ready' }), 0);
      return socket as unknown as WebSocket;
    }, dropped);
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
        cues: { items: [{ t: '' }, { t: '1 Cue' }] }, executorBlocks: [{ button1: { id: 0, t: 'Go', s: false }, ...(this.faders && type === 2 ? { fader: { v: 0, min: 0, max: 1 } } : {}) }] }];
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
    if (data.requestType === 'login') { this.console.logins.push(this.name); const result = !this.console.refuse; setTimeout(() => this.message({ session: 7, responseType: 'login', result }), 0); return; }
    if (data.requestType === 'playbacks_userInput') { const input = data as unknown as { pageIndex: number; execIndex: number }; this.console.inputs.push(`${this.name} ${input.pageIndex + 1}.${input.execIndex + 1}`); return; }
    if (data.requestType !== 'playbacks') return;
    this.console.requests.push(`${this.name} ${data.pageIndex + 1}.${(data.startIndex[0] ?? 0) + 1}`);
    setTimeout(() => this.message({ session: 7, ...this.console.answer(data) as object }), this.console.delayMs);
  }
  close(): void { this.readyState = WebSocket.CLOSED; }
  /** Closed from the console's side. */
  end(): void { if (this.readyState !== WebSocket.OPEN) return; this.readyState = WebSocket.CLOSED; this.dispatchEvent(new Event('close')); }
}
