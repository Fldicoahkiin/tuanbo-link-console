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
  const item = parseMa2ObservedRange(value, page, ma2ObservedRange(slot).start).find(item => item.slot <= slot && slot < item.slot + item.width);
  return item ? { running: item.running, cue: item.cue, name: item.name } : null;
}
/** One executor this check reads, with the slots it covers. */
export type Ma2ObservedItem = { slot: number; width: number; running: boolean; cue: string; name: string };
/** The 15 executors from `start` the single-executor check reads (`ma2ObservedRange`), refused as above. */
export function parseMa2ObservedRange(value: unknown, page: number, start: number): Ma2ObservedItem[] {
  const response = observedResponse.parse(value);
  if (response.accessDenied) throw new Error('控台用户没有推杆播放权限');
  if (response.iPage !== page) throw new Error('控台返回了其他页面的数据');
  const items = response.itemGroups.flatMap(group => group.items.flat());
  if (items.some(item => item.iExec + 1 < start || item.iExec + 1 >= start + 15)) throw new Error(`控台返回的执行器格号和请求的不一致（请求 ${page}.${start}–${start + 14}）`);
  return items.map(item => ({ slot: item.iExec + 1, width: item.combinedItems ?? 1, running: item.isRun !== 0, cue: item.cues?.items?.[1]?.t?.trim() ?? '', name: item.tt?.t ?? '' }));
}

const buttonItem = z.object({ iExec: z.number().int().min(0).max(239), combinedItems: z.number().int().min(1).max(15).optional(), isRun: z.number().int(),
  tt: text.optional(), oType: text.optional(), oI: text.optional(), cues: z.object({ items: z.array(text).optional() }).optional(),
  executorBlocks: z.array(z.object({ button1: rawButton.optional(), button2: rawButton.optional(), button3: rawButton.optional() }).passthrough()).max(15).optional() });
const buttonResponse = z.object({
  responseType: z.literal('playbacks'), iPage: z.number().int(), accessDenied: z.boolean().optional(),
  itemGroups: z.array(z.object({ itemsType: z.number().int().optional(), items: z.array(z.array(buttonItem)) }))
});
/** Button executors 101–190 as the web remote answered them (M7): what a key press is checked against. */
export type Ma2ButtonSnapshot = {
  page: number; start: number; readAt: number;
  items: Array<{ slot: number; width: number; name: string; objectType: string; objectNumber: string; running: boolean; cue: string; buttons: Array<{ id: number; name: string; active: boolean }> }>;
};
/** The Button area starts its rows of 15 at 101, 116, … 176. */
export const MA2_BUTTON_RANGES = [101, 116, 131, 146, 161, 176] as const;
/**
 * 15 button executors from `start`, read the way the web remote shows button executors (itemsType 3, view 3).
 * Read the same way as the fader view and the single-executor check above; only onPC 3.7.0.5's fader executors were
 * verified, so an answer for other slots than the ones asked for, or of another kind, is refused: it reads as
 * "cannot read", never as an empty or idle Button area.
 */
export function parseMa2LiveButtons(value: unknown, page: number, start: number): Ma2ButtonSnapshot {
  const response = buttonResponse.parse(value);
  if (response.accessDenied) throw new Error('控台用户没有执行器播放权限');
  if (response.iPage !== page) throw new Error('控台返回了其他页面的数据');
  if (response.itemGroups.some(group => group.itemsType !== undefined && group.itemsType !== 3)) throw new Error('控台返回的不是按钮执行器');
  const items = response.itemGroups.flatMap(group => group.items.flat()).map(item => ({
    slot: item.iExec + 1, width: item.combinedItems ?? 1, name: item.tt?.t ?? '', objectType: item.oType?.t ?? '', objectNumber: item.oI?.t ?? '',
    running: item.isRun !== 0, cue: item.cues?.items?.[1]?.t?.trim() ?? '',
    buttons: (item.executorBlocks?.[0] ? [item.executorBlocks[0].button1, item.executorBlocks[0].button2, item.executorBlocks[0].button3] : []).flatMap(button => button ? [{ id: button.id, name: button.t, active: button.s ?? false }] : [])
  }));
  if (new Set(items.map(item => item.slot)).size !== items.length || items.some(item => item.slot < start || item.slot + item.width > start + 15)) {
    throw new Error(`控台返回的 Button 区格号和请求的不一致（请求 ${page}.${start}–${start + 14}，回来的是 ${items.map(item => item.slot).join('、') || '无'}）`);
  }
  return { page, start, readAt: Date.now(), items };
}

/** The console refused this user (wrong password, an administrator user, logins off): logging in again cannot help (C2). */
export class Ma2LoginRefused extends Error {}

/**
 * One socket per selected console; failures stop the session and never replay controls.
 * Requests that wait for an answer (`read`, `observe`, `readButtons`, `peek`, `peekButtons`) take turns on one queue:
 * none is refused because another is reading. The protocol carries no request number, so a timeout closes the session
 * (a late answer would be taken for the next request's); an answer this software does not understand closes it too,
 * except for the `peek` reads, which only throw and leave the session as it is (M8: they read on a borrowed session).
 */
