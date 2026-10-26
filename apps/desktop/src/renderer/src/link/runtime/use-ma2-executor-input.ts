import { useEffect, useRef, useState } from 'react';
import type { Ma2ExecutorInput, Ma2ExecutorPage } from '@tb/schema';
import { ma2ExecutorFunctions } from '@tb/core/link';
import { currentMa2LayoutScope, ma2LayoutConnection } from '../stores/ma2-layout-store';

type HeldKey = { sessionId: string; scope: string; address: string; released: boolean; timer?: ReturnType<typeof setInterval>; payload?: Ma2ExecutorInput; busy: boolean; releasePromise?: Promise<void> };
type ExecutorInputController = {
  press: (item: Ma2ExecutorPage['items'][number], page: number, button: number) => void;
  release: (item: Ma2ExecutorPage['items'][number], page: number, button: number) => void;
  releaseAll: () => void;
};
/** One controller per page, not one network connection per button. */
export function createMa2ExecutorInput(onError: (message: string) => void): ExecutorInputController {
  const held = new Map<string, HeldKey>();
  const active = new Set<HeldKey>();
  const report = (cause: unknown): void => onError(cause instanceof Error ? cause.message : String(cause));
  const send = async (state: HeldKey, pressed: boolean): Promise<void> => {
    if (!state.payload) return;
    await window.tbLink.inputMa2Executor({ ...state.payload, pressed, deadlineAt: Date.now() + 1200 });
  };
  const stop = (state: HeldKey): void => {
    state.released = true;
    if (state.timer) clearInterval(state.timer);
    if (held.get(state.address) === state) held.delete(state.address);
    if (state.payload && !state.releasePromise) {
      // The main process cancels this session's queued press before dispatching
      // release, even if its press acknowledgement is still pending.
      state.releasePromise = send(state, false).catch(report).finally(() => { active.delete(state); });
    } else if (!state.busy) active.delete(state);
  };
  const fail = (state: HeldKey, cause: unknown): void => {
    if (!(state.released && cause instanceof Error && cause.message.includes('按键已松开，已取消排队的按下'))) report(cause);
    stop(state);
  };
  const release = (item: Ma2ExecutorPage['items'][number], page: number, button: number): void => {
    const state = held.get(`${page}.${item.slot}:${button}`);
    if (state) stop(state);
  };
  const press = (item: Ma2ExecutorPage['items'][number], page: number, button: number): void => {
    const address = `${page}.${item.slot}:${button}`;
    const code = item.buttons?.[button] ?? (button === 0 ? item.button : null);
    const momentary = code !== null && code !== undefined && ma2ExecutorFunctions[code]?.momentary === true;
    if (momentary && held.has(address)) return;
    const state: HeldKey = { sessionId: crypto.randomUUID(), scope: currentMa2LayoutScope(), address, released: false, busy: true };
    active.add(state);
    if (momentary) held.set(address, state);
    const deadlineAt = Date.now() + 1200;
    void (async () => {
      const connection = await ma2LayoutConnection();
      if (state.released || state.scope !== currentMa2LayoutScope()) { stop(state); return; }
      if (Date.now() > deadlineAt) throw new Error('按键操作已过期，没有补发，请重新点一次');
      state.payload = { ...connection, page, slot: item.slot, expectedItem: item, button, pressed: true, sessionId: state.sessionId, deadlineAt };
      await window.tbLink.inputMa2Executor(state.payload);
      if (!momentary || state.released || state.scope !== currentMa2LayoutScope()) { stop(state); return; }
      state.timer = setInterval(() => {
        if (state.scope !== currentMa2LayoutScope()) { stop(state); return; }
        if (state.released || state.busy) return;
        state.busy = true;
        void send(state, true).then(() => {
          if (state.scope !== currentMa2LayoutScope()) stop(state);
        }).catch((cause: unknown) => { fail(state, cause); }).finally(() => {
          state.busy = false;
        });
      }, 500);
    })().catch((cause: unknown) => { fail(state, cause); }).finally(() => {
      state.busy = false;
      if (!state.payload) active.delete(state);
    });
  };
  const releaseAll = (): void => {
    const hadActive = active.size > 0;
    for (const state of active) stop(state);
    if (hadActive) void window.tbLink.releaseMa2Executors().catch(report);
  };
  return { press, release, releaseAll };
}

export function useMa2ExecutorInput(onError: (message: string) => void): ExecutorInputController {
  const error = useRef(onError); error.current = onError;
  const [controller] = useState(() => createMa2ExecutorInput(message => error.current(message)));
  const scope = currentMa2LayoutScope();
  useEffect(() => {
    window.addEventListener('blur', controller.releaseAll);
    return () => { window.removeEventListener('blur', controller.releaseAll); controller.releaseAll(); };
  }, [scope, controller]);
  return controller;
}
