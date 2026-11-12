import { isShowWait, lightingExecutors, showGate, type ShowGate, type ShowState } from '@tb/core/link';
import type { LightingDocument, Ma2ButtonLive, Ma2ExecutorPage, Ma2LiveSnapshot, Ma2WebRemoteSession } from '@tb/schema';

/**
 * The console page (C1, design 03 §4.3): what each cell of the executor page shows and what the operator may do there,
 * from the page's structure (the plugin's PAGE), what the web remote reads now, the show state and the executors this
 * song's timecode runs. Components draw only this. What may be done is asked of `showGate`, never of "is it playing".
 */

type PageItem = Ma2ExecutorPage['items'][number];

/** A live read older than this is shown as old: the console has not answered for three reads of a Button row. */
export const MA2_CONSOLE_LIVE_STALE_MS = 3000;
/** A fader value the console has not shown within this is marked late (yellow); it never stops the fader. */
export const MA2_FADER_LATE_MS = 1500;
/** Fader moves are sent at most this often while dragged, the newest value each time. */
export const MA2_FADER_SEND_MS = 100;
/** While a web remote session is not connected, the page asks the main process this often what became of it (C2); that asks nothing of the console. */
export const MA2_WEB_REMOTE_WATCH_MS = 1000;

/** Fader values sent and not shown by the console yet, by slot; `late`: not shown within MA2_FADER_LATE_MS. */
export type Ma2PendingFaders = ReadonlyMap<number, { value: number; at: number; late: boolean }>;
/** A new value for a fader: it waits for the console again from now. */
export function holdFader(pending: Ma2PendingFaders, slot: number, value: number, now: number): Map<number, { value: number; at: number; late: boolean }> {
  return new Map(pending).set(slot, { value, at: now, late: false });
}
/**
 * After a fader read: a value the console shows now is done; one it has not shown within 1.5 s is only marked late (C1,
 * design §4.3.2). Nothing here stops the fader or throws: the operator can drag on, and the next value is sent as usual.
 */
export function settleFaders(pending: Ma2PendingFaders, read: Ma2LiveSnapshot, now: number): Map<number, { value: number; at: number; late: boolean }> {
  const next = new Map(pending);
  for (const [slot, value] of next) {
    const fader = read.items.flatMap(item => item.blocks).find(block => block.slot === slot)?.fader;
    if (read.readAt >= value.at && fader && Math.abs(fader.value - value.value) < 0.01) next.delete(slot);
    else if (!value.late && now - value.at > MA2_FADER_LATE_MS) next.set(slot, { ...value, late: true });
  }
  return next;
}

/** Whether the page reads the Button rows' live state: only on screen, and only when Button keys go on the web remote (M7 decided it). */
export function ma2ReadsButtonLive(shown: boolean, keys: 'webRemote' | 'plugin' | null): boolean { return shown && keys === 'webRemote'; }

/** The words of the web remote's absence, design §4.2.4. */
export const MA2_CONSOLE_CONNECT_NOTE = '连接网页遥控后显示控台实时状态';

/** One executor as the web remote reads it. */
export type Ma2ConsoleLiveItem = { slot: number; width: number; name: string; objectNumber: string; running: boolean; cue: string };
export type Ma2ConsoleFader = { slot: number; value: number; min: number; max: number; text: string };
/** What is known of one row of 15 now. `off`: no live state for it, and the one sentence that says why and how to get it. */
export type Ma2ConsoleLiveRow =
  | { kind: 'off'; note: string; tone?: 'normal' | 'warning' }
  | { kind: 'reading' }
  | { kind: 'failed'; reason: string }
  /** `waiting`: the last read, kept while the session logs in again on its own (C2); it turns old as any read does. */
  | { kind: 'read'; readAt: number; items: readonly Ma2ConsoleLiveItem[]; faders: readonly Ma2ConsoleFader[]; waiting?: string };

export type Ma2ConsoleCellLive =
  | { kind: 'none' }
  | { kind: 'waiting' }
  | { kind: 'changed'; message: string }
  | { kind: 'live'; running: boolean; cue: string; stale: boolean };
