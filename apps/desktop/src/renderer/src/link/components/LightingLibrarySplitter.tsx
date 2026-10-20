import { useState, type CSSProperties } from 'react';

export function useLightingCueSplit() {
  const [ratio, setRatio] = useState(0.65);
  const style = { '--library-share': `${ratio}fr`, '--cue-share': `${1 - ratio}fr` } as CSSProperties;
  const limit = (value: number): number => Math.max(0.35, Math.min(0.65, value));
  const separator = <button className="lighting-cue-splitter" role="separator" aria-label="调整素材库和 Cue 编辑区宽度" aria-orientation="vertical" aria-valuemin={35} aria-valuemax={65} aria-valuenow={Math.round(ratio * 100)}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const box = event.currentTarget.parentElement?.getBoundingClientRect(); if (box) setRatio(limit((event.clientX - box.left) / box.width)); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setRatio(value => limit(value + (event.key === 'ArrowLeft' ? -0.03 : 0.03))); } if (event.key === 'Home') { event.preventDefault(); setRatio(0.65); } }}
    onDoubleClick={() => setRatio(0.65)}><span /></button>;
  return { style, separator };
}

export function useLightingLibrarySplit() {
  const [ratio, setRatio] = useState(0.68);
  const [adjusted, setAdjusted] = useState(false);
  const resize = (value: number): void => { setAdjusted(true); setRatio(Math.max(0.25, Math.min(0.8, value))); };
  const reset = (): void => { setAdjusted(false); setRatio(0.68); };
  const minimumLibrary = adjusted ? '220px' : 'min(560px, calc(100% - 168px))';
  const style: CSSProperties = { gridTemplateRows: `minmax(${minimumLibrary}, ${ratio * 100}fr) 8px minmax(160px, ${(1 - ratio) * 100}fr)` };
  const separator = <button className="lighting-library-splitter" role="separator" aria-label="调整效果库和时间线高度" aria-orientation="horizontal" aria-valuemin={25} aria-valuemax={80} aria-valuenow={Math.round(ratio * 100)}
    onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (!event.currentTarget.hasPointerCapture(event.pointerId)) return; const parent = event.currentTarget.parentElement; const box = parent?.getBoundingClientRect(); if (box) resize((event.clientY - box.top) / (box.bottom - box.top)); }}
    onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }}
    onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); resize(ratio + (event.key === 'ArrowUp' ? -0.03 : 0.03)); } if (event.key === 'Home') { event.preventDefault(); reset(); } }} onDoubleClick={reset}><span /></button>;
  return { style, separator };
}
