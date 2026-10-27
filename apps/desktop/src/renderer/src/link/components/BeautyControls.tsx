import { useState } from 'react';
import { RotateCcw, Save, Trash2 } from 'lucide-react';
import { useBeautyStore } from '../stores/beauty-store';
import { beautyPresets, type BeautyControl } from './beauty-catalog';

const makeupTones = {
  lipstickTone: [{ name: '莓紫', value: -100, color: '#7a1f61' }, { name: '玫瑰', value: 0, color: '#9e1f33' }, { name: '暖橘', value: 100, color: '#b8471a' }],
  blushTone: [{ name: '冷粉', value: -100, color: '#942e61' }, { name: '蔷薇', value: 0, color: '#a8333d' }, { name: '蜜桃', value: 100, color: '#c75724' }]
};

export function BeautySlider({ control }: { control: BeautyControl }): JSX.Element {
  const value = useBeautyStore(state => state.library.values[control.key]);
  const { begin, end, change } = useBeautyStore();
  const [text, setText] = useState<string | null>(null);
  const minimum = control.signed ? -100 : 0;
  const tones = control.key === 'lipstickTone' || control.key === 'blushTone' ? makeupTones[control.key] : null;
  const commitNumber = (): void => {
    if (text !== null && text.trim() && Number.isFinite(Number(text))) change(control.key, Math.round(Math.max(minimum, Math.min(100, Number(text)))));
    setText(null); end();
  };
  return <div className={`beauty-control${control.prototype ? '' : ' is-unavailable'}`}>
    <div className="beauty-control-label"><label htmlFor={`beauty-${control.key}`}>{control.name}</label>
      <small>{control.prototype ? '' : '暂不支持'}</small>
      <button className="beauty-icon" title={`重置${control.name}`} aria-label={`重置${control.name}`} disabled={value === 0}
        onClick={() => { begin(); change(control.key, 0); end(); }}><RotateCcw size={12} /></button>
    </div>
    {tones ? <div className="beauty-tone-swatches" role="group" aria-label={`${control.name}色板`}>{tones.map(tone => <button key={tone.value}
      aria-label={`${control.name}：${tone.name}`} aria-pressed={value === tone.value}
      onClick={() => { begin(); change(control.key, tone.value); end(); }}>
      <span style={{ backgroundColor: tone.color }} />{tone.name}</button>)}</div> : null}
    <div className="beauty-control-input">
      <input id={`beauty-${control.key}`} type="range" disabled={!control.prototype} min={minimum} max={100} step={1} value={value}
        aria-describedby={`beauty-hint-${control.key}`} onFocus={begin} onPointerDown={begin}
        onChange={event => { begin(); change(control.key, Number(event.target.value)); }}
        onPointerUp={end} onPointerCancel={end} onKeyUp={end} onBlur={end} />
      <input className="beauty-number" type="number" disabled={!control.prototype} aria-label={`${control.name}数值`} min={minimum} max={100} step={1}
        value={text ?? value} onFocus={begin} onChange={event => setText(event.target.value)} onBlur={commitNumber}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') { setText(null); end(); event.stopPropagation(); } }} />
    </div>
    <p id={`beauty-hint-${control.key}`}>{control.hint}</p>
  </div>;
}

export function BeautyPresets(): JSX.Element {
  const { library, replace, savePreset, deletePreset } = useBeautyStore();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  return <section className="beauty-presets" aria-label="美颜预设">
    <div className="beauty-section-title"><strong>一键风格</strong><span>全画面统一参数</span></div>
    <div className="beauty-preset-grid">{beautyPresets.map(preset => <button key={preset.id}
      className="beauty-preset" aria-pressed={JSON.stringify(preset.values) === JSON.stringify(library.values)} onClick={() => replace(preset.values)}>
      <span>{preset.name}</span>
    </button>)}</div>
    {library.presets.length ? <div className="beauty-custom-presets">{library.presets.map(preset => <div key={preset.id}>
      <button title={preset.name} onClick={() => replace(preset.values)}>{preset.name}</button>
      <button className="beauty-icon" aria-label={`删除预设${preset.name}`} onClick={() => deletePreset(preset.id)}><Trash2 size={13} /></button>
    </div>)}</div> : null}
    {naming ? <form className="beauty-save-form" onSubmit={event => { event.preventDefault(); if (savePreset(name)) { setNaming(false); setName(''); } }}>
      <input autoFocus aria-label="美颜预设名称" placeholder="输入预设名称" maxLength={30} value={name} onChange={event => setName(event.target.value)} />
      <button className="primary-button" type="submit" disabled={!name.trim()}>保存</button>
      <button className="secondary-button" type="button" onClick={() => setNaming(false)}>取消</button>
    </form> : <button className="beauty-save-preset" onClick={() => setNaming(true)}><Save size={13} />存为我的预设</button>}
  </section>;
}