export type Ma2ConsoleKey = { kind: 'idle' } | { kind: 'sending' } | { kind: 'failed'; message: string };
export type Ma2ConsoleFaderCell = { value: number; min: number; max: number; text: string; state: 'shown' | 'waiting' | 'late'; note: string | null };
export type Ma2ConsoleCell = {
  slot: number; address: string; item: PageItem | undefined; span: number;
  live: Ma2ConsoleCellLive; timecode: boolean; key: Ma2ConsoleKey; fader: Ma2ConsoleFaderCell | null;
};
export type Ma2ConsoleBand = { cells: Ma2ConsoleCell[]; note: { text: string; tone: 'normal' | 'warning' } | null };

export type Ma2ConsoleBandInput = {
  page: number | null; start: number; end: number; structure: Ma2ExecutorPage | undefined;
  /** The row a slot is read in, by the row's first slot. */
  rows: ReadonlyMap<number, Ma2ConsoleLiveRow>; rowStart: (slot: number) => number;
  timecode: ReadonlySet<string>;
  keys: { sending: Readonly<Record<string, number>>; failed: Readonly<Record<string, string>> };
  pending: ReadonlyMap<number, { value: number; late: boolean }>;
  now: number;
};

/** A Button row, as "page:start": the upper and the lower band asking the same row read it once. */
export function ma2ButtonRowKey(page: number, start: number): string { return `${page}:${start}`; }

/**
 * The Button rows the page reads live: rows of 15 from 101 to 176 that the bands show and that hold an executor in the page's
 * structure. A row with nothing in it, or 191 and up (the web remote cannot read them), is never asked for.
 */
export function ma2ButtonRowsToRead(bands: readonly { page: number | null; start: number; end: number; structure: Ma2ExecutorPage | undefined }[]): string[] {
  const rows = new Set<string>();
  for (const band of bands) {
    if (band.page === null || !band.structure) continue;
    for (let start = ma2ButtonRowStart(band.start); start <= Math.min(band.end, 176); start += 15) {
      if (band.structure.items.some(item => item.slot < start + 15 && item.slot + item.width > start && item.slot <= band.end && item.slot >= band.start)) rows.add(ma2ButtonRowKey(band.page, start));
    }
  }
  return [...rows];
}

/** The first slot of the Button row a slot is read in: 101, 116, … 176. */
export function ma2ButtonRowStart(slot: number): number { return 101 + Math.floor((slot - 101) / 15) * 15; }

/** Why the slot the web remote reads is not the executor the page shows, or null; empty fields are not compared (as the key's own check). */
function changedOnConsole(item: PageItem, live: Ma2ConsoleLiveItem | undefined): string | null {
  if (!live) return '控台上这一格现在是空的，请刷新页面';
  const number = /^\s*(\d+)\s*$/.exec(live.objectNumber)?.[1];
  const name = live.name.trim(), shown = item.name.trim();
  if (item.sequence !== undefined && number !== undefined && Number(number) !== item.sequence || name && shown && name !== shown) return '控台上这一格变了，请刷新页面';
  return null;
}

export function ma2ConsoleBand(input: Ma2ConsoleBandInput): Ma2ConsoleBand {
  const items = new Map(input.structure?.items.map(item => [item.slot, item]));
  const continuation = new Set(input.structure?.items.flatMap(item => Array.from({ length: item.width - 1 }, (_, index) => item.slot + index + 1)));
  const cells: Ma2ConsoleCell[] = [];
  for (let slot = input.start; slot <= input.end; slot += 1) {
    if (continuation.has(slot)) continue;
    const item = items.get(slot); const index = slot - input.start;
    const address = `${input.page}.${slot}`;
    const row = input.rows.get(input.rowStart(slot));
    const failed = input.keys.failed[address];
    const key: Ma2ConsoleKey = input.keys.sending[address] ? { kind: 'sending' } : failed ? { kind: 'failed', message: failed } : { kind: 'idle' };
    cells.push({ slot, address, item, span: Math.min(item?.width ?? 1, 15 - index % 15), live: cellLive(item, slot, row, input.now), timecode: Boolean(item) && input.timecode.has(address), key, fader: faderCell(item, slot, row, input.pending.get(slot)) });
  }
  return { cells, note: bandNote([...new Set([...input.rows.values()])], input.structure !== undefined) };
}

