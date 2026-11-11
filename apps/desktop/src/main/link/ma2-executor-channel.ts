import type { Ma2ExecutorChannel, Ma2ExecutorChannelKind } from '@tb/schema';

/**
 * Which line executor keys and faders use (M7, 03 §4.2.4). This is the one place that decides it.
 *
 * - Faders, and the keys on the fader view (1–15 of a fader page): the web remote, as before.
 * - Button area keys (101–190) on the executor page: the console plugin (`TBLINK_EXEC_INPUT`,
 *   `ma2-executor-input.ts`), as in 0.5.8, unless the operator chose the web remote on this computer (`choose`) AND
 *   this console's web remote, read the way button executors are read when it was connected, answered with the slot
 *   numbers that were asked for. Anything else, a mismatch, an error or an empty answer included, counts as "cannot
 *   read". The web remote for Button area keys is only verified on onPC 3.7.0.5 fader executors, so it is opt-in.
 * - Fader area keys on the executor page (1–90), and 191 and up, stay on the plugin.
 *
 * With the plugin chosen the console gets nothing more than before M7: no Button session, no Button area read. The
 * Button area is read only with the web remote chosen: when it is chosen while the fader view is connected, and when
 * the web remote is connected (`decide`).
 *
 * The channel changes only when the operator changes the choice, or when the web remote is connected: the operator
 * pressing "连接", or the first time the saved user logs in for this console and Show. An error never
 * changes it, during a show or not (AGENTS §4.4): keys on the web remote then fail with the reason, they are not
 * sent on the plugin instead. Nothing here reads the console; when the saved user logs in again for a console that
 * was read, nothing is read again.
 */

/** What the web remote answered when the Button area was read, range by range, until one answered or one failed. */
export type Ma2ButtonAreaAnswer =
  | { kind: 'slots'; page: number; start: number; count: number }
  | { kind: 'empty'; page: number; ranges: number }
  | { kind: 'failed'; page: number; start: number; reason: string };
export type Ma2ExecutorChannelChoice = Ma2ExecutorChannel['choice'];
type WebRemote = Ma2ExecutorChannel['webRemote'];

/** Whether the console's answer lets Button area keys go on the web remote. Pure. */
export function webRemoteFromAnswer(answer: Ma2ButtonAreaAnswer): WebRemote {
  switch (answer.kind) {
    case 'slots': return { ready: true, reason: `网页遥控读回了第 ${answer.page} 页 ${answer.start}–${answer.start + 14} 格的 ${answer.count} 个执行器，格号和请求的一致` };
    case 'empty': return { ready: false, reason: `网页遥控读不回：第 ${answer.page} 页 Button 区没有执行器，看不出格号对不对。在有 Button 执行器的页面上重新连接网页遥控可以再看一次` };
    case 'failed': return { ready: false, reason: `网页遥控读不回第 ${answer.page} 页 ${answer.start}–${answer.start + 14} 格：${answer.reason}` };
  }
}

/** The Button area the web remote reads in rows of 15: 101–190. */
export function isMa2ButtonAreaSlot(slot: number): boolean { return slot >= 101 && slot <= 190; }

const NOT_READ: WebRemote = { ready: false, reason: '网页遥控没连上：灯光工作台推杆页还没“连接”' };
/** With the plugin chosen the Button area is not read at all; this is not a warning. */
const NOT_CHOSEN: WebRemote = { ready: false, reason: '选了网页遥控才会去读 Button 区' };

/** The operator's choice for this computer and the answer of one console (`scope`: its address and Show). */
export class Ma2ExecutorChannels {
  private choice: Ma2ExecutorChannelChoice = 'plugin';
  private decided: { scope: string; webRemote: WebRemote; error: string | null } | null = null;
  chosen(): Ma2ExecutorChannelChoice { return this.choice; }
  /** The operator's choice on this computer. Returns whether it changed. */
  choose(choice: Ma2ExecutorChannelChoice): boolean {
    if (choice === this.choice) return false;
    this.choice = choice;
    if (this.decided) this.decided.error = null;
    return true;
  }
  /** Forgets what the console answered: the next choice of the web remote reads it again. */
  forget(): void { this.decided = null; }
  /** The console answered the Button area read made when the web remote was connected. */
  decide(scope: string, answer: Ma2ButtonAreaAnswer): Ma2ExecutorChannel {
    this.decided = { scope, webRemote: webRemoteFromAnswer(answer), error: null };
    return this.buttons(scope);
  }
  /** Whether this console was read already: a web remote session opened again on its own keeps the answer. */
  has(scope: string): boolean { return this.decided?.scope === scope; }
  /** Button area keys (101–190) on this console now, and why. */
  buttons(scope: string): Ma2ExecutorChannel {
    const decided = this.decided?.scope === scope ? this.decided : null;
    if (this.choice === 'plugin') return { kind: 'plugin', choice: 'plugin', reason: '选的是控台插件，和 0.5.8 一样', webRemote: NOT_CHOSEN };
    const webRemote = decided?.webRemote ?? NOT_READ;
    if (!webRemote.ready) return { kind: 'plugin', choice: 'webRemote', reason: webRemote.reason, webRemote };
    const reason = decided?.error ? `${webRemote.reason}。网页遥控上一次出错：${decided.error}；通道不变，重新连接网页遥控后再按` : webRemote.reason;
    return { kind: 'webRemote', choice: 'webRemote', reason, webRemote };
  }
  /** The channel a key at `slot` goes on: fader area keys on the executor page (1–90), and 191 and up, stay on the plugin. */
  forKey(scope: string, slot: number): Ma2ExecutorChannelKind { return isMa2ButtonAreaSlot(slot) ? this.buttons(scope).kind : 'plugin'; }
  /** A key on this console failed. Kept to show it; the channel stays what it is. */
  failed(scope: string, reason: string): void {
    if (this.decided?.scope === scope) this.decided.error = reason;
  }
}
