import { useEffect } from 'react';
import { toUserErrorMessage, type LinkRuntimeState } from '@tb/core/link';
import type { LinkShowActivity } from '@tb/schema';
import { useRuntimeStore } from '../stores/runtime-store';
import { useMa2SyncStore } from '../stores/ma2-sync-store';
import { useShowStateStore } from '../stores/show-state-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

/** What this window knows about the show and main does not: P1 following while its runtime is not idle, and the
 * editor's or the lighting workbench's own preview playing. */
export function showActivity(runtime: { state: LinkRuntimeState; currentItemId: string | null }, previewPlaying: boolean): LinkShowActivity {
  return { version: 1, p1: runtime.state === 'idle' ? null : { state: runtime.state, itemId: runtime.currentItemId }, preview: previewPlaying };
}

/**
 * Keeps useShowStateStore equal to the main process's show state, and reports this window's part of it on every
 * change. Once for the whole window (LinkApp). A report that does not arrive is shown in red once per cause and logged
 * by main; nothing retries it, the next change sends the whole activity again.
 */
export function useShowStateMirror(notify: (message: string, tone: 'info' | 'error') => void): void {
  useEffect(() => {
    let pushed = false, alive = true;
    const stop = desktop.onShowState(show => { pushed = true; useShowStateStore.setState({ show }); });
    // A change pushed before the first read answered is newer than that answer.
    void desktop.getShowState().then(show => { if (alive && !pushed) useShowStateStore.setState({ show }); },
      (error: unknown) => { if (alive) notify(`没读到节目现在的状态，按钮可能慢一步变灰；这时不能做的操作照样会被挡住。再出现请重启联动台。原因：${toUserErrorMessage(error)}`, 'error'); });
    return () => { alive = false; stop(); };
  }, [notify]);
  useEffect(() => {
    // The lights-off read-back (M8): only the status details show it, so a first read that fails stays in the log.
    let pushed = false, alive = true;
    const stop = desktop.onLightingOffCheck(lightingOff => { pushed = true; useShowStateStore.setState({ lightingOff }); });
    void desktop.getLightingOffCheck().then(lightingOff => { if (alive && !pushed) useShowStateStore.setState({ lightingOff }); },
      (error: unknown) => { console.error('没读到关灯读回的状态', error); });
    return () => { alive = false; stop(); };
  }, []);
  useEffect(() => {
    let last = '';
    const report = (): void => {
      const activity = showActivity(useRuntimeStore.getState(), useMa2SyncStore.getState().previewPlaying), text = JSON.stringify(activity);
      if (text === last) return;
      last = text;
      void desktop.reportShowActivity(activity).catch((error: unknown) => {
        notify(`跟 P1 或预览的状态没记上，这期间控台操作可能不会等它停下。再出现请重启联动台。原因：${toUserErrorMessage(error)}`, 'error');
      });
    };
    report();
    const stopRuntime = useRuntimeStore.subscribe(report), stopPreview = useMa2SyncStore.subscribe(report);
    return () => { stopRuntime(); stopPreview(); };
  }, [notify]);
}
