import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ma2LiveSnapshotSchema, type Ma2LiveSnapshot } from '@tb/schema';

const text = z.object({ t: z.string().optional() });
const rawButton = z.object({ id: z.number().int().min(0).max(2), t: z.string(), s: z.boolean().optional() });
const rawFader = z.object({ v: z.number().finite(), min: z.number().finite(), max: z.number().finite(), tt: z.string().optional(), vT: z.string().optional() });
const rawItem = z.object({
  iExec: z.number().int().min(0).max(89), combinedItems: z.number().int().min(1).max(5), tt: text, oType: text, oI: text,
  isRun: z.number().int(), cues: z.object({ items: z.array(text).optional() }),
  executorBlocks: z.array(z.object({ button1: rawButton.optional(), button2: rawButton.optional(), button3: rawButton.optional(), fader: rawFader.optional() })).max(5)
});
const responseSchema = z.object({
  responseType: z.literal('playbacks'), responseSubType: z.literal(2), iPage: z.number().int(),
  accessDenied: z.boolean().optional(), itemGroups: z.array(z.object({ itemsType: z.literal(2), items: z.array(z.array(rawItem)) }))
});
export function parseMa2LivePlayback(value: unknown, page: number, start: number): Ma2LiveSnapshot {
  const response = responseSchema.parse(value);
  if (response.accessDenied) throw new Error('控台用户没有推杆播放权限');
  if (response.iPage !== page) throw new Error('控台返回了其他页面的数据，这次没有使用');
  const items = response.itemGroups.flatMap(group => group.items.flat()).map(item => ({
    slot: item.iExec + 1, width: item.combinedItems, name: item.tt.t ?? '', objectType: item.oType.t ?? '', objectNumber: item.oI.t ?? '',
    running: item.isRun !== 0, cue: item.cues.items?.[1]?.t?.trim() ?? '',
    blocks: item.executorBlocks.map((block, index) => ({
      slot: item.iExec + index + 1,
      fader: block.fader && block.fader.max > block.fader.min ? { value: block.fader.v, min: block.fader.min, max: block.fader.max, name: block.fader.tt ?? '', text: block.fader.vT ?? '' } : null,
      buttons: [block.button1, block.button2, block.button3].flatMap(button => button ? [{ id: button.id, name: button.t, active: button.s ?? false }] : [])
    }))
  }));
  if (new Set(items.map(item => item.slot)).size !== items.length || items.some(item => item.slot < start || item.slot >= start + 15 || item.slot + item.width > start + 15)) throw new Error('控台返回的推杆格号与请求不一致');
  return ma2LiveSnapshotSchema.parse({ page, start, readAt: Date.now(), items });
}

const observedItem = z.object({ iExec: z.number().int().min(0).max(239), combinedItems: z.number().int().min(1).max(15).optional(), isRun: z.number().int(),
  tt: text.optional(), cues: z.object({ items: z.array(text).optional() }).optional() });
const observedResponse = z.object({
  responseType: z.literal('playbacks'), iPage: z.number().int(), accessDenied: z.boolean().optional(),
  itemGroups: z.array(z.object({ items: z.array(z.array(observedItem)) }))
});
/** The first slot of the 15 read with `slot`: fader executors 1–90 in rows of 15 from 1, button executors 101–190 from 101. */
export function ma2ObservedRange(slot: number): { start: number; buttons: boolean } {
  const buttons = slot > 100;
  const first = buttons ? 101 : 1;
  return { start: first + Math.floor((slot - first) / 15) * 15, buttons };
}
/**
 * One executor's running state and current Cue (the web remote's second cue line, as the fader view
 * reads it). Only fader executors were verified on onPC 3.7.0.5; the button executor answer is read
 * the same way and refused when its slots are not the ones asked for, so an unexpected answer reads
 * as "cannot check", never as "not running".
 */
export function parseMa2ExecutorObservation(value: unknown, page: number, slot: number): { running: boolean; cue: string; name: string } | null {
  const response = observedResponse.parse(value);
  if (response.accessDenied) throw new Error('控台用户没有推杆播放权限');
  if (response.iPage !== page) throw new Error('控台返回了其他页面的数据');
  const { start } = ma2ObservedRange(slot);
  const items = response.itemGroups.flatMap(group => group.items.flat());
  if (items.some(item => item.iExec + 1 < start || item.iExec + 1 >= start + 15)) throw new Error(`控台返回的执行器格号和请求的不一致（请求 ${page}.${start}–${start + 14}）`);
  const item = items.find(item => item.iExec + 1 <= slot && slot < item.iExec + 1 + (item.combinedItems ?? 1));
  return item ? { running: item.isRun !== 0, cue: item.cues?.items?.[1]?.t?.trim() ?? '', name: item.tt?.t ?? '' } : null;
}

