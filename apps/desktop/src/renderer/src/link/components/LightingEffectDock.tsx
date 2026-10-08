import { createPortal } from 'react-dom';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Layers, Sun, ScanLine, Sparkles } from 'lucide-react';
import type { LightingDocument } from '@tb/schema';
import { LightingUserLibrary, type LibraryDraft } from './LightingUserLibrary';
import { Ma2SequencePreview } from './Ma2SequencePreview';
import { Ma2CachedBrowser } from './Ma2CachedBrowser';
import { useMa2ReadStore } from '../stores/ma2-read-store';
import { useLightingCueSplit } from './LightingLibrarySplitter';
import { LightingCueComposer, cueIngredients, saveCueIngredients, type CueIngredient } from './LightingCueComposer';
import { CONSOLE_CUE_DRAG, consoleCueDragSchema } from './lighting-material-drag';
import '../lighting-cue-composer.css';

export const EFFECT_DRAG = 'application/x-tblink-lighting-effect';
export function LightingEffectDock({ onCreated, document, disabled, onChange, eventId, ms, durationMs, onNew, headerActions, externalPanel, onLibrary, pointDetails, sidebarHost, playbackSettings, onAuditionTemplate, onStamp }: {
  onCreated: (document: LightingDocument, id: string) => void;
  sidebarHost: HTMLDivElement | null; playbackSettings: ReactNode; onAuditionTemplate: (id: string) => void; auditionStatus: string;
  pointDetails: boolean; cueSelectionVersion: number; externalPanel?: ReactNode; onLibrary: () => void; headerActions?: ReactNode; document: LightingDocument; disabled: boolean; eventId?: string | undefined; ms: number; durationMs: number; onNew: () => void;
  onStamp: (id: string) => void; onChange: (document: LightingDocument, label: string) => boolean | void;
}): JSX.Element {
  const split = useLightingCueSplit();
  const [section, setSection] = useState<'console' | 'front' | 'rim' | 'effect'>('console');
  const [draft, setDraft] = useState<LibraryDraft | null>(null);
  const [templateId, setTemplateId] = useState<string>();
  const [ingredients, setIngredients] = useState<CueIngredient[]>([]);
  const [draftOpen, setDraftOpen] = useState(false);
  const [error, setError] = useState('');
  const browserOpen = useMa2ReadStore(state => state.browserOpen);
  const loaded = useRef('');
  useEffect(() => {
    const events = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events.filter(event => eventId && (event.id === eventId || event.effectGroupId === eventId))));
    const key = `${eventId ?? ''}:${JSON.stringify(events)}`;
    if (loaded.current === key) return;
    loaded.current = key;
    if (eventId) { setIngredients(cueIngredients(document, eventId)); setTemplateId(undefined); setDraftOpen(false); }
  }, [eventId, document]);
  const editorOpen = Boolean(eventId || templateId || draftOpen);
  const commitIngredients = (values: CueIngredient[]): void => {
    if (disabled) return;
    try {
      if (eventId) {
        const target = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(event => event.id === eventId);
        if (!target || !('label' in target)) throw new Error('当前 Cue 已不存在，请重新选择');
        const next = saveCueIngredients(document, values, target.label, ms, durationMs, eventId);
        if (onChange(next, '修改 Cue 素材') === false) { setError('保存失败，请处理提示后重试'); return; }
      } else if (!templateId) {
        const id = crypto.randomUUID();
        const next = saveCueIngredients(document, values, '', ms, durationMs, id);
        if (onChange(next, '添加 Cue 素材') === false) { setError('保存失败，请处理提示后重试'); return; }
        onCreated(next, id);
      }
      setIngredients(values); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const append = (values: CueIngredient[]): void => {
    if (disabled) return;
    commitIngredients(editorOpen ? [...ingredients, ...values] : values);
  };
  const addConsoleCue = (sequence: number, cue: string, name: string, executor: string): void => append([{ name, sequence, cue, executor, delayMs: 0 }]);
  const addIngredient = (id: string): void => {
    const entry = document.templates.find(value => value.id === id);
    const binding = entry?.track.cueStamp;
    if (!entry || binding?.mode !== 'fixed') { setError('此素材没有可用的 Cue 引用'); return; }
    append(entry.members?.map(value => ({ ...value })) ?? [{ name: entry.name, sequence: binding.sequence, cue: binding.cue, executor: binding.executor, delayMs: 0 }]);
  };
  const close = (): void => { onNew(); setTemplateId(undefined); setDraftOpen(false); setIngredients([]); setError(''); };
  const navigation = <nav className="lighting-material-navigation" aria-label="灯光素材主菜单">
    {([['console', '控台素材', Layers], ['front', '面光', Sun], ['rim', '轮廓', ScanLine], ['effect', '效果', Sparkles]] as const).map(([value, name, Icon]) => <button key={value} data-section={value} aria-pressed={section === value && !externalPanel} onClick={() => { setSection(value); if (externalPanel) onLibrary(); }}><Icon /><span>{name}</span></button>)}
  </nav>;
  const sidebar = <div className="lighting-workbench-nav effect-library-actions">{navigation}<details className="lighting-playback-settings"><summary>更多</summary>{headerActions}{playbackSettings}</details></div>;
  return <section className="lighting-effect-dock lighting-material-layout" style={split.style} aria-label="灯光效果库" data-editor={editorOpen} data-sidebar={Boolean(sidebarHost)} data-panel={Boolean(externalPanel || browserOpen)}>
    {sidebarHost ? createPortal(sidebar, sidebarHost) : navigation}
    {browserOpen ? <Ma2CachedBrowser disabled={disabled} notify={setError} onClose={() => useMa2ReadStore.setState({ browserOpen: false })} /> : externalPanel || <>
      <div className="cue-material-browser">{section === 'console' ? <Ma2SequencePreview document={document} onClose={() => setSection('front')} onUse={addConsoleCue} onClassify={value => { setDraft(value); setSection('front'); }} composing={editorOpen} /> : <LightingUserLibrary section={section} document={document} draft={draft} onDraftClose={() => setDraft(null)} onBrowse={() => setSection('console')} onAudition={onAuditionTemplate} onCueUse={addConsoleCue} composing={editorOpen} onStamp={id => editorOpen ? addIngredient(id) : onStamp(id)} onCompose={id => { onNew(); setTemplateId(id); setDraftOpen(true); const entry = document.templates.find(value => value.id === id); const binding = entry?.track.cueStamp; setIngredients(entry?.members?.map(value => ({ ...value })) ?? (entry && binding?.mode === 'fixed' ? [{ name: entry.name, sequence: binding.sequence, cue: binding.cue, executor: binding.executor, delayMs: 0 }] : [])); }} />}</div>
      {editorOpen ? <>{split.separator}<LightingCueComposer key={eventId ?? templateId ?? 'draft'} details={pointDetails} templateId={templateId} document={document} eventId={eventId} ms={ms} durationMs={durationMs} ingredients={ingredients} onIngredients={commitIngredients} onChange={onChange} onNew={close} disabled={disabled} onDropMaterial={transfer => {
        try {
          const effect = transfer.getData(EFFECT_DRAG);
          if (effect) { addIngredient(effect); return; }
          const raw = transfer.getData(CONSOLE_CUE_DRAG);
          if (raw) { const value = consoleCueDragSchema.parse(JSON.parse(raw)); addConsoleCue(value.sequence, value.cue, value.name, value.executor); }
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
      }} /></> : null}
    </>}
    {error ? <p className="cue-library-error" role="alert">{error}</p> : null}
  </section>;
}