function cellLive(item: PageItem | undefined, slot: number, row: Ma2ConsoleLiveRow | undefined, now: number): Ma2ConsoleCellLive {
  if (!item || !row || row.kind === 'off' || row.kind === 'failed') return { kind: 'none' };
  if (row.kind === 'reading') return { kind: 'waiting' };
  const live = row.items.find(entry => entry.slot <= slot && slot < entry.slot + entry.width);
  const changed = changedOnConsole(item, live);
  if (changed || !live) return { kind: 'changed', message: changed ?? '控台上这一格现在是空的，请刷新页面' };
  return { kind: 'live', running: live.running, cue: live.cue, stale: now - row.readAt > MA2_CONSOLE_LIVE_STALE_MS };
}

function faderCell(item: PageItem | undefined, slot: number, row: Ma2ConsoleLiveRow | undefined, pending: { value: number; late: boolean } | undefined): Ma2ConsoleFaderCell | null {
  const fader = item && row?.kind === 'read' ? row.faders.find(entry => entry.slot === slot) : undefined;
  if (!fader) return null;
  if (!pending) return { ...fader, state: 'shown', note: null };
  return { ...fader, value: pending.value, state: pending.late ? 'late' : 'waiting', note: pending.late ? '控台还没显示这个值' : null };
}

/** One sentence for the band: why it has no live state, or what failed. Rows read well say nothing. */
function bandNote(rows: readonly Ma2ConsoleLiveRow[], shown: boolean): Ma2ConsoleBand['note'] {
  if (!shown) return null;
  const off = rows.find((row): row is Extract<Ma2ConsoleLiveRow, { kind: 'off' }> => row.kind === 'off');
  if (off) return { text: off.note, tone: off.tone ?? 'normal' };
  const failed = rows.find((row): row is Extract<Ma2ConsoleLiveRow, { kind: 'failed' }> => row.kind === 'failed');
  if (failed) return { text: `读不到控台上这几格现在的状态。原因：${failed.reason}`, tone: 'warning' };
  const waiting = rows.find((row): row is Extract<Ma2ConsoleLiveRow, { kind: 'read' }> => row.kind === 'read' && row.waiting !== undefined);
  // Yellow: the session dropped and what is shown turns old, though nothing is asked of the operator yet.
  return waiting?.waiting ? { text: waiting.waiting, tone: 'warning' } : null;
}

/** The words while a session logs in again on its own (C2): a wait, shown in yellow (it dropped; faders and live state wait), never red. */
export function ma2ReloginText(attempt: number): string { return `网页遥控断了，正在自动重新登录（第 ${attempt} 次）`; }

/**
 * The fader band's row, from the fader session (`useMa2LivePlayback`): `wanted`, the operator connected the web remote in
 * this run. `session`: what the main process says of that session after a read failed. While it logs in again on its own
 * (C2) the last read stays and turns old, with the wait beside it; it is never shown as a failure.
 */
export function ma2FaderLiveRow(input: { wanted: boolean; start: number; snapshot: Ma2LiveSnapshot | null; error: string; session?: Ma2WebRemoteSession | null }): Ma2ConsoleLiveRow {
  if (input.start > 76) return { kind: 'off', note: '91–100 格网页遥控读不了，这里只显示页面结构' };
  if (!input.wanted) return { kind: 'off', note: MA2_CONSOLE_CONNECT_NOTE };
  if (input.error && input.session?.kind === 'relogin') {
    const waiting = ma2ReloginText(input.session.attempt);
    return input.snapshot ? { ...faderRead(input.snapshot), waiting } : { kind: 'off', note: waiting, tone: 'warning' };
  }
  if (input.error) return { kind: 'failed', reason: input.error };
  if (!input.snapshot) return { kind: 'reading' };
  return faderRead(input.snapshot);
}
function faderRead(snapshot: Ma2LiveSnapshot): Extract<Ma2ConsoleLiveRow, { kind: 'read' }> {
  return {
    kind: 'read', readAt: snapshot.readAt,
    items: snapshot.items.map(item => ({ slot: item.slot, width: item.width, name: item.name, objectNumber: item.objectNumber, running: item.running, cue: item.cue })),
    faders: snapshot.items.flatMap(item => item.blocks.flatMap(block => block.fader ? [{ slot: block.slot, value: block.fader.value, min: block.fader.min, max: block.fader.max, text: block.fader.text }] : []))
  };
}

