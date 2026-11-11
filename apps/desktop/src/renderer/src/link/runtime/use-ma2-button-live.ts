import { useEffect, useState } from 'react';
import { ma2LayoutConnection } from '../stores/ma2-layout-store';
import { ma2ButtonRowAfter, type Ma2ButtonRowInput } from '../view-models/ma2-console-page';

/** How often each row is asked; the main process reads a row at most once a second however often it is asked (`buttonRead`). */
export const MA2_BUTTON_LIVE_MS = 1000;

/**
 * Reads the Button rows the console page shows, one after another, once a second, while `enabled`: only when Button keys go
 * on the web remote (`ma2-executor-channel.ts` decided it), the page is on screen and the window is shown. Otherwise
 * nothing is asked and nothing goes to the console. A row that fails says so in its cells; the next second asks again, as
 * the page's own reads do: showing is not sending, and no key is resent. While the Button session logs in again on its own
 * (C2, the main process does it; nothing here tries again) the main process says so without reading, and each row keeps
 * its last read, which turns old on screen (`ma2ButtonRowAfter`).
 */
export function useMa2ButtonLive(scope: string, rows: readonly string[], enabled: boolean): Record<string, Ma2ButtonRowInput> {
  const [live, setLive] = useState<Record<string, Ma2ButtonRowInput>>({});
  const key = rows.join(',');
  useEffect(() => {
    setLive({});
    if (!enabled || !key) return undefined;
    let current = true; let timer: ReturnType<typeof setTimeout> | undefined;
    const wanted = key.split(',').map(row => { const [page, start] = row.split(':').map(Number); return { row, page: page!, start: start! }; });
    const read = async (): Promise<void> => {
      if (!document.hidden) {
        try {
          const connection = await ma2LayoutConnection();
          for (const { row, page, start } of wanted) {
            if (!current) return;
            setLive(value => value[row] ? value : { ...value, [row]: { kind: 'reading' } });
            let answer: Parameters<typeof ma2ButtonRowAfter>[1];
            try { answer = await window.tbLink.readMa2ButtonLive({ ...connection, page, start }); }
            catch (cause) { answer = { kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) }; }
            if (!current) return;
            const answered = answer;
            // Keys on the plugin, a Button session not connected or logging in again: no other row reads anything either.
            if (answered.kind === 'off' || answered.kind === 'relogin') {
              setLive(value => Object.fromEntries(wanted.map(entry => [entry.row, ma2ButtonRowAfter(value[entry.row], answered)])));
              break;
            }
            setLive(value => ({ ...value, [row]: ma2ButtonRowAfter(value[row], answered) }));
          }
        } catch (cause) {
          const failed: Ma2ButtonRowInput = { kind: 'failed', reason: cause instanceof Error ? cause.message : String(cause) };
          if (current) setLive(Object.fromEntries(wanted.map(entry => [entry.row, failed])));
        }
      }
      if (current) timer = setTimeout(() => { void read(); }, MA2_BUTTON_LIVE_MS);
    };
    void read();
    return () => { current = false; if (timer) clearTimeout(timer); };
  }, [scope, key, enabled]);
  return live;
}
