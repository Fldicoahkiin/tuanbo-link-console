import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronRight, CircleHelp, MonitorPlay, Redo2, RotateCcw, Save, ScanFace, Undo2, UsersRound, X } from 'lucide-react';
import { neutralBeautyValues, type BeautyTarget } from '@tb/schema';
import { useBeautyStore } from '../stores/beauty-store';
import { BeautyPresets, BeautySlider } from './BeautyControls';
import { BeautyOutput, BeautyStatus } from './BeautyOutput';
import { beautyCategories, beautyControls, type BeautyCategory } from './beauty-catalog';
import { BeautyPreview } from './BeautyPreview';
import './beauty.css';
import { ownKeys } from '../keys/key-owner';

export function BeautyWorkspace({ connected }: { connected: boolean }): JSX.Element {
  const importer = useRef<HTMLInputElement>(null);
  const outputSettings = useRef<HTMLDetailsElement>(null);
  const [comparisonTarget, setComparisonTarget] = useState<BeautyTarget | null>(null);
  const [comparing, setComparing] = useState(false);
  const state = useBeautyStore();
  const [category, setCategory] = useState<BeautyCategory>('skin');
  const [changedOnly, setChangedOnly] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [help, setHelp] = useState(false);
  const [aspect, setAspect] = useState(9 / 16);
  useEffect(() => { useBeautyStore.getState().load(); }, []);
  const activeCategory = beautyCategories.find(item => item.id === category) ?? beautyCategories[0];
  const controls = beautyControls.filter(control => control.category === category && (!changedOnly || state.library.values[control.key] !== 0));
  const groups = [...new Set(controls.map(control => control.group))];
  const changed = beautyControls.filter(control => state.library.values[control.key] !== 0).length;
  const exportLibrary = (): void => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(state.library, null, 2)], { type: 'application/json' }));
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = '美颜预设.tblbeauty.json'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice('已导出当前参数和我的预设');
  };
  const importLibrary = async (file: File): Promise<void> => {
    try {
      if (file.size > 128_000) throw new Error('预设文件不能超过 128 KB');
      useBeautyStore.getState().importLibrary(await file.text());
      if (!useBeautyStore.getState().error) setNotice('已导入预设，点“保存参数”后才会保存到本机');
    } catch (error) { setFileError(String(error)); }
  };
  return <section className="beauty-workspace" style={{ '--beauty-aspect': aspect } as CSSProperties} aria-label="人像美颜" {...ownKeys('*')}>
    <div className="beauty-layout"><section className="beauty-preview-column" aria-label="美颜画面预览">
      <div className="beauty-preview-top"><span><MonitorPlay size={16} />{connected ? comparing ? '选中来源 · 美颜前后对比' : 'OBS 当前输出' : '画面预览'}</span><span>{connected ? '已连接 OBS' : '未连接 OBS'}</span></div>
      <div className="beauty-preview">{connected ? <BeautyPreview onAspectChange={setAspect} target={comparisonTarget} onComparingChange={setComparing} /> : <div className="beauty-empty-preview">
        <div className="beauty-face-frame"><ScanFace size={56} strokeWidth={1.5} /></div>
        <h3>连接 OBS 后查看画面</h3><p>先调好参数，保存成你的常用风格。<br />画面中的所有人使用同一套设置。</p>
        <span><UsersRound size={16} />自动识别人像，无需绑定成员</span>
      </div>}</div>
      <div className="beauty-preview-caption"><span><span className={`beauty-status-dot ${connected ? 'connected' : ''}`} />{connected ? comparing ? '美颜滤镜前后画面' : '显示 OBS 实际画面' : '未连接 OBS 也能调参数'}</span><span>{connected ? comparing ? '预览不影响直播画面' : '最终效果以 OBS 画面为准' : '参数还没应用到画面'}</span></div>
    </section><section className="beauty-editor" aria-label="美颜参数编辑">
      <details className="beauty-output-disclosure" ref={outputSettings}><summary>全画面美颜状态</summary><BeautyOutput connected={connected} onTarget={setComparisonTarget} /></details>
      <BeautyStatus connected={connected} onDetails={() => { if (outputSettings.current) outputSettings.current.open = true; }} />
      {help ? <div className="beauty-help"><strong>所有人统一美颜</strong><p>连接 OBS 后自动美颜整个画面，切换场景时自动跟随。不用选来源、绑定成员或点启动，拖动滑块即可调整。第一次安装组件后需要重启一次 OBS。</p></div> : null}
      <BeautyPresets />
      <nav className="beauty-category-tabs" aria-label="美颜分类">{beautyCategories.map(item => <button key={item.id}
        aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.name}</button>)}</nav>
      <div className="beauty-category-heading"><div><h3>{activeCategory?.name}</h3><p>{activeCategory?.description}</p></div>
        <button className="beauty-icon" title="重置当前分类" aria-label="重置当前分类" onClick={() => {
          const values = { ...state.library.values }; for (const control of beautyControls) if (control.category === category) values[control.key] = 0; state.replace(values);
        }}><RotateCcw size={16} /></button></div>
      <label className="beauty-modified-filter"><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.target.checked)} />只看已调整<span>{changed} 项</span></label>
      <div className="beauty-controls-scroll" key={category}>{groups.map(group => <section key={group} className="beauty-control-group">
        <h4>{group}</h4>{controls.filter(control => control.group === group).map(control => <BeautySlider key={control.key} control={control} />)}
      </section>)}{!controls.length ? <p className="beauty-no-changes">这一类还没有调整过</p> : null}</div>
      <div className="beauty-editor-tools"><button className="beauty-icon" aria-label="撤销美颜调整" disabled={!state.past.length} onClick={state.undo}><Undo2 size={16} /></button>
        <button className="beauty-icon" aria-label="重做美颜调整" disabled={!state.future.length} onClick={state.redo}><Redo2 size={16} /></button>
        <button onClick={() => state.replace({ ...neutralBeautyValues })}><RotateCcw size={16} />全部归零</button></div>
    </section></div>
    {state.error || fileError ? <div className="beauty-error" role="alert">{state.error ?? fileError}<button onClick={() => { state.clearError(); setFileError(null); }} aria-label="关闭美颜错误提示"><X size={16} /></button></div> : null}
    <footer className="beauty-footer"><div className="beauty-file-actions"><button onClick={() => importer.current?.click()}><ArrowUpFromLine size={16} />导入</button><button onClick={exportLibrary}><ArrowDownToLine size={16} />导出</button></div>
      <button className="beauty-icon" aria-label="美颜功能说明" aria-expanded={help} onClick={() => setHelp(!help)}><CircleHelp size={16} /></button>
      <span className="beauty-save-status" role="status" aria-label="美颜保存状态">{notice || (state.saved ? '参数已保存到本机' : '参数还没保存')}</span>
      <button className="primary-button" onClick={() => { state.save(); setNotice(''); }}>{state.saved ? <Check size={16} /> : <Save size={16} />}保存参数<ChevronRight size={16} /></button>
    </footer>
    <input hidden type="file" ref={importer} accept=".json" aria-label="导入美颜预设文件" onChange={event => {
      const file = event.target.files?.[0]; if (file) { setFileError(null); void importLibrary(file); } event.target.value = '';
    }} />
  </section>;
}
