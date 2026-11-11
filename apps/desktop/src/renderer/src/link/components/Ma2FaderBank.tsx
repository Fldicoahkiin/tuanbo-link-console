import { useState, type ReactNode, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Ma2ExecutorPage, Ma2LiveSnapshot } from '@tb/schema';
import { useMa2LivePlayback } from './useMa2LivePlayback';
import '../ma2-faders.css';
import { ownKeys } from '../keys/key-owner';

type LiveButton = Ma2LiveSnapshot['items'][number]['blocks'][number]['buttons'][number];
function FaderButton({ value, slot, disabled, send }: { value: LiveButton; slot: number; disabled: boolean; send: (slot: number, id: number, pressed: boolean) => void }): JSX.Element {
  const press = (event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); send(slot, value.id, true);
  };
  return <button disabled={disabled || value.name === 'Empty'} className="ma2-fader-key" data-active={value.active} aria-label={`执行器 ${slot} ${value.name}`} {...ownKeys('Space', 'Enter')}
    onPointerDown={press} onPointerUp={() => send(slot, value.id, false)} onPointerCancel={() => send(slot, value.id, false)} onLostPointerCapture={() => send(slot, value.id, false)}
    onKeyDown={event => { if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) { event.preventDefault(); send(slot, value.id, true); } }}
    onKeyUp={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); send(slot, value.id, false); } }}
    onBlur={() => send(slot, value.id, false)}>{value.name === 'Empty' ? '—' : value.name}</button>;
}
export function Ma2FaderBank({ page, scope, toolbarHost, renderItem }: {
  toolbarHost: HTMLElement | null;
  page: Ma2ExecutorPage; scope: string; renderItem: (item: Ma2ExecutorPage['items'][number], page: number) => ReactNode;
}): JSX.Element {
  const [start, setStart] = useState(1);
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  const live = useMa2LivePlayback(page.page, start, scope);
  const items = new Map(page.items.map(item => [item.slot, item]));
  const continuation = new Set(page.items.flatMap(item => Array.from({ length: item.width - 1 }, (_, index) => item.slot + index + 1)));
  const slots = Array.from({ length: 15 }, (_, index) => start + index);
  const liveStatus = live.error ? '实时读取已停止' : !live.snapshot ? '连接实时推杆…' : live.pending.size ? '等待控台返回' : '实时已连接';
  return <div className="ma2-fader-bank">
    {toolbarHost ? createPortal(<div className="ma2-fader-bank-toolbar">
      <select aria-label="推杆范围" title="切换推杆范围" value={start} onChange={event => setStart(Number(event.target.value))}>{[1, 16, 31, 46, 61, 76].map(value => <option key={value} value={value}>{value}–{value + 14}</option>)}</select>
      <span className="ma2-fader-live-state" role="status" aria-label={liveStatus} title={liveStatus} data-state={live.error ? 'error' : !live.snapshot || live.pending.size ? 'waiting' : 'connected'}>{live.error ? '已停止' : !live.snapshot ? '连接中' : live.pending.size ? '读取中' : '实时'}</span>
    </div>, toolbarHost) : null}
    {live.error ? <div className="ma2-fader-login"><p role="alert">{live.error}</p><form onSubmit={event => { event.preventDefault(); void live.connect(username, password).then(() => setPassword('')); }}>
      <input aria-label="实时推杆用户" autoComplete="off" placeholder="控台普通用户名" value={username} onChange={event => setUsername(event.target.value)} disabled={live.connecting}/>
      <input aria-label="实时推杆密码" type="password" autoComplete="off" placeholder="密码（如有）" value={password} onChange={event => setPassword(event.target.value)} disabled={live.connecting}/>
      <button disabled={live.connecting || !username.trim()}>{live.connecting ? '连接中…' : '连接实时推杆'}</button>
    </form><small>请在控台把 Remotes 设为 Login Enabled，并使用非 Administrator 用户。密码只保存在这台电脑上。</small></div> : null}
    <div className="ma2-fader-grid" aria-label={`推杆第 ${page.page} 页`}>
      {slots.map(slot => {
        if (continuation.has(slot)) return null;
        const item = items.get(slot); const state = live.snapshot?.items.find(value => value.slot === slot);
        const width = item?.width ?? state?.width ?? 1;
        return <div className="ma2-fader-strip" key={slot} data-executor-slot={slot} data-empty={!item && !state?.objectNumber} data-group-start={(slot - start) % 5 === 0 && slot !== start} data-running={state?.running} style={{ gridColumn: `${slot - start + 1} / span ${width}` }}>
          <div className="ma2-fader-heading"><span title={`推杆第 ${page.page} 页 · ${slot} 格`}>{page.page}.{slot}</span>{item ? renderItem(item, page.page) : <span className="ma2-fader-empty">空</span>}</div>
          <div className="ma2-fader-current" title={state?.cue}>{state?.cue || '—'}</div>
          <div className="ma2-fader-blocks">{Array.from({ length: width }, (_, index) => {
            const target = slot + index; const block = state?.blocks.find(value => value.slot === target); const fader = block?.fader;
            const pending = live.pending.get(target); const disabled = !!live.error || !live.snapshot;
            const key = (id: number): ReactNode => { const value = block?.buttons.find(button => button.id === id); return value ? <FaderButton value={value} slot={target} disabled={disabled} send={live.button}/> : <div className="ma2-fader-key-placeholder"/>; };
            return <div className="ma2-fader-block" key={target}>{key(2)}{key(1)}
              <span className="ma2-fader-function">{fader?.name || '—'}</span>
              <input className="ma2-fader-slider" aria-label={`推杆 ${page.page}.${target}`} aria-orientation="vertical" type="range" min={fader?.min ?? 0} max={fader?.max ?? 1} step={fader ? (fader.max - fader.min) / 1000 : 0.001}
                value={pending?.value ?? fader?.value ?? 0} disabled={disabled || !fader} onChange={event => live.setFader(target, event.target.valueAsNumber)}/>
              <output title={pending ? `控台当前值：${fader?.text || '—'}` : undefined}>{pending ? '等待控台确认' : fader?.text || '—'}</output>{key(0)}
            </div>;
          })}</div>
        </div>;
      })}
    </div>
  </div>;
}