/** What the Button session gave for one row (`useMa2ButtonLive`), or what the page knows without asking. */
export type Ma2ButtonRowInput =
  | { kind: 'not-asked'; why: 'plugin' | 'unknown' | 'above-190' }
  | { kind: 'reading' } | { kind: 'failed'; reason: string }
  | { kind: 'off'; why: 'plugin' | 'unverified' | 'disconnected' | 'stopped'; reason: string }
  | { kind: 'live'; readAt: number; items: readonly Ma2ConsoleLiveItem[] }
  /** The Button session logs in again on its own (C2); `last`, the row's last read, kept to turn old. */
  | { kind: 'relogin'; attempt: number; last: { readAt: number; items: readonly Ma2ConsoleLiveItem[] } | null };

/** A row after the main process answered (`useMa2ButtonLive`): while the Button session logs in again, the last read is kept. */
export function ma2ButtonRowAfter(previous: Ma2ButtonRowInput | undefined, answer: Ma2ButtonLive | { kind: 'failed'; reason: string }): Ma2ButtonRowInput {
  switch (answer.kind) {
    case 'live': return { kind: 'live', readAt: answer.readAt, items: answer.items };
    case 'relogin': return { kind: 'relogin', attempt: answer.attempt, last: previous?.kind === 'live' ? { readAt: previous.readAt, items: previous.items } : previous?.kind === 'relogin' ? previous.last : null };
    case 'off': case 'failed': return answer;
  }
}

export function ma2ButtonLiveRow(input: Ma2ButtonRowInput | undefined): Ma2ConsoleLiveRow {
  if (!input) return { kind: 'reading' };
  switch (input.kind) {
    case 'not-asked':
      return input.why === 'above-190' ? { kind: 'off', note: '191 以后的格子网页遥控读不了，这里只显示页面结构' }
        : input.why === 'unknown' ? { kind: 'off', note: '还不知道 Button 区的按键走哪条，这里先只显示页面结构' }
        : { kind: 'off', note: 'Button 区的按键走控台插件，这里只显示页面结构。想看控台上哪一格在跑，在“按键”菜单里选“网页遥控”' };
    case 'off':
      return input.why === 'plugin' ? ma2ButtonLiveRow({ kind: 'not-asked', why: 'plugin' })
        : input.why === 'unverified' ? { kind: 'off', note: `Button 区只显示页面结构：${input.reason}` }
        : input.why === 'stopped' ? { kind: 'off', note: `Button 区的网页遥控停了：${input.reason}。按一次键会重新连上`, tone: 'warning' }
        : { kind: 'off', note: 'Button 区的网页遥控现在没连着，这里只显示页面结构。按一次键会重新连上' };
    case 'relogin': {
      const waiting = `Button 区的${ma2ReloginText(input.attempt)}`;
      return input.last ? { kind: 'read', readAt: input.last.readAt, items: input.last.items, faders: [], waiting } : { kind: 'off', note: `${waiting}，这里先只显示页面结构`, tone: 'warning' };
    }
    case 'reading': return { kind: 'reading' };
    case 'failed': return { kind: 'failed', reason: input.reason };
    case 'live': return { kind: 'read', readAt: input.readAt, items: input.items, faders: [] };
  }
}

/** The executors this song's timecode runs ("page.slot"): the song on stage while the show is on, otherwise the one open. */
export function ma2TimecodeExecutors(show: ShowState, lightingOf: (itemId: string) => LightingDocument | null, open: LightingDocument | null): Set<string> {
  const onStage = show.phase !== 'idle' && show.itemId ? show.itemId : null;
  return new Set(lightingExecutors(onStage ? lightingOf(onStage) : open));
}

/** What the page may do now, from showGate only. `waiting`: the sentence beside what waits, in showGate's own words. */
export function ma2ConsolePageActions(show: ShowState): { press: ShowGate; refresh: ShowGate; mutate: ShowGate; waiting: string | null } {
  const press = showGate('ma2.executorPage.press', show);
  const refresh = showGate('ma2.executorPage.refresh', show);
  const mutate = showGate('ma2.executor.mutate', show);
  return { press, refresh, mutate, waiting: mutate.kind === 'wait' ? mutate.message : refresh.kind === 'wait' ? refresh.message : null };
}

