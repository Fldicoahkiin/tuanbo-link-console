import { useEffect, useMemo, useState } from 'react';
import type { LightingDocument, Ma2ExecutorPage } from '@tb/schema';
import { useShowStateStore } from '../stores/show-state-store';
import { useDocumentStore } from '../stores/document-store';
import { useMa2KeyFeedbackStore } from '../stores/ma2-key-feedback-store';
import { useMa2WebRemoteStore, wantMa2WebRemote } from '../stores/ma2-web-remote-store';
import { useMa2ButtonLive } from '../runtime/use-ma2-button-live';
import { ma2KeyChannelLabel, type Ma2ExecutorChannelState } from '../runtime/use-ma2-executor-channel';
import { useMa2LivePlayback } from './useMa2LivePlayback';
import {
  MA2_CONSOLE_LIVE_STALE_MS, ma2ButtonLiveRow, ma2ButtonRowKey, ma2ButtonRowStart, ma2ConsoleBand, ma2ConsoleBanner, ma2ConsoleFooter, ma2ConsolePageActions,
  ma2ConsoleWebRemote, ma2FaderLiveRow, ma2ReadsButtonLive, ma2TimecodeExecutors, type Ma2ButtonRowInput, type Ma2ConsoleBand, type Ma2ConsoleLiveRow
} from '../view-models/ma2-console-page';

export type Ma2ConsoleBandRequest = { kind: 'fader' | 'button'; page: number | null; start: number; end: number; structure: Ma2ExecutorPage | undefined };

/**
 * Everything live the console page shows (C1), put together for `ma2-console-page.ts`: the fader band from the fader
 * session (only after the operator connected the web remote in this run), the Button rows from the Button session (only
 * when Button keys go on the web remote, and only the rows `buttonRows` names), this computer's key presses, the show and
 * the executors this song's timecode runs. `shown`: the page is on screen; otherwise nothing is read.
 */
export function useMa2ConsoleLive({ scope, shown, fader, buttonRows, channel, open }: {
  scope: string; shown: boolean; fader: { page: number | null; start: number }; buttonRows: readonly string[];
  channel: Ma2ExecutorChannelState | null; open: LightingDocument | null;
}) {
  const show = useShowStateStore(state => state.show);
  const project = useDocumentStore(state => state.project);
  const wanted = useMa2WebRemoteStore(state => state.wanted);
  const keys = useMa2KeyFeedbackStore();
  const faderLive = useMa2LivePlayback(fader.page ?? 1, Math.min(fader.start, 76), scope, wanted && shown && fader.page !== null);
  const buttonsOn = ma2ReadsButtonLive(shown, channel?.kind === 'channel' ? channel.channel.kind : null);
  const buttonLive = useMa2ButtonLive(scope, buttonsOn ? buttonRows : [], buttonsOn);
  // Reads that stop coming must still turn old on screen.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!shown) return undefined;
    const timer = setInterval(() => setNow(Date.now()), MA2_CONSOLE_LIVE_STALE_MS / 3);
    return () => clearInterval(timer);
  }, [shown]);
  const timecode = useMemo(() => ma2TimecodeExecutors(show, itemId => project?.rundown.find(item => item.id === itemId)?.lighting ?? null, open), [show, project, open]);
  const faderRow = ma2FaderLiveRow({ wanted: wanted && fader.page !== null, start: fader.start, snapshot: faderLive.snapshot, error: faderLive.error, session: faderLive.session });
  // What a Button row is without asking the console: keys on the plugin, not known yet, or slots the web remote cannot read.
  const buttonKnown = (start: number): Ma2ButtonRowInput | null => start > 176 ? { kind: 'not-asked', why: 'above-190' }
    : !channel || channel.kind === 'unknown' ? { kind: 'not-asked', why: 'unknown' }
    : channel.channel.kind === 'webRemote' ? null
    : channel.channel.choice === 'webRemote' ? { kind: 'off', why: 'unverified', reason: channel.channel.webRemote.reason } : { kind: 'not-asked', why: 'plugin' };
  const band = (request: Ma2ConsoleBandRequest): Ma2ConsoleBand => {
    const rows = new Map<number, Ma2ConsoleLiveRow>();
    if (request.kind === 'fader') rows.set(request.start, faderRow);
    else for (let start = ma2ButtonRowStart(request.start); start <= request.end; start += 15) {
      rows.set(start, ma2ButtonLiveRow(buttonKnown(start) ?? (request.page === null ? undefined : buttonLive[ma2ButtonRowKey(request.page, start)])));
    }
    return ma2ConsoleBand({ page: request.page, start: request.start, end: request.end, structure: request.structure, rows,
      rowStart: request.kind === 'fader' ? () => request.start : ma2ButtonRowStart,
      timecode, keys, pending: request.kind === 'fader' ? faderLive.pending : new Map(), now });
  };
  const webRemote = ma2ConsoleWebRemote({ wanted, connecting: faderLive.connecting, error: faderLive.error, session: faderLive.session, snapshot: faderLive.snapshot !== null });
  const buttonKeys = channel ? ma2KeyChannelLabel(channel, 101) : { text: '按键：还不知道走哪条', tone: 'normal' as const };
  return {
    band, show, actions: ma2ConsolePageActions(show), banner: ma2ConsoleBanner(show), footer: ma2ConsoleFooter(webRemote, buttonKeys),
    // A read kept while the session logs in again shows, but moves wait until it is connected again (C2).
    connecting: faderLive.connecting, faderReady: faderRow.kind === 'read' && !faderLive.error,
    setFader: faderLive.setFader,
    connect: async (username: string, password: string): Promise<void> => { wantMa2WebRemote(); await faderLive.connect(username, password); }
  };
}
export type Ma2ConsoleLive = ReturnType<typeof useMa2ConsoleLive>;
