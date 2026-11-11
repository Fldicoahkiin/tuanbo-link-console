import { useRef, useState } from 'react';
import type { Ma2ExecutorChannelKind } from '@tb/schema';
import { Menu, MenuItem, MenuNote } from '../ui';
import { ma2KeyChannelLabel, type Ma2ExecutorChannelState } from '../runtime/use-ma2-executor-channel';
import './ma2-executor-channel.css';

/**
 * The line a Button band's keys go on (M7), in its header. The label says what is used now; for 101–190 it opens a
 * small menu to choose the console plugin (as in 0.5.8) or the web remote; choosing the web remote reads the Button
 * area, and the label then says what was read. 191 and up always use the plugin and show no menu.
 */
export function Ma2KeyChannelMenu({ state, start, onChoose, onError }: {
  state: Ma2ExecutorChannelState; start: number; onChoose: (choice: Ma2ExecutorChannelKind) => Promise<void>; onError: (message: string) => void;
}): JSX.Element {
  const label = ma2KeyChannelLabel(state, start);
  const anchor = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  if (start > 190 || state.kind === 'unknown') return <span className="ma2-executor-band-channel" data-tone={label.tone} title={label.title}>{label.text}</span>;
  const { channel } = state;
  const choose = (choice: Ma2ExecutorChannelKind): void => {
    setAt(null);
    if (choice !== channel.choice) void onChoose(choice).catch((cause: unknown) => onError(cause instanceof Error ? cause.message : String(cause)));
  };
  return <>
    <button ref={anchor} type="button" className="ma2-executor-band-channel" data-tone={label.tone} title={label.title} aria-haspopup="menu" aria-expanded={at !== null}
      onClick={() => {
        if (at) { setAt(null); return; }
        const box = anchor.current?.getBoundingClientRect();
        if (box) setAt({ x: box.left, y: box.bottom });
      }}>{label.text}</button>
    {at ? <Menu x={at.x} y={at.y} label="Button 区按键走哪条" title="Button 区按键走哪条" anchor={anchor.current} onClose={() => setAt(null)}>
      <MenuItem checked={channel.choice === 'plugin'} onSelect={() => choose('plugin')}>控台插件</MenuItem>
      <MenuItem checked={channel.choice === 'webRemote'} onSelect={() => choose('webRemote')}>网页遥控（同步时不用等）</MenuItem>
      {channel.choice === 'plugin' ? <MenuNote>选了会去读一次控台的 Button 区，读不回时照旧走控台插件</MenuNote>
        : channel.webRemote.ready ? null : <MenuNote>{channel.webRemote.reason}</MenuNote>}
    </Menu> : null}
  </>;
}
