import { applyMa2AutoBindingsCommand, ma2AutoBindEvents, applyMa2ReadbackCommand, matchMa2Readback, programTimeOrigin, type LinkCommand, type Ma2SyncPreview } from '@tb/core/link';
import { ma2AutoBindResultSchema, type Ma2AutoBindRequest, type Ma2AutoBindResult } from '@tb/schema';
import { ma2ApplyResultSchema, ma2CatalogSchema, ma2TimecodePreviewSchema, type LinkProject, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2Catalog, type Ma2CatalogRequest, type Ma2CompareRequest, type Ma2ReadRequest, type Ma2TimecodePreview } from '@tb/schema';
import { ma2PendingChanges } from './ma2-pending-changes';
import { pendingMa2Renames, confirmMa2RenameCommand, ma2RenameKey } from '@tb/core/link';
import { ma2RenameResultSchema, type Ma2RenameRequest, type Ma2RenameResult } from '@tb/schema';

export type Ma2AutoSyncStatus = 'off' | 'waiting' | 'staged' | 'reading' | 'writing' | 'verified' | 'blocked';
export type Ma2AutoSyncScope = 'all' | 'names';
type State = { project: LinkProject | null; documentId: number; playing: boolean; editing?: boolean };
export type Ma2AutoSyncDependencies = {
  state: () => State;
  catalog: (request: Ma2CatalogRequest) => Promise<Ma2Catalog>;
  prepare: (request: Ma2AutoBindRequest) => Promise<Ma2AutoBindResult>;
  rename: (request: Ma2RenameRequest) => Promise<Ma2RenameResult>;
  read: (request: Ma2ReadRequest) => Promise<Ma2TimecodePreview>;
  compare: (request: Ma2CompareRequest) => Promise<Ma2SyncPreview>;
  apply: (request: Ma2ApplyRequest) => Promise<Ma2ApplyResult>;
  archive: (documentId: number, project: LinkProject) => Promise<string>;
  execute: (documentId: number, command: LinkCommand) => void | Promise<void>;
  changed: (status: Ma2AutoSyncStatus, message: string) => void;
};

/** One session belongs to one document and one explicitly scanned Show. Errors latch. */
export class Ma2AutoSync {
  private generation = 0;
  private busy = false;
  private writing = false;
  private confirmed = false;
  private session: { connection: Ma2CatalogRequest; directory: Ma2Catalog['directory']; documentId: number; scope: Ma2AutoSyncScope } | null = null;
  constructor(private readonly dependencies: Ma2AutoSyncDependencies) {}

  start(connection: Ma2CatalogRequest, catalog: Ma2Catalog, scope: Ma2AutoSyncScope = 'all'): void {
    if (this.busy) throw new Error('上一次同步尚未结束，请等待回读后启用');
    const state = this.dependencies.state();
    if (!state.project) throw new Error('请先打开工程');
    this.generation += 1;
    this.confirmed = false;
    this.session = { connection: structuredClone(connection), directory: ma2CatalogSchema.parse(catalog).directory, documentId: state.documentId, scope };
    this.dependencies.changed('waiting', scope === 'names' ? '名称同步已启用' : '双向同步已启用，播放期间暂存修改');
  }

  stop(): void {
    this.generation += 1; this.session = null;
    this.dependencies.changed(this.writing ? 'writing' : 'off', this.writing ? '自动同步正在结束，请等待已发出写入的回读' : '自动同步已关闭');
  }