/** A page read that came back as an error: a wait for the show (shown as waiting, never red) or a failure. */
export function ma2ConsoleReadNote(error: string): { kind: 'wait' | 'failed'; text: string } {
  return { kind: isShowWait(error) ? 'wait' : 'failed', text: error.replace(/Error invoking remote method '[^']+':\s*/g, '').replace(/\bError:\s*/g, '').trim() };
}

/** The banner at the top of the page while the show is on (`phase !== 'idle'`), design §4.3.1. Never red: a wait is not a failure. */
export function ma2ConsoleBanner(show: ShowState): { title: string; text: string } | null {
  const title = '演出中';
  switch (show.phase) {
    case 'idle': return null;
    case 'running': return { title, text: '时间码在走。按键和推杆立刻生效；改执行器、刷新页面结构等暂停后再做' };
    case 'preparing': return { title, text: '正在开始' };
    case 'stopping': return { title, text: '正在关灯' };
    case 'held':
      switch (show.reason) {
        case 'paused': case 'ended': return { title, text: '已暂停。可以改执行器、刷新页面' };
        case 'p1-waiting': return { title, text: 'P1 在等下一首。可以改执行器、刷新页面' };
        case 'timecode-lost': return { title, text: '时间码断了。按键和推杆照常可用' };
        case 'error': return { title, text: '播放出错，停在这首歌上。可以改执行器、刷新页面' };
      }
  }
}

/**
 * The fader view's web remote as the footer tells it: `relogin` and `stopped` come from the main process (C2) once a read
 * failed; `failed` is a read that failed before the main process said more.
 */
export type Ma2ConsoleWebRemote = { kind: 'off' } | { kind: 'connecting' } | { kind: 'connected' } | { kind: 'failed'; reason: string }
  | { kind: 'relogin'; attempt: number } | { kind: 'stopped'; reason: string; limit: boolean };
export function ma2ConsoleWebRemote(input: { wanted: boolean; connecting: boolean; error: string; session: Ma2WebRemoteSession | null; snapshot: boolean }): Ma2ConsoleWebRemote {
  if (!input.wanted) return { kind: 'off' };
  if (input.connecting) return { kind: 'connecting' };
  if (input.error) {
    if (input.session?.kind === 'relogin') return { kind: 'relogin', attempt: input.session.attempt };
    if (input.session?.kind === 'stopped') return { kind: 'stopped', reason: input.session.reason, limit: input.session.limit };
    return { kind: 'failed', reason: input.error };
  }
  return input.snapshot ? { kind: 'connected' } : { kind: 'connecting' };
}
export type Ma2ConsoleTone = 'normal' | 'warning' | 'danger';
/** The page's footer: how keys and faders reach the console, and the web remote's state. `connect`: offer “连接网页遥控”. */
export function ma2ConsoleFooter(webRemote: Ma2ConsoleWebRemote, buttonKeys: { text: string; tone: 'normal' | 'warning' }): { keys: string; keysTone: Ma2ConsoleTone; webRemote: string; webRemoteTone: Ma2ConsoleTone; connect: boolean } {
  const keys = `推杆区按键：控台插件 · 推杆：网页遥控 · Button 区${buttonKeys.text}。走控台插件的按键，同步时最多慢一步`;
  const line = (text: string, tone: Ma2ConsoleTone, connect: boolean) => ({ keys, keysTone: buttonKeys.tone, webRemote: text, webRemoteTone: tone, connect });
  switch (webRemote.kind) {
    case 'off': return line(`网页遥控没连上。${MA2_CONSOLE_CONNECT_NOTE}`, 'normal', true);
    case 'connecting': return line('正在连接网页遥控…', 'normal', false);
    case 'connected': return line('网页遥控已连上，推杆区显示控台当前值', 'normal', false);
    case 'failed': return line(`网页遥控停了，推杆区的实时状态没有更新。原因：${webRemote.reason}`, 'warning', true);
    // Waiting, in yellow and never red; the operator may still connect by hand, and that takes over.
    case 'relogin': return line(ma2ReloginText(webRemote.attempt), 'warning', true);
    case 'stopped': return line(webRemote.limit ? webRemote.reason : `网页遥控停了，需要手动连接。原因：${webRemote.reason}`, 'danger', true);
  }
}
