import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { X, RefreshCw } from 'lucide-react';
import { classifyMa2Attributes, ma2AttributeRoles, ma2CueAttributeState, type ConsoleCueReference } from '@tb/core/link';
import type { Ma2CueContent } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { readMa2Attributes, useMa2AttributeStore } from '../stores/ma2-attribute-store';
import '../lighting-attributes.css';

const stateNames = { unread: '还没读取', partial: '读取不完整', failed: '这次读取失败 · 显示的是上次结果', complete: '本步属性已读取', empty: '空 Cue · 本步无属性或命令', tracking: '本步无属性 · 可能继承其他 Cue', commands: '本步无灯具属性 · 含命令或播放设置' } as const;
function StoredContent({ content }: { content: Ma2CueContent }): JSX.Element {
  const [limit, setLimit] = useState(30);
  const grouped = new Map<string, { row: Ma2CueContent['rows'][number]; fixtures: string[] }>();
  for (const row of content.rows) {
    const key = JSON.stringify([row.attribute, row.valuePart, row.effectPart, row.layers]);
    const id = [row.fixtureId ? `灯具 ${row.fixtureId}` : row.channelId ? `通道 ${row.channelId}` : '编号未识别', row.subfixture ? `子灯具 ${row.subfixture}` : ''].filter(Boolean).join(' · ');
    const existing = grouped.get(key);
    if (existing) existing.fixtures.push(id); else grouped.set(key, { row, fixtures: [id] });
  }
  const entries = [...grouped.entries()];
  return <details><summary>具体属性值与引用 · {content.rows.length} 条</summary><div className="cue-stored-content">{entries.slice(0, limit).map(([key, {row,fixtures}]) => <section key={key}>
    <strong>{row.attribute || '属性名称未识别'}</strong><small>值 Part {row.valuePart ?? '未提供'} · 效果 Part {row.effectPart ?? '未提供'}</small>
    <p>{[...new Set(fixtures)].join('、')}</p>
    <dl>{row.layers.map((layer,index) => <div key={index}><dt>{layer.path}</dt><dd>{[layer.value, ...Object.entries(layer.properties).map(([name,value]) => `${name}=${value}`)].filter(Boolean).join(' · ') || '（容器）'}</dd></div>)}</dl>
  </section>)}</div>{entries.length > limit ? <button onClick={() => setLimit(current => current + 30)}>继续显示 · 剩余 {entries.length - limit} 组</button> : null}</details>;
}

export function LightingCueAttributes({ refs, title, onClose }: { refs: ConsoleCueReference[]; title: string; onClose: () => void }): JSX.Element {
  const project = useDocumentStore(state => state.project);
  const pool = project?.ma2MaterialLibrary?.library;
  const reader = useMa2AttributeStore();
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const rows = refs.flatMap(ref => {
    const sequence = pool?.sequences.find(value => value.sequence === ref.sequence);
    return sequence?.cues.filter(cue => ref.kind === 'sequence' || Number(cue.number) === Number(ref.cue)).map(cue => ({ sequence, cue, details: pool?.cueAttributes?.find(value => value.sequence === ref.sequence && value.cueIndex === cue.index) })) ?? [];
  });
  return createPortal(<dialog ref={dialog} className="lighting-attribute-dialog" onCancel={onClose} aria-label="Cue 灯具属性">
    <header><strong>{title} · 灯具属性</strong><button aria-label="关闭灯具属性" onClick={onClose}><X/></button></header>
    <p>按控台里的预设类型、功能组和属性分类，一个属性可以同时属于多类。面光、轮廓、人数和区域需要按现场用途手动归类。</p>
    <div className="attribute-read-actions"><button disabled={reader.busy} onClick={() => { setError(''); void readMa2Attributes(refs.map(ref => ref.sequence), false).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))); }}><RefreshCw/>{reader.busy ? '正在读取…' : '刷新 Cue 内容'}</button>{reader.activeId ? <button onClick={() => { void window.tbLink.cancelMa2Read(reader.activeId!).catch((cause: unknown) => setError(String(cause))); }}>取消读取</button> : null}</div>
    <div className="attribute-cue-list">{rows.map(({sequence,cue,details}) => {
      const result = details ? classifyMa2Attributes(details) : null;
      const readError = pool?.errors.find(value => value.sequence === sequence.sequence);
      const state = ma2CueAttributeState(details, Boolean(readError));
      return <article key={`${sequence.sequence}:${cue.index}`}><strong>{cue.name || sequence.name || `Cue ${cue.number}`}</strong><small>序列 {sequence.sequence} · Cue {cue.number}</small>
        <p role={readError ? 'alert' : 'status'}>{stateNames[state]}{readError ? `：${readError.message}` : ''}</p>
        {!details || !result ? <p>属性还没读取，无法判断用途。</p> : <>
          <div className="attribute-tags">{result.roles.map(role => <span key={role}>{ma2AttributeRoles[role]}</span>)}{!result.roles.length ? <span>无可确认分类</span> : null}</div>
          {details.attributes.length > 12 ? <details><summary>写入属性 · {details.attributes.length} 项</summary><p>{details.attributes.join('、')}</p></details> : details.attributes.length ? <p>写入属性：{details.attributes.join('、')}</p> : null}
          {!details.content ? <p>这是旧版本读取的摘要，无法确认内容是否完整，请重新读取（它不会被当成空 Cue）。</p> : <>
            {details.content.issues.length ? <ul>{details.content.issues.map(issue => <li key={issue}>{issue}</li>)}</ul> : null}
            <small>已检查 Part：{details.content.parts.join('、') || '导出未提供 Part 编号'}</small>
            {details.content.rows.length ? <StoredContent content={details.content}/> : null}
            {details.content.tracking !== 'none' ? <p>同序列其他 Cue {details.content.tracking === 'possible' ? '存有属性' : '数据不完整'}；最终继承到的值还取决于执行器的 Tracking、循环设置和播放顺序，这里不算作本步写入的值。</p> : null}
          </>}
          {details.groups?.length ? <details><summary>控台分类依据 · {details.groups.length} 项属性</summary><ul>{details.groups.map(group => <li key={group.attribute}>{group.presetName} → {group.featureName} → {group.attributeName} <code>{group.attribute}</code></li>)}</ul></details> : details.attributes.length ? <p>还没读取控台的分类结构，请重新读取属性。</p> : null}
          {state === 'complete' && result.roles.length && !result.roles.includes('intensity') && !result.roles.includes('unresolved') && !result.roles.includes('unwritten') ? <p>这个 Cue 没有写亮度，可以和亮度 Cue 搭配使用。灯实际亮不亮，还取决于 Tracking、默认值和其他执行器。</p> : null}
          {result.roles.includes('intensity') ? <p>包含亮度属性。但有亮度属性不代表亮度大于零，也不保证单独就能形成完整的灯光效果。</p> : null}
          {result.unknown.length || details.unknownChannels ? <p>有无法识别的属性或灯具引用，已保留原数据，不会自动猜测：{result.unknown.join('、') || `${details.unknownChannels} 项`}</p> : null}
          <small>灯具：{details.fixtureIds.join('、') || '没有明确灯具编号'} · 读取于 {new Date(details.readAt).toLocaleTimeString()}</small>
        </>}
      </article>;
    })}</div>
    <p role={error ? 'alert' : 'status'}>{error || reader.progress?.detail || reader.message}</p>
    <footer>右键菜单中可以手动增减自定义分类。</footer>
  </dialog>, document.body);
}
