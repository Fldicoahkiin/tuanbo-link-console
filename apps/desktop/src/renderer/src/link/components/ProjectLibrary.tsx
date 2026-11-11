import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, Copy, FileAudio, Film, LayoutGrid, List, Plus, Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import {
  duplicateRundownItemCommand,
  editProgramPlaylistCommand,
  moveVisibleProgramsCommand,
  neighbourGap,
  programPlaylistId,
  programPlaylists,
  programTimeOrigin,
  removeRundownItemCommand,
  reorderedVisibleIds,
  savedSongVolume,
  updateRundownItemCommand
} from '@tb/core/link';
import type { LinkProject, RundownItem } from '@tb/schema';
import { useDocumentStore } from '../stores/document-store';
import { useIntegrationStore } from '../stores/integration-store';
import { useRuntimeStore } from '../stores/runtime-store';
import { useShowGate } from '../stores/show-state-store';
import { Button, IconButton, Menu, MenuItem, MenuSeparator, Select, Switch, TextArea, TextInput } from '../ui';
import { programContents } from '../view-models/program-contents';
import { formatDuration } from './media-utils';
import { ProgramGrid } from './ProgramGrid';
import { ProgramPlaylistPane } from './ProgramPlaylistPane';
import { SongMtcStart } from './SongMtcStart';
import { SongPlaybackProperties, SongVolumeField } from './SongPlaybackProperties';
import { useProgramSelection } from './useProgramSelection';
import { HOME_OWN_KEYS, ownKeys } from '../keys/key-owner';

type ProjectLibraryProps = {
  onImportSongs: () => void;
  onOpenCueEditor: () => void;
  onImportFiles: (files: File[]) => Promise<void>;
  onAddItem: () => void;
  playedItemIds: string[];
  playlistHost: HTMLDivElement | null;
  notify: (message: string, tone?: 'info' | 'error') => void;
  locked: boolean;
  metadataLocked: boolean;
  /** The song's own volume can be changed (also while a song plays) unless this is set. */
  volumeLocked: boolean;
  playItem?: ((item: RundownItem) => void) | undefined;
  project: LinkProject;
  revision: number;
  filteredItems: RundownItem[];
  selectedItem: RundownItem | null;
  selectedItemId: string | null;
  selectedPlaylistId: string;
  search: string;
  currentItemId: string | null;
  onSelectPlaylist: (playlistId: string) => void;
  onSearch: (search: string) => void;
  onChooseItem: (item: RundownItem) => void;
  onChooseReference: (itemId: string) => void;
  onSelectCurrentItem: (item: RundownItem) => void;
};

/**
 * The programme list and the selected programme's properties on the home page (2026-10-30 rework):
 * a toolbar, the virtual card or list grid, and the inspector on the right.
 */
