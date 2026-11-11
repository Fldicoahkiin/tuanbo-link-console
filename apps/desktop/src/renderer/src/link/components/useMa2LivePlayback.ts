import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ma2LiveInput, Ma2LiveRequest, Ma2LiveSnapshot } from '@tb/schema';
import { ma2LayoutConnection } from '../stores/ma2-layout-store';
import { MA2_FADER_SEND_MS, holdFader, settleFaders } from '../view-models/ma2-console-page';

/** A fader value sent and not shown by the console yet; `late`: not shown within MA2_FADER_LATE_MS. */
export type PendingFader = { value: number; at: number; late: boolean };
/**
 * The fader session's live state: read every 100 ms while `enabled` and the window is shown, one read at a time. A
 * fader the console has not shown the new value of within 1.5 s is only marked late (C1): it can still be dragged, and
 * the next value is sent as usual. A read or input that fails stops the reads until the operator connects again.
 */
export function useMa2LivePlayback(page: number, start: number, scope: string, enabled = true) {
  const [snapshot, setSnapshot] = useState<Ma2LiveSnapshot | null>(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [pending, setPending] = useState<Map<number, PendingFader>>(new Map());
  const [revision, setRevision] = useState(0);
  const request = useRef<Ma2LiveRequest | null>(null);
  const epoch = useRef(0);
  const pendingRef = useRef(pending);
  const queue = useRef(new Map<number, number>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alive = useRef(true);
  const stopped = useRef(false);
  const fail = useCallback((cause: unknown) => {
    if (!alive.current) return;
    stopped.current = true;
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    queue.current.clear(); pendingRef.current = new Map(); setPending(new Map());
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);
  const release = useCallback(() => { void window.tbLink.releaseMa2Live().catch(fail); }, [fail]);
  useEffect(() => {
    alive.current = true;
    const blur = (): void => { queue.current.clear(); if (timer.current) clearTimeout(timer.current); timer.current = null; release(); };
    const hide = (): void => { if (document.hidden) blur(); };
    window.addEventListener('blur', blur); document.addEventListener('visibilitychange', hide);
    return () => { alive.current = false; window.removeEventListener('blur', blur); document.removeEventListener('visibilitychange', hide); blur(); };
  }, [release]);
  useEffect(() => {
    const current = ++epoch.current; let active = true; let pollTimer: ReturnType<typeof setTimeout> | undefined;
    const faderQueue = queue.current;
    stopped.current = false;
    request.current = null; setSnapshot(null); setError(''); queue.current.clear(); pendingRef.current = new Map(); setPending(new Map());
    if (!enabled) return () => { active = false; };
    const poll = async (): Promise<void> => {
      // Not on screen: nothing is read; the console page asks again when it is shown.
      if (document.hidden) { pollTimer = setTimeout(() => { void poll(); }, 500); return; }
      try {
        const context = request.current ?? { ...await ma2LayoutConnection(), page, start };
        if (!active || stopped.current) return; request.current = context;
        const result = await window.tbLink.readMa2Live(context);
        if (!active || stopped.current || current !== epoch.current) return;
        const next = settleFaders(pendingRef.current, result, Date.now());
        pendingRef.current = next; setPending(next); setSnapshot(result);
        pollTimer = setTimeout(() => { void poll(); }, 100);
      } catch (cause) { if (active) { fail(cause); release(); } }
    };
    void poll();
    return () => { active = false; if (pollTimer) clearTimeout(pollTimer); if (timer.current) clearTimeout(timer.current); timer.current = null; faderQueue.clear(); release(); };
  }, [page, start, scope, revision, enabled, fail, release]);
  const connect = async (username: string, password: string): Promise<void> => {
    const current = epoch.current; setConnecting(true); setError('');
    try {
      const context = { ...await ma2LayoutConnection(), page, start };
      await window.tbLink.connectMa2Live({ ...context, username, password });
      if (alive.current && current === epoch.current) setRevision(value => value + 1);
    } catch (cause) { if (current === epoch.current) fail(cause); }
    finally { if (alive.current) setConnecting(false); }
  };
  const input = (slot: number, action: Ma2LiveInput['action']): void => {
    const context = request.current;
    if (!context || stopped.current || error || !snapshot) return;
    const current = epoch.current;
    void window.tbLink.inputMa2Live({ ...context, slot, action, deadlineAt: Date.now() + 500 }).catch(cause => { if (current === epoch.current) { fail(cause); release(); } });
  };
  const setFader = (slot: number, value: number): void => {
    if (stopped.current || error || !snapshot) return;
    const next = holdFader(pendingRef.current, slot, value, Date.now()); pendingRef.current = next; setPending(next);
    queue.current.set(slot, value);
    if (!timer.current) timer.current = setTimeout(() => {
      timer.current = null;
      for (const [target, level] of queue.current) input(target, { kind: 'fader', value: level });
      queue.current.clear();
    }, MA2_FADER_SEND_MS);
  };
  return { snapshot, error, pending, connecting, connect, setFader, button: (slot: number, id: number, pressed: boolean) => input(slot, { kind: 'button', id, pressed }), release };
}