export class Ma2LivePlayback {
  private socket: WebSocket | null = null;
  private session = 0;
  private ready = false;
  private waiter: { type: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private failure: string | null = null;
  /** Fader pages on their way, by page and start: a second read of one shares its answer. */
  private readonly reading = new Map<string, Promise<Ma2LiveSnapshot>>();
  /** The request queue: each waits for the one before it, whatever that one's answer. */
  private line: Promise<unknown> = Promise.resolve();
  /** `dropped` is called once when this session, logged in, ends on its own (closed by the console or the network, a
   * timeout, an answer it does not understand); never for `close()` or a login that did not get through (C2). */
  constructor(private readonly host: string, private readonly socketFactory = (url: string): WebSocket => new WebSocket(url),
    private readonly dropped?: (reason: string) => void) {}
  get connected(): boolean { return this.ready && this.socket?.readyState === WebSocket.OPEN; }
  private fail(message: string, by: 'self' | 'owner' = 'self'): void {
    const was = this.ready;
    this.failure = message; this.ready = false;
    const waiter = this.waiter; this.waiter = null;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(new Error(message)); }
    this.socket?.close(); this.socket = null;
    if (was && by === 'self') this.dropped?.(message);
  }
  close(): void { this.fail('实时推杆连接已关闭', 'owner'); }
  /** Runs `request` after every request queued before it. */
  private turn<T>(request: () => Promise<T>): Promise<T> {
    const result = this.line.then(request, request);
    this.line = result.then(() => undefined, () => undefined);
    return result;
  }
  private wait(type: string, send?: () => void): Promise<unknown> {
    // Never reached through `turn`: kept as the guard that one request waits at a time.
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
    if (username.trim().toLowerCase() === 'administrator') throw new Ma2LoginRefused('实时推杆需要普通控台用户，请在此填写 User & Profiles Setup 中的用户');
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
    if (!login.result) { this.fail('控台拒绝登录，请检查实时推杆用户名和密码'); throw new Ma2LoginRefused(this.failure!); }
    this.ready = true;
  }
  async read(page: number, start: number): Promise<Ma2LiveSnapshot> {
    const key = `${page}:${start}`;
    // The same page already on its way: its answer is shared.
    const shared = this.reading.get(key);
    if (shared) return shared;
    const reading = this.turn(() => this.readPage(page, start)); this.reading.set(key, reading);
    try { return await reading; }
    finally { if (this.reading.get(key) === reading) this.reading.delete(key); }
  }
  private async readPage(page: number, start: number): Promise<Ma2LiveSnapshot> {
    if (!this.connected) throw new Error(this.failure ?? '实时推杆未连接');
    const response = await this.wait('playbacks', () => this.send({ requestType: 'playbacks', startIndex: [start - 1], itemsCount: [15], pageIndex: page - 1, itemsType: [2], view: 2, execButtonViewMode: 2, buttonsViewMode: 2 }));
    try { return parseMa2LivePlayback(response, page, start); }
    catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); throw cause; }
  }
  /** Read-only: one executor's state. Any failure closes this session; the caller decides what follows. */
  /** The 15 executors from `start` as the single-executor check asks for them. */
  private observed(page: number, start: number, buttons: boolean): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error(this.failure ?? '控台网页遥控未连接'));
    return this.wait('playbacks', () => this.send({ requestType: 'playbacks', startIndex: [start - 1], itemsCount: [15], pageIndex: page - 1,
      itemsType: [buttons ? 3 : 2], view: buttons ? 3 : 2, execButtonViewMode: 2, buttonsViewMode: 2 }));
  }
  /** Read-only: one executor's state. Any failure closes this session; the caller decides what follows. */
  observe(page: number, slot: number): Promise<{ running: boolean; cue: string; name: string } | null> {
    return this.turn(async () => {
      const { start, buttons } = ma2ObservedRange(slot);
      const response = await this.observed(page, start, buttons);
      try { return parseMa2ExecutorObservation(response, page, slot); }
      catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    });
  }
  /** Read-only, on a session borrowed from its owner (M8): the 15 fader executors from `start`, asked as `observe` asks.
   * An answer it does not understand only throws; the session stays as it is. A timeout still closes it. */
  peek(page: number, start: number): Promise<Ma2ObservedItem[]> {
    return this.turn(async () => parseMa2ObservedRange(await this.observed(page, start, false), page, start));
  }
  private buttonsAnswer(page: number, start: number): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error(this.failure ?? '控台网页遥控未连接'));
    if (!MA2_BUTTON_RANGES.some(value => value === start)) return Promise.reject(new Error('Button 区读取范围无效'));
    return this.wait('playbacks', () => this.send({ requestType: 'playbacks', startIndex: [start - 1], itemsCount: [15], pageIndex: page - 1,
      itemsType: [3], view: 3, execButtonViewMode: 2, buttonsViewMode: 2 }));
  }
  /** Button executors `start`–`start+14` (M7). Any failure closes this session: it is the Button area's own. */
  readButtons(page: number, start: number): Promise<Ma2ButtonSnapshot> {
    return this.turn(async () => {
      const response = await this.buttonsAnswer(page, start);
      try { return parseMa2LiveButtons(response, page, start); }
      catch (cause) { this.fail(cause instanceof Error ? cause.message : String(cause)); throw cause; }
    });
  }
  /** As `readButtons`, for the lights-off read-back (M8): an answer it does not understand only throws. */
  peekButtons(page: number, start: number): Promise<Ma2ButtonSnapshot> {
    return this.turn(async () => parseMa2LiveButtons(await this.buttonsAnswer(page, start), page, start));
  }
  input(page: number, slot: number, action: { kind: 'fader'; value: number } | { kind: 'button'; id: number; pressed: boolean }): void {
    if (!this.connected) throw new Error(this.failure ?? '实时推杆未连接');
    this.send({ requestType: 'playbacks_userInput', execIndex: slot - 1, pageIndex: page - 1, ...(action.kind === 'fader' ? { type: 1, faderValue: action.value } : { type: 0, cmdline: '', buttonId: action.id, pressed: action.pressed, released: !action.pressed }) });
  }
}
