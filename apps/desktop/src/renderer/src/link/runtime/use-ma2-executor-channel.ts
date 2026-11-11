import { useCallback, useEffect, useState } from 'react';
import type { Ma2ExecutorChannel, Ma2ExecutorChannelKind } from '@tb/schema';
import { ma2LayoutConnection } from '../stores/ma2-layout-store';
import { setMa2KeyChannelChoice, useMa2KeyChannelPreference } from './ma2-realtime-preference';

/** What the page knows about the line Button area keys go on (M7): chosen in the main process, shown as it is. */
export type Ma2ExecutorChannelState = { kind: 'channel'; channel: Ma2ExecutorChannel } | { kind: 'unknown'; reason: string };

let told: Ma2ExecutorChannelKind | null = null;
/** Tells the main process this computer's choice once per run, before keys are pressed; it starts on the plugin. */
export async function syncMa2KeyChannel(): Promise<void> {
  const { choice } = useMa2KeyChannelPreference.getState();
  if (told === choice) return;
  await window.tbLink.chooseMa2ExecutorChannel({ choice });
  told = choice;
}
/** The operator changes the choice: keys held are let go in the main process first, then it is kept on this computer. */
export async function chooseMa2KeyChannel(choice: Ma2ExecutorChannelKind): Promise<void> {
  await window.tbLink.chooseMa2ExecutorChannel({ choice });
  told = choice;
  setMa2KeyChannelChoice(choice);
}

/** Button area keys' channel on the connected console, asked again every 2 s while the page is shown. */
export function useMa2ExecutorChannel(scope: string, enabled: boolean): { state: Ma2ExecutorChannelState | null; choose: (choice: Ma2ExecutorChannelKind) => Promise<void> } {
  const [state, setState] = useState<Ma2ExecutorChannelState | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!enabled) { setState(null); return; }
    let current = true;
    const read = async (): Promise<void> => {
      try {
        await syncMa2KeyChannel();
        const channel = await window.tbLink.readMa2ExecutorChannel(await ma2LayoutConnection());
        if (current) setState({ kind: 'channel', channel });
      } catch (cause) {
        if (current) setState({ kind: 'unknown', reason: cause instanceof Error ? cause.message : String(cause) });
      }
    };
    void read();
    const timer = setInterval(() => { void read(); }, 2000);
    return () => { current = false; clearInterval(timer); };
  }, [scope, enabled, version]);
  const choose = useCallback(async (choice: Ma2ExecutorChannelKind): Promise<void> => {
    await chooseMa2KeyChannel(choice);
    setVersion(value => value + 1);
  }, []);
  return { state, choose };
}

/** The label for a Button band showing slots from `start`: 191 and up always use the plugin. */
export function ma2KeyChannelLabel(state: Ma2ExecutorChannelState, start: number): { text: string; title: string; tone: 'normal' | 'warning' } {
  if (start > 190) return { text: '按键：控台插件', title: '191 以后的格子网页遥控读不了，一直走控台插件', tone: 'normal' };
  if (state.kind === 'unknown') return { text: '按键通道无法确认', title: state.reason, tone: 'warning' };
  const { channel } = state;
  if (channel.kind === 'webRemote') return { text: '按键：网页遥控', title: channel.reason, tone: 'normal' };
  if (channel.choice === 'plugin') return { text: '按键：控台插件', title: `${channel.reason}。${channel.webRemote.reason}`, tone: 'normal' };
  return { text: `按键：控台插件（${channel.webRemote.reason}）`, title: channel.webRemote.reason, tone: 'warning' };
}
