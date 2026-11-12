import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ma2ExecutorFunctions, type LightingReadBack } from '@tb/core/link';
import { ma2ExecutorInputSchema, type Ma2ExecutorChannel, type Ma2ExecutorInput, type Ma2LayoutDirectoryRequest, type Ma2NetworkTarget } from '@tb/schema';
import { ma2ButtonLiveRequestSchema, type Ma2ButtonLive, type Ma2ButtonLiveRequest, type Ma2WebRemoteSession, type Ma2WebRemoteState } from '@tb/schema';
import { ma2ExecutorObserveRequestSchema, ma2LiveConnectSchema, ma2LiveInputSchema, ma2LiveRequestSchema, type Ma2ExecutorObservation, type Ma2ExecutorObserveRequest, type Ma2LiveConnect, type Ma2LiveInput, type Ma2LiveRequest, type Ma2LiveSnapshot } from '@tb/schema';
import type { SecureProfileStore } from './secure-profile-store';
import type { Ma2Telnet } from './ma2-telnet';
import { writeFileAtomically } from './atomic-file';
import { verifyMa2ShowSource, type Ma2ShowSource } from './ma2-show-probe';
import { MA2_BUTTON_RANGES, Ma2LivePlayback, ma2ObservedRange, type Ma2ButtonSnapshot } from './ma2-live-playback';
import { Ma2ExecutorChannels, type Ma2ButtonAreaAnswer } from './ma2-executor-channel';
import { Ma2ReloginStop, Ma2WebRemoteRelogin, ma2ReloginReason, type Ma2ReloginLog } from './ma2-web-remote-relogin';

const profilesSchema = z.array(z.object({ host: z.ipv4(), username: z.string().min(1).max(256) }).strict()).max(128);
type ButtonSession = { client: Ma2LivePlayback; scope: string; verifiedAt: number; reads: Map<string, Ma2ButtonSnapshot>; reading: Promise<unknown> };
/** The console, Show and page the fader view is connected to. */
type FaderTarget = { network: Ma2LiveRequest['network']; expectedSource: Ma2LiveRequest['expectedSource']; page: number };
/** Why no saved user can log the web remote in again. */
const NO_SAVED_USER = '这台控台还没连过网页遥控（灯光工作台推杆页的“连接”）';
/** How old a Button area read may be when a key is checked against it, and the Show check it relies on. */
const BUTTON_READ_MS = 1000;
const BUTTON_SHOW_MS = 2000;
/** A key held on the web remote is let go when the renderer stops renewing it, as on the fader view. */
const BUTTON_HOLD_MS = 1500;
/** Why the slot the web remote reads now is not the executor the page shows, or null when what it reads agrees.
 * A field the web remote leaves empty is not compared; the Show check and the slot still are. */