export function ProjectLibrary(props: ProjectLibraryProps): JSX.Element {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [view, setView] = useState<'list' | 'cards'>('cards');
  const execute = useDocumentStore((state) => state.execute);
  const runtime = useRuntimeStore((state) => state.state);
  const doubleClickPlayback = useIntegrationStore((state) => state.profile?.internalPlayer?.doubleClickPlayback ?? false);
  const [context, setContext] = useState<{ item: RundownItem; x: number; y: number } | null>(null);
  const { project, revision, filteredItems, selectedItem, selectedItemId, selectedPlaylistId, search, currentItemId } = props;
  const { selected: visibleBatchIds, setSelectedIds: setBatchIds, deleteSelection } = useProgramSelection({ visibleIds: filteredItems.map(item => item.id), scope: JSON.stringify([project.projectId, search, selectedPlaylistId]), locked: props.locked, notify: props.notify });
  const commitText = (input: HTMLInputElement | HTMLTextAreaElement, field: 'title' | 'notes'): void => {
    if (!selectedItem || props.metadataLocked) return;
    const value = field === 'title' ? input.value.trim() : input.value;
    input.value = value;
    if (value === selectedItem[field]) return;
    try {
      execute(updateRundownItemCommand(selectedItem.id, { title: selectedItem.title, enabled: selectedItem.enabled, notes: selectedItem.notes, [field]: value }));
    } catch (error) {
      input.value = selectedItem[field];
      const message = error instanceof Error ? error.message : String(error);
      input.setCustomValidity(message);
      input.reportValidity();
      props.notify(message, 'error');
    }
  };
  useEffect(() => {
    if (!context) return;
    const close = (): void => setContext(null);
    window.addEventListener('pointerdown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('blur', close);
    };
  }, [context]);
  const playlistName = selectedPlaylistId === 'all' ? '全部节目' : programPlaylists(project).find(list => list.id === selectedPlaylistId)?.name ?? '未分组';
  const playHint = props.playItem ? doubleClickPlayback ? '双击节目播放' : '单击节目播放' : '选择节目进行联动';
  const openProperties = (item: RundownItem): void => { props.onChooseItem(item); setInspectorOpen(true); };
  // Order is changed among the songs on screen (the playlist shown), so a move never lands between hidden songs.
  const visibleIds = filteredItems.map(item => item.id);
  // Whether the show lets the order change is showGate's to say, in its words (00-order §2.4); `locked` still covers
  // the rest (an import running, the mirror one change late).
  const reorderGate = useShowGate('rundown.reorder');
  const reorderBlocked = reorderGate.kind === 'wait' ? reorderGate.message : props.locked ? '正在播放或处理中，停下后才能调整顺序'
    : search.trim() ? '搜索结果里不能调整顺序，清空搜索后再拖动' : null;
  const moveVisible = (ids: string[], gap: number | null): void => {
    if (reorderBlocked || gap === null || !reorderedVisibleIds(visibleIds, ids, gap)) return;
    try { execute(moveVisibleProgramsCommand(visibleIds, ids, gap)); }
    catch (error) { props.notify(error instanceof Error ? error.message : String(error), 'error'); }
  };
  const step = (id: string, direction: -1 | 1): (() => void) | null => {
    const gap = reorderBlocked ? null : neighbourGap(visibleIds, id, direction);
    return gap === null ? null : () => moveVisible([id], gap);
  };
  const reorderHint = reorderBlocked ?? '按住拖动可以调整顺序';
  return <section className="home-library" data-inspector={inspectorOpen}>
    {props.playlistHost ? createPortal(<ProgramPlaylistPane project={project} selectedId={selectedPlaylistId} locked={props.locked} onSelect={props.onSelectPlaylist} notify={props.notify} />, props.playlistHost) : null}

    <section className="home-programs" aria-label="节目单">
      <header className="home-programs-toolbar">
        <div className="home-programs-heading">
          <h2>节目单 <small>{filteredItems.length} 个</small></h2>
          <p title={`${playlistName} · ${playHint}`}>{playlistName} · {playHint}</p>
        </div>
        <label className="home-search"><Search aria-hidden="true" /><TextInput aria-label="搜索节目" placeholder="搜索节目…" value={search} onChange={(event) => props.onSearch(event.currentTarget.value)} /></label>
        <div className="home-view-switch" role="group" aria-label="节目显示方式">
          <IconButton size="sm" label="列表视图" icon={List} aria-pressed={view === 'list'} onClick={() => setView('list')} />
          <IconButton size="sm" label="卡片视图" icon={LayoutGrid} aria-pressed={view === 'cards'} onClick={() => setView('cards')} />
        </div>
        <Button variant="secondary" icon={FileAudio} disabled={props.locked} onClick={props.onImportSongs}>导入歌曲 / P1</Button>
        <Button variant="secondary" icon={Plus} disabled={props.locked} onClick={props.onAddItem}>新建节目</Button>
        <IconButton label="节目属性" icon={SlidersHorizontal} aria-expanded={inspectorOpen} onClick={() => setInspectorOpen(!inspectorOpen)} />
      </header>
      {view === 'list' ? <div className="home-list-columns" aria-hidden="true"><span>顺序</span><span>节目名称</span><span>状态</span><span>MTC 起始码</span><span>时长 / 内容</span><span /></div> : null}
      <ProgramGrid view={view} compact={inspectorOpen} itemIds={visibleIds} locked={props.locked} reorder={{ blocked: reorderBlocked, onMove: moveVisible }} onAddItem={props.onAddItem} onImportFiles={props.onImportFiles} selectedIds={visibleBatchIds} onSelectionChange={setBatchIds} onDeleteSelection={deleteSelection} onBlankClick={() => setInspectorOpen(false)}
        empty={<div className="home-empty"><FileAudio aria-hidden="true" /><strong>{search ? '没有找到匹配的节目' : '添加第一个节目'}</strong><span>{search ? '换个名称试试，或清空搜索' : '点「导入歌曲 / P1」，或把音频文件拖到这里'}</span></div>}
        renderItem={visibleIndex => {
          const item = filteredItems[visibleIndex]!;
          const index = project.rundown.findIndex((candidate) => candidate.id === item.id);
          const current = item.id === currentItemId;
          const start = props.playItem ?? props.onSelectCurrentItem;
          return <article className="home-card" data-program-id={item.id} data-selected={item.id === selectedItemId} data-current={current} data-disabled={!item.enabled} data-batch-selected={visibleBatchIds.includes(item.id)} data-runtime={current ? runtime : 'idle'} title={`${item.title}\n${reorderHint}`} aria-label={`${item.title}，${props.playItem ? doubleClickPlayback ? '双击播放' : '单击播放' : '单击选中'}`} key={`${item.id}:${revision}`} tabIndex={0} draggable={false} {...ownKeys(...HOME_OWN_KEYS.programCard)} onClick={() => props.playItem && !doubleClickPlayback ? props.playItem(item) : props.onChooseItem(item)} onDoubleClick={() => { if (doubleClickPlayback && props.playItem) props.playItem(item); else if (!props.playItem) props.onSelectCurrentItem(item); }} onContextMenu={(event) => { event.preventDefault(); if (props.locked) return; props.onChooseItem(item); setContext({ item, x: event.clientX, y: event.clientY }); }} onKeyDown={(event) => { if (event.key === 'Enter' && event.target === event.currentTarget) { event.preventDefault(); start(item); } }}>
            <button type="button" className="home-card-index" title={props.playItem ? '播放这首' : '设为当前节目'} disabled={!item.enabled} onClick={(event) => { event.stopPropagation(); start(item); }}>{index + 1}</button>
            <strong className="home-card-title">{item.title}</strong>
            <span className="home-card-state">{project.playbackSource === 'internal' && item.referenceAudio ? <Button variant="ghost" size="sm" className="home-card-volume" aria-label={`${item.title} 独立音量`} title="设置这首音频的独立音量，随工程保存" disabled={props.volumeLocked} onDoubleClick={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); openProperties(item); }}>音量 {savedSongVolume(item)}%</Button> : null}
              {current ? <span className="home-card-live"><Check aria-hidden="true" />{runtime === 'running' ? '播放中' : runtime === 'paused' ? '已暂停' : '当前节目'}</span> : props.playedItemIds.includes(item.id) ? <span>已播放</span> : <span className="home-card-hint">{props.playItem ? doubleClickPlayback ? '双击播放' : '点击播放' : item.p1Media ? 'P1 音频' : '联动节目'}</span>}</span>
            <span className="home-card-meta"><span className="home-card-time">{formatDuration(item.referenceAudio?.durationMs ?? 0)}</span><span className="home-card-contents"><Film aria-hidden="true" />{programContents(item)}</span></span>
            <span className="home-card-mtc">{item.referenceAudio ? <SongMtcStart project={project} item={item} /> : null}</span>
            <IconButton size="sm" className="home-card-edit" label={`编辑节目属性：${item.title}`} title="编辑节目属性" icon={SlidersHorizontal} onDoubleClick={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); openProperties(item); }} />
          </article>;
        }} />
    </section>

    {inspectorOpen ? <aside className="home-inspector" aria-label="节目属性">
      <header className="home-inspector-heading" title={selectedItem && props.playItem ? `灯光时间码起点：${internalStart(project, selectedItem.id)}` : undefined}>
        <h2 title={selectedItem?.title}>编辑节目</h2>
        <IconButton label="收起节目属性" icon={X} onClick={() => setInspectorOpen(false)} />
      </header>
      {selectedItem ? <div className="home-inspector-body" key={selectedItem.id}>
        <div className="home-inspector-fields">
          <label><span>播放列表</span><Select disabled={props.locked} aria-label="所属播放列表" value={programPlaylistId(project, selectedItem) ?? ''} onChange={(event) => { try { execute(editProgramPlaylistCommand({ type: 'assign', itemIds: [selectedItem.id], playlistId: event.currentTarget.value || null })); } catch (reason) { props.notify(String(reason), 'error'); } }}><option value="">未分组</option>{programPlaylists(project).map((list) => <option key={list.id} value={list.id}>{list.name}</option>)}</Select></label>
          <label><span>名称</span><TextInput key={selectedItem.title} className="title-input" disabled={props.metadataLocked} aria-label="节目名称" title="回车保存，Esc 取消" {...ownKeys('Escape')} defaultValue={selectedItem.title} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (event.key === 'Escape') event.currentTarget.value = selectedItem.title; event.currentTarget.blur(); } }} onInput={(event) => event.currentTarget.setCustomValidity('')} onBlur={(event) => commitText(event.currentTarget, 'title')} /></label>
          <label><span>备注</span><TextArea key={`${selectedItem.id}:${selectedItem.notes}`} aria-label="备注" disabled={props.metadataLocked} rows={2} defaultValue={selectedItem.notes} placeholder="选填" onInput={(event) => event.currentTarget.setCustomValidity('')} onBlur={(event) => commitText(event.currentTarget, 'notes')} /></label>
        </div>
        {/* The song's own volume stays editable while a song plays (2026-11-09); the rest waits for 停止. */}
        {project.playbackSource === 'internal' ? <div className="home-inspector-fields" role="group" aria-label="歌曲音量"><SongVolumeField item={selectedItem} notify={props.notify} disabled={props.volumeLocked} /></div> : null}
        <fieldset disabled={props.locked} className="home-inspector-locked">
          {project.playbackSource === 'internal' ? <div className="home-inspector-fields" role="group" aria-label="歌曲播放"><SongPlaybackProperties item={selectedItem} notify={props.notify} collapseAdvanced withVolume={false} /></div> : null}
          <Switch label="启用" help="停用的节目不会被播放，也不能设为当前节目" checked={selectedItem.enabled} onChange={(event) => execute(updateRundownItemCommand(selectedItem.id, { title: selectedItem.title, enabled: event.currentTarget.checked, notes: selectedItem.notes }))} />
          <div className="home-inspector-commands">
            <Button variant="secondary" icon={Check} disabled={!selectedItem.enabled || selectedItem.id === currentItemId} onClick={() => props.onSelectCurrentItem(selectedItem)}>{selectedItem.id === currentItemId ? '当前节目' : '设为当前节目'}</Button>
            <Button variant="secondary" icon={SlidersHorizontal} className="inspector-edit" disabled={!selectedItem.enabled} onClick={() => { props.onSelectCurrentItem(selectedItem); props.onOpenCueEditor(); }}>编辑内容</Button>
            <Button variant="secondary" icon={FileAudio} onClick={() => props.onChooseReference(selectedItem.id)}>{selectedItem.referenceAudio ? '更换音频' : '添加音频'}</Button>
          </div>
          <div className="home-inspector-actions" role="group" aria-label="排序、复制和删除">
            <IconButton label="上移" title={reorderBlocked ?? '上移'} icon={ArrowUp} disabled={!step(selectedItem.id, -1)} onClick={() => step(selectedItem.id, -1)?.()} />
            <IconButton label="下移" title={reorderBlocked ?? '下移'} icon={ArrowDown} disabled={!step(selectedItem.id, 1)} onClick={() => step(selectedItem.id, 1)?.()} />
            <IconButton label="复制" icon={Copy} onClick={() => execute(duplicateRundownItemCommand(selectedItem.id))} />
            <IconButton variant="danger" label="删除" icon={Trash2} onClick={() => { if (window.confirm(`确认删除节目“${selectedItem.title}”？`)) execute(removeRundownItemCommand(selectedItem.id)); }} />
          </div>
        </fieldset>
      </div> : <div className="home-empty"><FileAudio aria-hidden="true" /><span>在节目单里选一首歌，就能在这里修改它</span></div>}
    </aside> : null}
    {context && !props.locked ? <ProgramContextMenu
      item={context.item}
      project={project}
      x={context.x}
      y={context.y}
      onChooseReference={props.onChooseReference}
      onProperties={() => setInspectorOpen(true)}
      onClose={() => setContext(null)}
      onOpenCueEditor={() => { props.onSelectCurrentItem(context.item); props.onOpenCueEditor(); }}
      onSelectCurrent={() => props.onSelectCurrentItem(context.item)}
      onMoveUp={step(context.item.id, -1)}
      onMoveDown={step(context.item.id, 1)}
      moveBlocked={reorderBlocked}
      execute={execute}
    /> : null}
  </section>;
}

