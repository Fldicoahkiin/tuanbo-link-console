import { useEffect } from 'react';
import { create } from 'zustand';
import { beautyBasicValuesSchema, beautyFilterStateSchema, beautyRuntimeSchema, type BeautyFilterState, type BeautyRuntimeState } from '@tb/schema';
import { useBeautyStore } from '../stores/beauty-store';
import { linkDesktopViewModel as desktop } from '../view-models/link-desktop-view-model';

export const useBeautyOutputState = create<{
  confirmed: BeautyFilterState | null; runtime: BeautyRuntimeState | null; error: string; busy: boolean;
}>(() => ({ confirmed: null, runtime: null, error: '', busy: false }));

/** Lives in LinkApp: navigation never stops output processing or parameter delivery. */
export function useBeautyOutput(connected: boolean): void {
  useEffect(() => { useBeautyStore.getState().load(); }, []);
  useEffect(() => {
    let cancelled = false, sending = false, revision = 0;
    useBeautyOutputState.setState({ confirmed: null, error: '', busy: false });
    const send = async (): Promise<void> => {
      revision++;
      if (sending || !connected || cancelled) return;
      sending = true; useBeautyOutputState.setState({ busy: true });
      let handled = -1;
      try {
        while (!cancelled && handled !== revision) {
          handled = revision;
          const values = beautyBasicValuesSchema.parse(useBeautyStore.getState().library.values);
          const result = await desktop.syncBeautyOutput(values);
          if (!cancelled) useBeautyOutputState.setState({ confirmed: result ? beautyFilterStateSchema.parse(result) : null, error: '' });
        }
      } catch (error) {
        if (!cancelled) useBeautyOutputState.setState({ confirmed: null, error: String(error) });
      } finally {
        sending = false;
        if (!cancelled) useBeautyOutputState.setState({ busy: false });
      }
    };
    const unsubscribe = useBeautyStore.subscribe((next, previous) => {
      if (next.library.values !== previous.library.values) void send();
    });
    void send();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const runtime = beautyRuntimeSchema.parse(await desktop.readBeautyRuntime());
        if (cancelled) return;
        useBeautyOutputState.setState({ runtime });
        const confirmed = useBeautyOutputState.getState().confirmed;
        if (connected && runtime.sourceName && runtime.filterName &&
          (!confirmed || confirmed.sourceName !== runtime.sourceName || confirmed.filterName !== runtime.filterName) &&
          (runtime.phase === 'tracking' || runtime.phase === 'waiting')) {
          const next = beautyFilterStateSchema.parse(await desktop.readObsBeauty({ sourceName: runtime.sourceName, filterName: runtime.filterName }));
          // A read begun before a parameter write may return after its acknowledgement.
          // Keep the newer confirmation, including across changes of source.
          if (!cancelled && !sending && useBeautyOutputState.getState().confirmed === confirmed)
            useBeautyOutputState.setState({ confirmed: next });
        }
        if (!cancelled) timer = setTimeout(() => { void poll(); }, 500);
      } catch (error) {
        if (!cancelled) useBeautyOutputState.setState({ error: `无法确认全画面美颜状态：${String(error)}` });
      }
    };
    void poll();
    return () => { cancelled = true; unsubscribe(); clearTimeout(timer); };
  }, [connected]);
}