  async tick(refreshRemote = false): Promise<void> {
    const session = this.session;
    if (!session || this.busy) return;
    refreshRemote = refreshRemote && session.scope === 'all';
    const state = this.dependencies.state();
    if (state.documentId !== session.documentId || !state.project) { this.stop(); return; }
    if (state.playing) {
      const pending = session.scope === 'names' ? [] : ma2PendingChanges(state.project);
      const count = pending.length + pendingMa2Renames(state.project).length;
      this.dependencies.changed(count ? 'staged' : 'waiting', count ? `${count} 项修改待提交；仅保存在本地，停止后核对同步` : '播放期间等待，停止后同步'); return;
    }
    if (state.editing) { this.dependencies.changed('waiting', '等待连续编辑结束'); return; }
    let pending = session.scope === 'names' ? [] : ma2PendingChanges(state.project);
    const unbound = session.scope === 'names' ? [] : state.project.rundown.filter(item => item.lighting && !item.lighting.consoleSong && ma2AutoBindEvents(item.lighting).length);
    const renames = pendingMa2Renames(state.project);
    if (!refreshRemote && !pending.length && !unbound.length && !renames.length) {
      this.dependencies.changed(this.confirmed ? 'verified' : 'waiting', session.scope === 'names'
        ? (this.confirmed ? '名称已写入控台并回读确认' : '名称实时同步已开启，等待改名')
        : (this.confirmed ? '修改已写入并回读确认' : '实时同步已开启，等待修改'));
      return;
    }
    const stale = pending.find(change => {
      const project = state.project!;
      if (project.ma2ReadState?.pairings?.[change.target]?.status !== 'stale') return false;
      const item = project.rundown.find(entry => entry.id === change.itemId);
      const binding = item?.lighting?.ma2Bindings?.find(entry => entry.id === change.bindingId);
      const source = project.ma2ReadState.catalog.directory;
      if (!item?.referenceAudio || (!item.playback && !item.p1Media) || !binding || source.show !== session.directory.show || source.version !== session.directory.version) return true;
      // An explicit existing binding is independent of audio identity/duration.
      // Revalidate its unchanged origin, then the normal three-way readback below.
      try { return programTimeOrigin(item) !== (binding.timeOriginMs ?? 0); }
      catch (error) { this.dependencies.changed('blocked', error instanceof Error ? error.message : String(error)); return true; }
    });
    if (stale) { this.session = null; this.dependencies.changed('blocked', `Timecode ${stale.target} 的歌曲配对已失效，请先重新核对；未写入控台`); return; }
    const blocked = pending.find(change => change.error && !unbound.some(item => item.id === change.itemId));
    if (blocked) { this.session = null; this.dependencies.changed('blocked', `Timecode ${blocked.target}：${blocked.error}`); return; }
    const generation = this.generation;
    this.busy = true;
    const current = (): boolean => this.generation === generation && this.session === session && this.dependencies.state().documentId === session.documentId && !this.dependencies.state().playing && !this.dependencies.state().editing;
    try {
      this.dependencies.changed('reading', '正在检查控台与节目修改');
      const catalog = ma2CatalogSchema.parse(await this.dependencies.catalog({ ...session.connection, targets: [] }));
      if (!current()) return;
      if (JSON.stringify(catalog.directory) !== JSON.stringify(session.directory)) throw new Error('Show、插件会话或时间线目录已变化，请重新扫描后启用自动同步');
      for (const change of renames) {
        if (!current()) return;
        const endpoint = session.connection.network ? `${session.connection.network.host}:${session.connection.network.port}` : '本机 onPC';
        if (change.endpoint !== endpoint || change.show !== session.directory.show) throw new Error('待改名 Cue 属于另一控台或 Show，未发送');
        const stillPending = () => pendingMa2Renames(this.dependencies.state().project).some(value => ma2RenameKey(value) === ma2RenameKey(change) && value.name === change.name && value.confirmedName === change.confirmedName);
        if (!stillPending()) continue;
        await this.dependencies.archive(session.documentId, this.dependencies.state().project!);
        if (!current()) return;
        if (!stillPending()) continue;
        this.writing = true;
        this.dependencies.changed('writing', `正在同步名称：${change.name}`);
        const result = ma2RenameResultSchema.parse(await this.dependencies.rename({ ...session.connection, change, generation: session.directory.generation }));
        if (result.name !== change.name || result.sequence !== change.sequence || result.kind !== change.kind || Number(result.cue) !== Number(change.cue) || result.show !== change.show || result.generation !== session.directory.generation) throw new Error('名称回读与目标不一致，未确认同步');
        if (this.dependencies.state().documentId !== session.documentId) throw new Error('控台名称已写入，但工程已切换，请重新读取控台核对');
        await this.dependencies.execute(session.documentId, confirmMa2RenameCommand(change));
        this.writing = false; this.confirmed = true;
        if (this.session !== session) { this.dependencies.changed('off', '实时同步已关闭；已发出的名称已回读确认'); return; }
      }
      if (session.scope === 'names') {
        const outstanding = pendingMa2Renames(this.dependencies.state().project).length;
        this.dependencies.changed(outstanding ? 'staged' : 'verified', outstanding ? '上一笔名称已确认，继续同步后续改名' : '名称已写入控台并回读确认');
        return;
      }
      for (const item of unbound) {
        if (!current()) return;
        const project = this.dependencies.state().project!;
        const source = project.rundown.find(entry => entry.id === item.id)?.lighting;
        if (!source || source.consoleSong || !ma2AutoBindEvents(source).length) continue;
        await this.dependencies.archive(session.documentId, project);
        if (!current()) return;
        this.writing = true;
        this.dependencies.changed('writing', '正在自动准备控台执行位置');
        const { show, generation: sourceGeneration, version } = session.directory;
        const prepared = ma2AutoBindResultSchema.parse(await this.dependencies.prepare({ dataDirectory: session.connection.dataDirectory,
          network: session.connection.network, projectId: project.projectId, itemId: item.id, document: source,
          expectedSource: { show, generation: sourceGeneration, version } }));
        if (this.dependencies.state().documentId !== session.documentId) throw new Error('工程已切换，控台关联已保留，请重新读取后核对');
        await this.dependencies.execute(session.documentId, applyMa2AutoBindingsCommand(item.id, source, prepared.plan));
        session.directory = prepared.directory;
        this.writing = false;
        if (this.session !== session) { this.dependencies.changed('off', '实时同步已关闭，已完成的控台关联已保存'); return; }
        if (!current()) return;
      }
      const project = this.dependencies.state().project!;
      if (project.rundown.some(item => item.lighting && !item.lighting.consoleSong && ma2AutoBindEvents(item.lighting).length)) {
        this.dependencies.changed('waiting', '准备期间新增了 Cue，继续核对新增目标'); return;
      }
      pending = ma2PendingChanges(project);
      const invalid = pending.find(change => change.error);
      if (invalid) throw new Error(`Timecode ${invalid.target}：${invalid.error}`);
      const targets = project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).filter(binding => !binding.nativeEvents?.length && binding.playback !== 'native-timecode' && (refreshRemote || pending.some(change => change.bindingId === binding.id && change.itemId === item.id))).map(binding => ({ itemId: item.id, bindingId: binding.id, target: binding.timecode })));
      if (new Set(targets.map(target => target.target)).size !== targets.length) throw new Error('同一控台时间线绑定了多个节目，不能自动同步');
      for (const target of targets) {
        if (!current()) return;
        const source = this.dependencies.state().project?.rundown.find(item => item.id === target.itemId)?.lighting;
        const binding = source?.ma2Bindings?.find(entry => entry.id === target.bindingId);
        if (!source || !binding) throw new Error('自动同步期间节目绑定已改变');
        const readback = ma2TimecodePreviewSchema.parse(await this.dependencies.read({ ...session.connection, target: target.target, timeOriginMs: binding.timeOriginMs }));
        if (!current()) return;
        if (this.dependencies.state().project?.rundown.find(item => item.id === target.itemId)?.lighting !== source) { this.dependencies.changed('waiting', '编辑尚未结束，等待下一次检查'); return; }
        if (matchMa2Readback(binding, readback).ambiguous.length) throw new Error(`Timecode ${target.target} 的事件对应不明确，请在手动同步中确认`);
        const comparison = await this.dependencies.compare({ document: source, bindingId: binding.id, readback, choices: [] });
        if (!current()) return;
        if (comparison.conflicts.length) throw new Error(`Timecode ${target.target} 有 ${comparison.conflicts.length} 处冲突，自动同步已停止，请手动选择保留内容`);
        const same = (left: Ma2SyncPreview['base'], right: Ma2SyncPreview['base']): boolean => JSON.stringify(left.objects) === JSON.stringify(right.objects);
        if (same(comparison.base, comparison.local) && same(comparison.base, comparison.remote)) continue;
        if (this.dependencies.state().project?.rundown.find(item => item.id === target.itemId)?.lighting !== source) { this.dependencies.changed('waiting', '编辑尚未结束，等待下一次检查'); return; }
        await this.dependencies.archive(session.documentId, this.dependencies.state().project!);
        if (!current()) return;
        if (this.dependencies.state().project?.rundown.find(item => item.id === target.itemId)?.lighting !== source) { this.dependencies.changed('waiting', '存档期间本地修改已变化，等待下一次检查'); return; }
        this.writing = true;
        this.dependencies.changed('writing', `正在同步 Timecode ${target.target} 并回读`);
        const result = ma2ApplyResultSchema.parse(await this.dependencies.apply({ ...session.connection, document: source, bindingId: binding.id, readback, choices: [], conflicts: [], timeAlignment: 'nearest-frame' }));
        if (result.status === 'incomplete') throw new Error(`${result.message}${result.mayHaveWritten ? '；控台可能已写入，请手动回读' : ''}${result.backupFile ? `；备份：${result.backupFile}` : ''}`);
        if (this.dependencies.state().documentId !== session.documentId) {
          this.session = null; this.dependencies.changed('blocked', '控台已完成同步，但会话或本地编辑已改变；本地变更已保留，请手动回读确认'); return;
        }
        this.writing = false;
        await this.dependencies.execute(session.documentId, applyMa2ReadbackCommand(target.itemId, binding.id, source, result.confirmed, same(comparison.base, comparison.remote)));
        this.confirmed = true;
        if (this.session !== session) { this.dependencies.changed('off', '实时同步已关闭；已发出的修改已回读确认'); return; }
      }
      if (!current()) return;
      const remaining = ma2PendingChanges(this.dependencies.state().project);
      const outstanding = remaining.length + pendingMa2Renames(this.dependencies.state().project).length;
      this.dependencies.changed(outstanding ? 'staged' : 'verified', outstanding ? '上一笔已确认，继续同步后续修改' : '修改已写入并回读确认');
    } catch (error) {
      this.session = null;
      this.dependencies.changed('blocked', error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false; this.writing = false;
      if (this.session === session && !current()) this.dependencies.changed('waiting', '播放或编辑状态已变化，待停止并结束编辑后重新核对');
    }
  }
}