function ProgramContextMenu(props: {
  onProperties: () => void;
  item: RundownItem;
  project: LinkProject;
  x: number;
  y: number;
  onChooseReference: (itemId: string) => void;
  onClose: () => void;
  onOpenCueEditor: () => void;
  onSelectCurrent: () => void;
  /** null when the song is first or last of the songs on screen, or the order cannot change now. */
  onMoveUp: (() => void) | null;
  onMoveDown: (() => void) | null;
  moveBlocked: string | null;
  execute: ReturnType<typeof useDocumentStore.getState>['execute'];
}): JSX.Element {
  const { onMoveUp, onMoveDown } = props;
  const run = (action: () => void): void => { props.onClose(); action(); };
  return <Menu x={props.x} y={props.y} label={`${props.item.title} 菜单`} onClose={props.onClose}>
    <MenuItem icon={SlidersHorizontal} onSelect={() => run(props.onProperties)}>节目属性</MenuItem>
    <MenuItem icon={SlidersHorizontal} onSelect={() => run(props.onOpenCueEditor)}>打开 Cue 编辑器</MenuItem>
    <MenuItem icon={Check} disabled={!props.item.enabled} onSelect={() => run(props.onSelectCurrent)}>设为当前节目</MenuItem>
    <MenuItem icon={FileAudio} onSelect={() => run(() => props.onChooseReference(props.item.id))}>{props.item.referenceAudio ? '更换参考音频' : '添加参考音频'}</MenuItem>
    <MenuSeparator />
    <MenuItem icon={ArrowUp} disabled={!onMoveUp} {...props.moveBlocked ? { title: props.moveBlocked } : {}} onSelect={() => { if (onMoveUp) run(onMoveUp); }}>上移</MenuItem>
    <MenuItem icon={ArrowDown} disabled={!onMoveDown} {...props.moveBlocked ? { title: props.moveBlocked } : {}} onSelect={() => { if (onMoveDown) run(onMoveDown); }}>下移</MenuItem>
    <MenuItem icon={Copy} onSelect={() => run(() => props.execute(duplicateRundownItemCommand(props.item.id)))}>复制节目</MenuItem>
    <MenuItem icon={Trash2} danger onSelect={() => run(() => { if (window.confirm(`确认删除节目“${props.item.title}”？`)) props.execute(removeRundownItemCommand(props.item.id)); })}>删除节目</MenuItem>
  </Menu>;
}

function formatMilliseconds(milliseconds: number): string {
  const totalCentiseconds = Math.max(0, Math.floor(milliseconds / 10));
  const hours = Math.floor(totalCentiseconds / 360_000);
  const minutes = Math.floor(totalCentiseconds / 6_000) % 60;
  const seconds = Math.floor(totalCentiseconds / 100) % 60;
  const centiseconds = totalCentiseconds % 100;
  return [hours, minutes, seconds, centiseconds].map((value) => String(value).padStart(2, '0')).join(':');
}

function internalStart(project: LinkProject, itemId: string): string {
  try { const item = project.rundown.find((entry) => entry.id === itemId); return formatMilliseconds(item?.playback || item?.p1Media ? programTimeOrigin(item) : 0); }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