function buttonMismatch(item: Ma2ButtonSnapshot['items'][number], expected: Ma2ExecutorInput['expectedItem']): string | null {
  const number = /^\s*(\d+)\s*$/.exec(item.objectNumber)?.[1];
  if (expected.sequence !== undefined && number !== undefined && Number(number) !== expected.sequence) return `控台上这一格是序列 ${number}，页面上是序列 ${expected.sequence}`;
  const name = item.name.trim(), shown = expected.name.trim();
  if (name && shown && name !== shown) return `控台上这一格叫「${name}」，页面上是「${shown}」`;
  return null;
}
/** The same console, by every field the Off names it with. */
function sameNetwork(left: Ma2NetworkTarget, right: Ma2NetworkTarget): boolean {
  return left.host === right.host && left.port === right.port && left.monitorPort === right.monitorPort && left.username === right.username;
}
/** What a press on the web remote sent, for the log while it is on trial (M7). */
export type Ma2ButtonPress = { page: number; slot: number; button: number; name: string; function: string };
/** A release came first: the same words the plugin channel uses, which the renderer knows. */
class ButtonCancelled extends Error { constructor() { super('按键已松开，已取消排队的按下'); } }
export class Ma2LiveService {
  private client: Ma2LivePlayback | null = null;
  private scope = '';
  private verifiedAt = 0;
  private snapshot: Ma2LiveSnapshot | null = null;
  private failed = false;
  /** Why the fader view stopped, for the console page. */
  private faderFailure: string | null = null;
  private generation = 0;
  private pressed = new Map<string, { page: number; slot: number; id: number }>();
  private guard: ReturnType<typeof setTimeout> | null = null;
  private opening: Promise<Ma2LiveSnapshot> | null = null;
  private observer: { client: Ma2LivePlayback; host: string } | null = null;
  private observerFailure: string | null = null;
  private readonly channels = new Ma2ExecutorChannels();
  /** The console and page the fader view is connected to now; a choice of the web remote reads that Button area. */
  private faderRequest: FaderTarget | null = null;
  private readonly reloginLogs = new Set<(entry: Ma2ReloginLog) => void>();
  /** C2: the fader view's and the Button area's sessions, when they drop, log in again on their own with the saved user. */
  private readonly faderRelogin = new Ma2WebRemoteRelogin<FaderTarget>('fader', target => this.reloginFaders(target), entry => this.reloginLog(entry));
  private readonly buttonRelogin = new Ma2WebRemoteRelogin<Ma2LayoutDirectoryRequest>('buttons', target => this.reloginButtons(target), entry => this.reloginLog(entry));
  /** The Button area's own web remote session (M7): its failures never close the fader view. */
  private buttons: ButtonSession | null = null;
  private buttonOpening: { scope: string; session: Promise<ButtonSession> } | null = null;
  /** Button area keys held on the web remote, by the renderer's press session. */
  /** Button area presses on their way (checks still running); a release marks them cancelled. */
  private pending = new Map<string, { cancelled: boolean }>();
  /** Press sessions already let go of, newest 256. */
  private ended = new Set<string>();
  private held = new Map<string, { scope: string; page: number; slot: number; button: number; id: number; guard: ReturnType<typeof setTimeout> }>();
  /** `telnet` is the logged-in Telnet line to the console this request names; it throws when that is not the one
   * connected. The Show check before a read is one short command on it, never a plugin transaction (M6). */
  constructor(private readonly path: string, private readonly secrets: Pick<SecureProfileStore, 'saveCredential' | 'loadCredential'>, private readonly telnet: (request: Pick<Ma2LiveRequest, 'network'>) => Pick<Ma2Telnet, 'command'>,
    private readonly socket: (host: string, dropped?: (reason: string) => void) => Ma2LivePlayback = (host, dropped) => new Ma2LivePlayback(host, undefined, dropped),
    private readonly faderSocket: (host: string, dropped?: (reason: string) => void) => Ma2LivePlayback = (host, dropped) => new Ma2LivePlayback(host, undefined, dropped)) {}
  private key(request: Pick<Ma2LiveRequest, 'network' | 'expectedSource'>): string { return JSON.stringify([request.network, request.expectedSource]); }
  private secret(host: string, username: string): string { return `ma2-web-${createHash('sha256').update(`${host}:${username}`).digest('hex')}`; }
  /** The saved users, read from disk once: only this service writes the file, and it keeps this copy up to date. A read
   * that fails is not kept, so the next asks the disk again. */
  private saved: Promise<z.infer<typeof profilesSchema>> | null = null;
  private profiles(): Promise<z.infer<typeof profilesSchema>> {
    const saved = this.saved ??= this.readProfiles();
    void saved.catch(() => { if (this.saved === saved) this.saved = null; });
    return saved;
  }
  private async readProfiles(): Promise<z.infer<typeof profilesSchema>> {
    try { return profilesSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  }
  /**
   * Closes every web remote session. What the console answered for its Button area, and the operator's choice, stay
   * (`ma2-executor-channel.ts`). This also closes the Button area's session: held Button keys are let go, and a press
   * still on its way is cancelled ("按键已松开，已取消排队的按下") or, when it already passed that point, fails with
   * "网页遥控连接变了". `openFaders` calls this too, so the fader view logging in again does the same; when it logs in
   * again with the saved user and the keys go on the web remote, `connectSession` opens the Button session again.
   */
  close(): void {
    this.generation += 1; this.releaseObserver();
    this.faderRelogin.stop(); this.buttonRelogin.stop();
    this.release(); this.client?.close(); this.client = null; this.snapshot = null; this.scope = ''; this.failed = false; this.faderFailure = null; this.faderRequest = null;
    this.releaseButtons(); this.buttons?.client.close(); this.buttons = null; this.buttonOpening = null;
  }
  /** Every line the logging in again writes for the run log (C2). */
  onReloginLog(listener: (entry: Ma2ReloginLog) => void): () => void {
    this.reloginLogs.add(listener);
    return () => { this.reloginLogs.delete(listener); };
  }
  private reloginLog(entry: Ma2ReloginLog): void { for (const listener of this.reloginLogs) listener(entry); }
  /** M5: the plugin sessions that the Telnet line logging in again (or the plugin installed after the show) replaced on
   * the same console and Show, each pointing at what the console says now. Kept across `close`: a page read before still
   * names the old session. */
  private readonly carriedSessions = new Map<string, string>();
  /** The Telnet line is back on the same console and Show, and the plugin's session is now `after`'s (M5, 00-order: only a
   * changed session is no reason for the web remote to stop). The web remote does not go through the plugin, so the
   * sessions here and their logging in again go on; what needs the plugin checks its own session. */
  consoleBack(before: Ma2ShowSource, after: Ma2ShowSource): void {
    if (before.show !== after.show || before.version !== after.version || before.generation === after.generation) return;
    const from = sourceKey(before), to = sourceKey(after);
    for (const [key, value] of this.carriedSessions) if (value === from) this.carriedSessions.set(key, to);
    this.carriedSessions.set(from, to);
  }
  /** Another console, or the operator disconnected: nothing carries over. */
  consoleChanged(): void { this.carriedSessions.clear(); }
  private readonly carried = (expected: Ma2ShowSource, actual: Ma2ShowSource): boolean => this.carriedSessions.get(sourceKey(expected)) === sourceKey(actual);
  /**
   * The console page's web remote sessions for this console and Show (C2): read from what is here, nothing is asked of the
   * console. A session another console or Show uses reads as idle.
   */
  webRemoteState(request: Ma2LayoutDirectoryRequest): Ma2WebRemoteState {
    const scope = this.key(request);
    const buttons = this.buttonRelogin.view(scope);
    return {
      fader: this.faderState(scope),
      buttons: buttons && buttons.kind !== 'connected' ? buttons : this.buttons?.scope === scope && this.buttons.client.connected ? { kind: 'connected' } : { kind: 'idle' }
    };
  }
  private faderState(scope: string): Ma2WebRemoteSession {
    const relogin = this.faderRelogin.view(scope);
    if (relogin && relogin.kind !== 'connected') return relogin;
    if (this.scope !== scope) return { kind: 'idle' };
    if (this.failed) return { kind: 'stopped', reason: ma2ReloginReason(this.faderFailure ?? '实时推杆已停止，请重新连接'), limit: false };
    return this.client?.connected ? { kind: 'connected' } : { kind: 'idle' };
  }
  release(): void {
    if (this.guard) clearTimeout(this.guard); this.guard = null;
    for (const button of this.pressed.values()) {
      if (this.client?.connected) this.client.input(button.page, button.slot, { kind: 'button', id: button.id, pressed: false });
    }
    this.pressed.clear();
  }
  /** `operator`: the operator pressed "连接", which reads the Button area again to choose its key channel. `saved`:
   * the fader view logged in again with the saved user; a channel already chosen for this console is kept. */
  async connect(input: Ma2LiveConnect, origin: 'operator' | 'saved' = 'operator'): Promise<Ma2LiveSnapshot> {
    if (this.opening) {
      await this.opening;
      return this.read({ network: input.network, expectedSource: input.expectedSource, page: input.page, start: input.start });
    }
    const opening = this.connectSession(input, origin); this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = null; }
  }
  private async connectSession(input: Ma2LiveConnect, origin: 'operator' | 'saved'): Promise<Ma2LiveSnapshot> {
    const snapshot = await this.openFaders(input);
    const request = ma2LiveConnectSchema.parse(input);
    const scope = this.key(request);
    const generation = this.generation;
    // With the console plugin chosen nothing more goes to the console than before M7: no Button session, no read.
    if (this.channels.chosen() !== 'webRemote') return snapshot;
    if (origin === 'operator' || !this.channels.has(scope)) await this.probeButtonArea(request, request, generation);
    else if (this.channels.forKey(scope, 101) === 'webRemote') {
      try { await this.buttonSession(request); }
      catch (error) { this.channels.failed(scope, error instanceof Error ? error.message : String(error)); }
    }
    return snapshot;
  }
  /** The fader view's own session. It starts with `close()`: Button keys held or on their way are let go (see there). */
  private async openFaders(input: Ma2LiveConnect): Promise<Ma2LiveSnapshot> {
    const request = ma2LiveConnectSchema.parse(input); this.close();
    const generation = this.generation;
    await verifyMa2ShowSource(this.telnet(request), request.expectedSource, this.carried);
    if (generation !== this.generation) throw new Error('控台连接已改变');
    const client: Ma2LivePlayback = this.faderSocket(request.network.host, reason => this.faderDropped(client, reason)); this.client = client;
    try {
      await client.connect(request.username, request.password);
      if (generation !== this.generation) throw new Error('控台连接已改变');
      const profiles = await this.profiles();
      await this.secrets.saveCredential(this.secret(request.network.host, request.username), request.password);
      const next = [...profiles.filter(profile => profile.host !== request.network.host), { host: request.network.host, username: request.username }];
      this.saved = null;
      await writeFileAtomically(this.path, JSON.stringify(next, null, 2));
      this.saved = Promise.resolve(next);
      if (generation !== this.generation) throw new Error('控台连接已改变');
      this.scope = this.key(request); this.verifiedAt = Date.now(); this.failed = false;
      const target: FaderTarget = { network: request.network, expectedSource: request.expectedSource, page: request.page }; this.faderRequest = target;
      const snapshot = await this.read(ma2LiveRequestSchema.parse({ network: request.network, expectedSource: request.expectedSource, page: request.page, start: request.start }));
      // Connected in this run: from now on a drop logs in again on its own, its counts from zero.
      if (generation === this.generation && this.client === client) this.faderRelogin.connected(this.scope, target);
      return snapshot;
    } catch (error) { client.close(); if (generation === this.generation && this.client === client) { this.failed = true; this.faderFailure = message(error); } throw error; }
  }
  /** A fader session that drops on its own: held keys are let go (nothing is sent on a closed session) and logging in again starts. */
  private faderDropped(client: Ma2LivePlayback, reason: string): void {
    if (this.client !== client) return;
    this.release(); this.failed = true; this.faderFailure = reason;
    this.faderRelogin.dropped(reason);
  }
  /**
   * The fader view logged in again on its own (C2): the saved user only, the same console and Show (a Show that changed
   * stops it), never the operator's other sessions: the Button session and the "console follows" session stay as they are,
   * and the key channel is not read again. Nothing is resent; the page's next read and move go as usual.
   */
  private async reloginFaders(target: FaderTarget): Promise<void> {
    const generation = this.generation;
    const login = await this.savedLogin(target.network.host);
    await verifyMa2ShowSource(this.telnet(target), target.expectedSource, this.carried);
    if (generation !== this.generation) throw new Error('控台连接已改变');
    const client: Ma2LivePlayback = this.faderSocket(target.network.host, reason => this.faderDropped(client, reason));
    try { await client.connect(login.username, login.password); }
    catch (error) { client.close(); throw error; }
    if (generation !== this.generation) { client.close(); throw new Error('控台连接已改变'); }
    this.client?.close(); this.client = client;
    this.snapshot = null; this.failed = false; this.faderFailure = null; this.verifiedAt = Date.now();
  }
  /** The Button session logged in again on its own (C2): only while its keys still go on the web remote, after the same Show check. */
  private async reloginButtons(target: Ma2LayoutDirectoryRequest): Promise<void> {
    if (this.channels.forKey(this.key(target), 101) !== 'webRemote') throw new Ma2ReloginStop('Button 区的按键已经不走网页遥控');
    await verifyMa2ShowSource(this.telnet(target), target.expectedSource, this.carried);
    await this.buttonSession(target);
  }
  /** The user saved for this console and its password from the secure store; neither there stops logging in again. */
  private async savedLogin(host: string): Promise<{ username: string; password: string }> {
    let profile: { host: string; username: string } | undefined;
    try { profile = (await this.profiles()).find(value => value.host === host); }
    catch (error) { throw new Ma2ReloginStop(message(error)); }
    if (!profile) throw new Ma2ReloginStop(NO_SAVED_USER);
    try { return { username: profile.username, password: await this.secrets.loadCredential(this.secret(profile.host, profile.username)) }; }
    catch (error) { throw new Ma2ReloginStop(message(error)); }
  }
  async read(input: Ma2LiveRequest): Promise<Ma2LiveSnapshot> {
    const request = ma2LiveRequestSchema.parse(input); this.telnet(request);
    if (this.failed) {
      const relogin = this.faderRelogin.view(this.key(request));
      throw new Error(relogin?.kind === 'relogin' ? `网页遥控断了，正在自动重新登录（第 ${relogin.attempt} 次）` : '实时推杆已停止，请重新连接');
    }
    if (!this.client) {
      const generation = this.generation;
      const profile = (await this.profiles()).find(value => value.host === request.network.host);
      if (!profile) throw new Error('连接实时推杆后，可显示控台当前值');
      const password = await this.secrets.loadCredential(this.secret(profile.host, profile.username));
      if (generation !== this.generation) throw new Error('控台连接已改变');
      return this.connect({ ...request, username: profile.username, password }, 'saved');
    }
    if (this.scope !== this.key(request)) { this.close(); throw new Error('控台 Show 或连接已改变，请重新读取页面'); }
    const generation = this.generation;
    const client = this.client;
    try {
      if (Date.now() - this.verifiedAt > 1000) { await verifyMa2ShowSource(this.telnet(request), request.expectedSource, this.carried); this.verifiedAt = Date.now(); }
      if (generation !== this.generation) throw new Error('控台连接已改变');
      const snapshot = await client.read(request.page, request.start);
      if (generation !== this.generation) throw new Error('控台连接已改变');
      this.snapshot = snapshot;
      if (this.pressed.size) this.armRelease();
      return snapshot;
    } catch (error) { if (generation === this.generation && this.client === client) { this.release(); client.close(); this.failed = true; this.faderFailure ??= message(error); } throw error; }
  }
  /**
   * One executor's state for the "console follows the timecode" check, on a web remote session of its
   * own: an answer this software does not understand closes only that session, never the fader view.
   * It logs in as the fader view's saved user and never sends a control. A failure stays until the next
   * song is started (`releaseObserver`); nothing is retried.
   */
  async observe(input: Ma2ExecutorObserveRequest): Promise<Ma2ExecutorObservation> {
    const request = ma2ExecutorObserveRequestSchema.parse(input);
    try { this.telnet(request); }
    catch (error) { return { kind: 'unavailable', reason: error instanceof Error ? error.message : String(error) }; }
    if (this.observerFailure) throw new Error(this.observerFailure);
    const host = request.network.host;
    if (this.observer?.host !== host) {
      this.observer?.client.close(); this.observer = null;
      const profile = (await this.profiles()).find(value => value.host === host);
      if (!profile) return { kind: 'unavailable', reason: '这台控台还没连过网页遥控（灯光工作台推杆页的“连接”）' };
      const client = this.socket(host);
      try { await client.connect(profile.username, await this.secrets.loadCredential(this.secret(profile.host, profile.username))); }
      catch (error) { client.close(); throw this.observerFailed(error); }
      this.observer = { client, host };
    }
    try {
      const executor = await this.observer.client.observe(request.page, request.slot);
      return executor ? { kind: 'executor', ...executor } : { kind: 'empty' };
    } catch (error) { this.observer?.client.close(); this.observer = null; throw this.observerFailed(error); }
  }
  releaseObserver(): void { this.observer?.client.close(); this.observer = null; this.observerFailure = null; }
  /**
   * Whether these executors ("page.slot") run now, for one round of the lights-off read-back (M8,
   * lighting-off-service.ts). Read only on a web remote session that is connected already and that this read only
   * borrows, never logging in for it, never sending a control, never on the fader view's own session (an error there lets
   * go of held keys and stops the fader view):
   * - 1–90: only on the "console follows" session for this console;
   * - above 90: only where a key at that slot goes on the web remote (`forKey`, M7: the Button area 101–190 when chosen
   *   and read back), on the Button session; 91–100 and 191 and up never do, so they are not read.
   * One request per session, page and range of 15, one after another; its answer serves every executor in that range.
   * An answer this software does not understand leaves the session as it is (`peek`); a timeout closes it, as any
   * request's does. Not read: `read: false`. With the console plugin chosen and no web remote connected, nothing goes to
   * the console. The Show is not checked: the Off went to the console that is connected, whatever its Show, and so does
   * this read.
   */
  async readBack(network: Ma2NetworkTarget, executors: readonly string[]): Promise<Map<string, LightingReadBack>> {
    const results = new Map<string, LightingReadBack>();
    const fader = this.faderRequest && sameNetwork(this.faderRequest.network, network) ? this.faderRequest : null;
    const scope = fader ? this.key(fader) : null;
    const ranges = new Map<string, { page: number; start: number; buttons: boolean; slots: { executor: string; slot: number }[] }>();
    for (const executor of executors) {
      const match = /^([1-9]\d*)\.([1-9]\d*)$/.exec(executor);
      if (!match) { results.set(executor, { verified: 'unknown', reason: '执行器编号读不了', read: false }); continue; }
      const page = Number(match[1]), slot = Number(match[2]), buttons = slot > 90;
      if (buttons && !(scope && this.channels.forKey(scope, slot) === 'webRemote')) {
        results.set(executor, { verified: 'unknown', reason: 'Button 区的按键没有走网页遥控', read: false }); continue;
      }
      const { start } = ma2ObservedRange(slot), key = `${buttons ? 'b' : 'f'}:${page}:${start}`;
      const range = ranges.get(key) ?? { page, start, buttons, slots: [] };
      range.slots.push({ executor, slot }); ranges.set(key, range);
    }
    for (const { page, start, buttons, slots } of ranges.values()) {
      const read = this.readBackRange(network, scope, buttons);
      if (!read) {
        for (const { executor } of slots) results.set(executor, { verified: 'unknown', reason: buttons ? 'Button 区的网页遥控没连着' : '“控台在不在跟”的网页遥控没连着', read: false });
        continue;
      }
      let items: { slot: number; width: number; running: boolean }[];
      try { items = await read(page, start); }
      catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        for (const { executor } of slots) results.set(executor, { verified: 'unknown', reason, read: true });
        continue;
      }
      for (const { executor, slot } of slots) {
        const item = items.find(entry => entry.slot <= slot && slot < entry.slot + entry.width);
        results.set(executor, item ? { verified: item.running ? 'running' : 'off' } : { verified: 'unknown', reason: `控台上 ${executor} 这一格是空的`, read: true });
      }
    }
    return results;
  }
  /**
   * What the console shows for one row of 15 Button executors, for the console page (C1). Read only on the Button session
   * that is connected already, through `buttonRead`, so a row is asked at most once a second however often the page and the
   * keys ask, and never logged in for: with the console plugin chosen nothing goes to the console at all, and a session that
   * is not connected says so (the next key logs it in again). An answer this software does not understand only throws
   * (`peek`): the keys keep their session. The Show is not checked: this only shows, the key's own checks still run.
   */
  async buttonLive(input: Ma2ButtonLiveRequest): Promise<Ma2ButtonLive> {
    const request = ma2ButtonLiveRequestSchema.parse(input); this.telnet(request);
    if (this.channels.chosen() !== 'webRemote') return { kind: 'off', why: 'plugin', reason: 'Button 区的按键走控台插件' };
    const scope = this.key(request);
    if (this.channels.forKey(scope, request.start) !== 'webRemote') return { kind: 'off', why: 'unverified', reason: this.channels.buttons(scope).webRemote.reason };
    const session = this.buttons?.scope === scope && this.buttons.client.connected ? this.buttons : null;
    if (!session) {
      const relogin = this.buttonRelogin.view(scope);
      if (relogin?.kind === 'relogin') return { kind: 'relogin', attempt: relogin.attempt };
      if (relogin?.kind === 'stopped') return { kind: 'off', why: 'stopped', reason: relogin.reason };
      return { kind: 'off', why: 'disconnected', reason: 'Button 区的网页遥控现在没连着' };
    }
    const read = await this.buttonRead(session, request.page, request.start, 'peek');
    return { kind: 'live', page: read.page, start: read.start, readAt: read.readAt, items: read.items.map(item => ({ slot: item.slot, width: item.width, name: item.name, objectNumber: item.objectNumber, running: item.running, cue: item.cue })) };
  }
  /** The borrowed session a read-back range goes on now, or null when it is not connected (`readBack`). */
  private readBackRange(network: Ma2NetworkTarget, scope: string | null, buttons: boolean): ((page: number, start: number) => Promise<{ slot: number; width: number; running: boolean }[]>) | null {
    if (!buttons) {
      const observer = this.observer?.host === network.host && this.observer.client.connected ? this.observer.client : null;
      return observer ? (page, start) => observer.peek(page, start) : null;
    }
    const session = scope && this.buttons?.scope === scope && this.buttons.client.connected ? this.buttons : null;
    return session ? async (page, start) => (await this.buttonRead(session, page, start, 'peek')).items : null;
  }
  private observerFailed(error: unknown): Error {
    this.observerFailure = error instanceof Error ? error.message : String(error);
    return new Error(this.observerFailure);
  }
  keyChoice(): Ma2ExecutorChannel['choice'] { return this.channels.chosen(); }
  /**
   * The operator's choice on this computer. A change lets go of every Button key held or on its way first.
   * - The web remote: when the fader view is connected now, its Button area is read here, so the answer is known when
   *   this returns; otherwise nothing is read until the web remote is connected. A read that fails is not a failed
   *   choice: the choice stays, the keys go on the plugin and the label says why.
   * - The console plugin: the Button session is closed and what was read is forgotten, so choosing the web remote
   *   again reads the console again (its Button page may have changed).
   */
  async chooseKeys(choice: Ma2ExecutorChannel['choice']): Promise<boolean> {
    if (this.channels.chosen() === choice) return false;
    this.releaseButtons();
    this.channels.choose(choice);
    if (choice === 'plugin') {
      this.buttonRelogin.stop();
      this.buttons?.client.close(); this.buttons = null; this.buttonOpening = null;
      this.channels.forget();
      return true;
    }
    const fader = this.faderRequest;
    if (!fader || this.failed || !this.client?.connected) return true;
    const generation = this.generation;
    const profile = (await this.profiles()).find(value => value.host === fader.network.host);
    if (!profile) return true;
    const password = await this.secrets.loadCredential(this.secret(profile.host, profile.username));
    if (generation !== this.generation || this.channels.chosen() !== 'webRemote') return true;
    await this.probeButtonArea(fader, { username: profile.username, password }, generation);
    return true;
  }
  /** Which channel Button area keys use on this console now, and why. Reads nothing. */
  buttonChannel(request: Ma2LayoutDirectoryRequest): Ma2ExecutorChannel { return this.channels.buttons(this.key(request)); }
  /** The channel a key at `slot` on this console goes on. */
  keyChannel(request: Ma2LayoutDirectoryRequest, slot: number): Ma2ExecutorChannel['kind'] { return this.channels.forKey(this.key(request), slot); }
  /**
   * Reads the Button area once, row by row from 101, on a session of its own, and chooses the key channel from the
   * answer. Nothing here fails the fader view: a Button area the web remote cannot read only means the plugin.
   */
  private async probeButtonArea(request: Pick<Ma2LiveConnect, 'network' | 'expectedSource' | 'page'>, login: Pick<Ma2LiveConnect, 'username' | 'password'>, generation: number): Promise<void> {
    const scope = this.key(request);
    const client: Ma2LivePlayback = this.socket(request.network.host, reason => this.buttonsDropped(client, reason));
    const reads = new Map<string, Ma2ButtonSnapshot>();
    let start: number = MA2_BUTTON_RANGES[0];
    let answer: Ma2ButtonAreaAnswer | null = null;
    try {
      await client.connect(login.username, login.password);
      for (const range of MA2_BUTTON_RANGES) {
        if (generation !== this.generation) break;
        start = range;
        const read = await client.readButtons(request.page, range);
        reads.set(`${request.page}:${range}`, read);
        if (read.items.length) { answer = { kind: 'slots', page: request.page, start: range, count: read.items.length }; break; }
      }
      answer ??= { kind: 'empty', page: request.page, ranges: MA2_BUTTON_RANGES.length };
    } catch (error) { answer = { kind: 'failed', page: request.page, start, reason: error instanceof Error ? error.message : String(error) }; }
    if (generation !== this.generation || this.channels.chosen() !== 'webRemote') { client.close(); return; }
    this.buttons?.client.close(); this.buttons = null;
    // Kept while the console can take Button keys on the web remote, so the first key does not wait for a login.
    if (this.channels.decide(scope, answer).webRemote.ready) {
      this.buttons = { client, scope, verifiedAt: this.verifiedAt, reads, reading: Promise.resolve() };
      this.buttonRelogin.connected(scope, { network: request.network, expectedSource: request.expectedSource });
    } else client.close();
  }
  /** The Button area session for this console, logged in again with the saved user when it was closed. */
  private async buttonSession(request: Ma2LayoutDirectoryRequest): Promise<ButtonSession> {
    const scope = this.key(request);
    if (this.buttons?.scope === scope && this.buttons.client.connected) return this.buttons;
    if (this.buttonOpening?.scope === scope) return this.buttonOpening.session;
    // Keys held on the old session are let go; the press that asked for this session goes on.
    for (const sessionId of [...this.held.keys()]) { this.end(sessionId); this.letGo(sessionId); }
    this.buttons?.client.close(); this.buttons = null;
    const generation = this.generation;
    const session = (async (): Promise<ButtonSession> => {
      const login = await this.savedLogin(request.network.host);
      const client: Ma2LivePlayback = this.socket(request.network.host, reason => this.buttonsDropped(client, reason));
      try { await client.connect(login.username, login.password); }
      catch (error) { client.close(); throw error; }
      if (generation !== this.generation) { client.close(); throw new Error('控台连接已改变'); }
      const opened: ButtonSession = { client, scope, verifiedAt: 0, reads: new Map(), reading: Promise.resolve() };
      this.buttons = opened;
      this.buttonRelogin.connected(scope, { network: request.network, expectedSource: request.expectedSource });
      return opened;
    })();
    const opening = { scope, session }; this.buttonOpening = opening;
    try { return await session; }
    finally { if (this.buttonOpening === opening) this.buttonOpening = null; }
  }
  /** A Button session that drops on its own: its held keys are let go and presses on their way cancelled (nothing is
   * sent on a closed session, nothing is sent again later), and logging in again starts. The channel stays. */
  private buttonsDropped(client: Ma2LivePlayback, reason: string): void {
    if (this.buttons?.client !== client) return;
    this.releaseButtons();
    this.buttonRelogin.dropped(reason);
  }
  /** The Show check a key relies on: the fader view's, when it checked this console within 2 s; otherwise one short
   * Telnet command, which waits for the plugin step on the line (a key then misses its deadline and says so). */
  private async buttonShow(session: ButtonSession, request: Ma2ExecutorInput): Promise<void> {
    const now = Date.now();
    if (!this.failed && this.scope === session.scope && now - this.verifiedAt <= BUTTON_SHOW_MS || now - session.verifiedAt <= BUTTON_SHOW_MS) return;
    await verifyMa2ShowSource(this.telnet(request), request.expectedSource, this.carried);
    session.verifiedAt = Date.now();
  }
  /** 15 button executors from `start`, read again when the last read is older than 1 s; one read at a time. `peek`: the
   * lights-off read-back's, which leaves the session as it is when the answer is not understood. */
  private async buttonRead(session: ButtonSession, page: number, start: number, how: 'read' | 'peek' = 'read'): Promise<Ma2ButtonSnapshot> {
    const key = `${page}:${start}`;
    const fresh = (): Ma2ButtonSnapshot | null => {
      const read = session.reads.get(key);
      return read && Date.now() - read.readAt <= BUTTON_READ_MS ? read : null;
    };
    const cached = fresh();
    if (cached) return cached;
    const read = session.reading.then(() => fresh() ?? (how === 'peek' ? session.client.peekButtons(page, start) : session.client.readButtons(page, start)));
    session.reading = read.then(() => undefined, () => undefined);
    const value = await read;
    session.reads.set(key, value);
    return value;
  }
  /**
   * A Button area key on the web remote (M7). It is checked against what the web remote reads for that slot now and
   * sent only before its deadline; an error is kept with the channel and never sends the key on the plugin instead.
   * As on the plugin, a release cancels this session's press still on its way: a tap shorter than the checks never
   * reaches the console. Returns what was pressed, for the log, or null for a renew or a release.
   */
  async inputButton(input: Ma2ExecutorInput): Promise<Ma2ButtonPress | null> {
    const request = ma2ExecutorInputSchema.parse(input); this.telnet(request);
    const scope = this.key(request);
    const held = this.held.get(request.sessionId);
    if (!request.pressed) {
      this.end(request.sessionId);
      if (held) this.letGo(request.sessionId);
      const pending = this.pending.get(request.sessionId);
      if (pending) pending.cancelled = true;
      return null;
    }
    if (this.ended.has(request.sessionId)) throw new ButtonCancelled();
    // A press made for the other channel is the page not knowing yet; it is not an error of this one.
    if (request.channel !== 'webRemote' || this.channels.forKey(scope, request.slot) !== 'webRemote') throw new Error('按键通道变了（现在走控台插件），这次没有发送，请再按一次');
    const pending = { cancelled: false };
    try {
      if (Date.now() > request.deadlineAt) throw new Error('按键操作已过期，没有补发，请重新点一次');
      if (held) {
        if (held.scope !== scope || held.page !== request.page || held.slot !== request.slot || held.button !== request.button) throw new Error('按住期间执行器或连接有变化，请松开后重新按');
        if (this.buttons?.scope !== scope || !this.buttons.client.connected) { this.letGo(request.sessionId); throw new Error('网页遥控断开了，按键已松开，请重新按'); }
        this.hold(request.sessionId);
        return null;
      }
      const code = request.expectedItem.buttons?.[request.button] ?? (request.button === 0 ? request.expectedItem.button : null);
      const known = code === null || code === undefined ? undefined : ma2ExecutorFunctions[code];
      if (!known) throw new Error('这个执行器按键没有读到可用的功能，请刷新这一页');
      this.pending.set(request.sessionId, pending);
      const generation = this.generation;
      const session = await this.buttonSession(request);
      await this.buttonShow(session, request);
      const read = await this.buttonRead(session, request.page, ma2ObservedRange(request.slot).start);
      const item = read.items.find(value => value.slot === request.slot);
      if (!item) throw new Error('控台上这一格没有执行器，按键没有发送，请刷新这一页');
      const changed = buttonMismatch(item, request.expectedItem);
      if (changed) throw new Error(`${changed}，按键没有发送，请刷新这一页`);
      const button = item.buttons.find(value => value.id === request.button);
      if (!button || button.name === 'Empty') throw new Error('网页遥控上这一格没有这个按键，按键没有发送，请刷新这一页');
      if (Date.now() > request.deadlineAt) throw new Error('按键操作已过期，没有补发，请重新点一次');
      // The last look before the wire: a release that came while the checks ran wins.
      if (pending.cancelled) throw new ButtonCancelled();
      if (generation !== this.generation || this.buttons !== session || !session.client.connected) throw new Error('网页遥控连接变了，按键没有发送');
      session.client.input(request.page, request.slot, { kind: 'button', id: button.id, pressed: true });
      this.held.set(request.sessionId, { scope, page: request.page, slot: request.slot, button: request.button, id: button.id, guard: setTimeout(() => this.letGo(request.sessionId), BUTTON_HOLD_MS) });
      return { page: request.page, slot: request.slot, button: request.button, name: button.name, function: known.name };
    } catch (error) {
      if (!(error instanceof ButtonCancelled)) this.channels.failed(scope, error instanceof Error ? error.message : String(error));
      throw error;
    } finally {
      if (this.pending.get(request.sessionId) === pending) this.pending.delete(request.sessionId);
    }
  }
  /** A press session the renderer let go of: a later press or renew of it is not sent. */
  private end(sessionId: string): void {
    this.ended.add(sessionId);
    const oldest = this.ended.values().next();
    if (this.ended.size > 256 && !oldest.done) this.ended.delete(oldest.value);
  }
  private hold(sessionId: string): void {
    const held = this.held.get(sessionId);
    if (!held) return;
    clearTimeout(held.guard);
    held.guard = setTimeout(() => this.letGo(sessionId), BUTTON_HOLD_MS);
  }
  private letGo(sessionId: string): void {
    const held = this.held.get(sessionId);
    if (!held) return;
    clearTimeout(held.guard); this.held.delete(sessionId);
    const session = this.buttons;
    if (session?.scope === held.scope && session.client.connected) session.client.input(held.page, held.slot, { kind: 'button', id: held.id, pressed: false });
  }
  /** Lets go of every Button area key held on the web remote, and cancels every press still on its way. */
  releaseButtons(): void {
    for (const sessionId of [...this.held.keys()]) { this.end(sessionId); this.letGo(sessionId); }
    for (const [sessionId, pending] of this.pending) { this.end(sessionId); pending.cancelled = true; }
  }
  private armRelease(): void {
    if (this.guard) clearTimeout(this.guard);
    this.guard = setTimeout(() => { this.release(); this.failed = true; this.faderFailure = '推杆页按住的键 1.5 秒没有续上，已经松开，推杆页停下了'; this.client?.close(); }, 1500);
  }
  input(input: Ma2LiveInput): void {
    const request = ma2LiveInputSchema.parse(input); this.telnet(request);
    const release = request.action.kind === 'button' && !request.action.pressed;
    const key = request.action.kind === 'button' ? `${request.page}:${request.slot}:${request.action.id}` : '';
    if (release) {
      if (this.pressed.has(key)) { this.client?.input(request.page, request.slot, request.action); this.pressed.delete(key); }
      return;
    }
    if (Date.now() > request.deadlineAt || this.failed || this.scope !== this.key(request) || !this.client?.connected) throw new Error('推杆操作已过期或连接变了，没有发送');
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.page !== request.page || snapshot.start !== request.start || Date.now() - snapshot.readAt > 1000 || Date.now() - this.verifiedAt > 2000) throw new Error('实时状态已过期，请重新读取后操作');
    const block = snapshot.items.flatMap(item => item.blocks).find(value => value.slot === request.slot);
    const action = request.action;
    if (!block || action.kind === 'fader' && !block.fader || action.kind === 'button' && !block.buttons.some(button => button.id === action.id && button.name !== 'Empty')) throw new Error('此位置没有可操作的推杆或按键');
    if (action.kind === 'fader' && block.fader && (action.value < block.fader.min || action.value > block.fader.max)) throw new Error('推杆数值超出了控台允许的范围，没有发送');
    this.client.input(request.page, request.slot, request.action);
    if (request.action.kind === 'button' && request.action.pressed) { this.pressed.set(key, { page: request.page, slot: request.slot, id: request.action.id }); this.armRelease(); }
  }
}
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);
/** One Show, plugin session and console version, as one key. */
const sourceKey = (source: Ma2ShowSource): string => JSON.stringify([source.show, source.generation, source.version]);