/** One socket per selected console; failures stop the session and never replay controls. */
export class Ma2LivePlayback {
  private socket: WebSocket | null = null;
  private session = 0;
  private ready = false;
  private waiter: { type: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: string | null = null;
  private reading: { key: string; promise: Promise<Ma2LiveSnapshot> } | null = null;
  constructor(private readonly host: string, private readonly socketFactory = (url: string): WebSocket => new WebSocket(url)) {}
  get connected(): boolean { return this.ready && this.socket?.readyState === WebSocket.OPEN; }
  private fail(message: string): void {
    this.failure = message; this.ready = false;
    const waiter = this.waiter; this.waiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
    this.socket?.close(); this.socket = null;
  }
  close(): void { this.fail('实时推杆连接已关闭'); }
  private wait(type: string, send?: () => void): Promise<unknown> {
    if (this.waiter) return Promise.reject(new Error('实时推杆正在读取'));
    return new Promise((resolve, reject) => {
      this.waiter = { type, resolve, reject, timer: setTimeout(() => this.fail('实时推杆读取超时，请重新连接'), 2500) };
      try { send?.(); } catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); }
    });
  }
  private send(value: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) throw new Error(this.failure ?? '实时推杆未连接');
    this.socket.send(JSON.stringify({ ...value, session: this.session }));
  }
  async connect(username: string, password: string): Promise<void> {
    if (username.trim().toLowerCase() === 'administrator') throw new Error('实时推杆需要普通控台用户，请在此填写 User & Profiles Setup 中的用户');
    this.close(); this.failure = null; this.session = 0;
    const socket = this.socketFactory(`ws://${this.host}/?ma=1`); this.socket = socket;
    socket.addEventListener('error', () => { if (this.socket === socket) this.fail('无法连接实时推杆，请在控台开启 Remotes → Login Enabled'); });
    socket.addEventListener('close', () => { if (this.socket === socket) this.fail('实时推杆连接已断开，请重新连接'); });
    socket.addEventListener('message', event => {
      if (this.socket !== socket) return;
      try {
        const result = z.object({ session: z.number().int().optional(), status: z.string().optional(), responseType: z.string().optional(), result: z.boolean().optional(), accessDenied: z.boolean().optional() }).passthrough().parse(JSON.parse(String(event.data)));
        if (result.status === 'server ready') { this.send({ session: 0 }); return; }
        if (result.session !== undefined) { this.session = result.session; if (this.session <= 0) throw new Error('实时推杆连接无效，请重新连接'); }
        const waiter = this.waiter;
        if (!waiter) return;
        if (result.accessDenied) throw new Error('控台用户没有推杆播放权限');
        if (waiter.type === 'session' && this.session > 0 || result.responseType === waiter.type) {
          clearTimeout(waiter.timer); this.waiter = null; waiter.resolve(result);
        }
      } catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); }
    });
    await this.wait('session');
    const login = z.object({ result: z.boolean() }).parse(await this.wait('login', () => this.send({ requestType: 'login', username, password: createHash('md5').update(password).digest('hex') })));
    if (!login.result) { this.fail('控台拒绝登录，请检查实时推杆用户名和密码'); throw new Error(this.failure!); }
    this.ready = true;
  }
  async read(page: number, start: number): Promise<Ma2LiveSnapshot> {
    const key = `${page}:${start}`;
    if (this.reading) { if (this.reading.key === key) return this.reading.promise; await this.reading.promise; }
    const reading = { key, promise: this.readPage(page, start) }; this.reading = reading;
    try { return await reading.promise; }
    finally { if (this.reading === reading) this.reading = null; }
  }
  private async readPage(page: number, start: number): Promise<Ma2LiveSnapshot> {
    if (!this.connected) throw new Error(this.failure ?? '实时推杆未连接');
    const response = await this.wait('playbacks', () => this.send({ requestType: 'playbacks', startIndex: [start - 1], itemsCount: [15], pageIndex: page - 1, itemsType: [2], view: 2, execButtonViewMode: 2, buttonsViewMode: 2 }));
    try { return parseMa2LivePlayback(response, page, start); }
    catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  /** Read-only: one executor's state. Any failure closes this session; the caller decides what follows. */
  async observe(page: number, slot: number): Promise<{ running: boolean; cue: string; name: string } | null> {
    if (!this.connected) throw new Error(this.failure ?? '控台网页遥控未连接');
    const { start, buttons } = ma2ObservedRange(slot);
    const response = await this.wait('playbacks', () => this.send({ requestType: 'playbacks', startIndex: [start - 1], itemsCount: [15], pageIndex: page - 1,
      itemsType: [buttons ? 3 : 2], view: buttons ? 3 : 2, execButtonViewMode: 2, buttonsViewMode: 2 }));
    try { return parseMa2ExecutorObservation(response, page, slot); }
    catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  input(page: number, slot: number, action: { kind: 'fader'; value: number } | { kind: 'button'; id: number; pressed: boolean }): void {
    if (!this.connected) throw new Error(this.failure ?? '实时推杆未连接');
    this.send({ requestType: 'playbacks_userInput', execIndex: slot - 1, pageIndex: page - 1, ...(action.kind === 'fader' ? { type: 1, faderValue: action.value } : { type: 0, cmdline: '', buttonId: action.id, pressed: action.pressed, released: !action.pressed }) });
  }
}
