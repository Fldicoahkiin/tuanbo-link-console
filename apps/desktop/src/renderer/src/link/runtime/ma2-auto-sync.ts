import { applyMa2ReadbackCommand, matchMa2Readback, type LinkCommand, type Ma2SyncPreview } from '@tb/core/link';
import { ma2ApplyResultSchema, ma2CatalogSchema, ma2TimecodePreviewSchema, type LinkProject, type Ma2ApplyRequest, type Ma2ApplyResult, type Ma2Catalog, type Ma2CatalogRequest, type Ma2CompareRequest, type Ma2ReadRequest, type Ma2TimecodePreview } from '@tb/schema';
import { ma2PendingChanges } from './ma2-pending-changes';

export type Ma2AutoSyncStatus = 'off' | 'waiting' | 'staged' | 'reading' | 'writing' | 'verified' | 'blocked';
type State = { project: LinkProject | null; documentId: number; playing: boolean; editing?: boolean };
export type Ma2AutoSyncDependencies = {
  state: () => State;
  catalog: (request: Ma2CatalogRequest) => Promise<Ma2Catalog>;
  read: (request: Ma2ReadRequest) => Promise<Ma2TimecodePreview>;
  compare: (request: Ma2CompareRequest) => Promise<Ma2SyncPreview>;
  apply: (request: Ma2ApplyRequest) => Promise<Ma2ApplyResult>;
  archive: (documentId: number, project: LinkProject) => Promise<string>;
  execute: (documentId: number, command: LinkCommand) => void;
  changed: (status: Ma2AutoSyncStatus, message: string) => void;
};

/** One session belongs to one document and one explicitly scanned Show. Errors latch. */
export class Ma2AutoSync {
  private generation = 0;
  private busy = false;
  private writing = false;
  private session: { connection: Ma2CatalogRequest; directory: Ma2Catalog['directory']; documentId: number } | null = null;
  constructor(private readonly dependencies: Ma2AutoSyncDependencies) {}

  start(connection: Ma2CatalogRequest, catalog: Ma2Catalog): void {
    if (this.busy) throw new Error('上一次同步尚未结束，请等待回读后启用');
    const state = this.dependencies.state();
    if (!state.project) throw new Error('请先打开工程');
    this.generation += 1;
    this.session = { connection: structuredClone(connection), directory: ma2CatalogSchema.parse(catalog).directory, documentId: state.documentId };
    this.dependencies.changed('waiting', '编辑后自动同步已启用；控台侧修改请手动刷新');
  }

  stop(): void {
    this.generation += 1; this.session = null;
    this.dependencies.changed(this.writing ? 'writing' : 'off', this.writing ? '自动同步正在结束，请等待已发出写入的回读' : '自动同步已关闭');
  }

  async tick(refreshRemote = false): Promise<void> {
    const session = this.session;
    if (!session || this.busy) return;
    const state = this.dependencies.state();
    if (state.documentId !== session.documentId || !state.project) { this.stop(); return; }
    if (state.playing) {
      const pending = ma2PendingChanges(state.project);
      this.dependencies.changed(pending.length ? 'staged' : 'waiting', pending.length ? `${pending.length} 条时间线待提交；仅保存在本地，停止后核对同步` : '播放期间等待，停止后同步'); return;
    }
    if (state.editing) { this.dependencies.changed('waiting', '等待连续编辑结束'); return; }
    const pending = ma2PendingChanges(state.project);
    if (!refreshRemote && !pending.length) { this.dependencies.changed('waiting', '本地无待提交修改；控台侧修改请手动刷新'); return; }
    const stale = pending.find(change => state.project?.ma2ReadState?.pairings?.[change.target]?.status === 'stale');
    if (stale) { this.session = null; this.dependencies.changed('blocked', `Timecode ${stale.target} 的歌曲配对已失效，请先重新核对；未写入控台`); return; }
    const blocked = pending.find(change => change.error);
    if (blocked) { this.session = null; this.dependencies.changed('blocked', `Timecode ${blocked.target}：${blocked.error}`); return; }
    const generation = this.generation;
    this.busy = true;
    const current = (): boolean => this.generation === generation && this.session === session && this.dependencies.state().documentId === session.documentId && !this.dependencies.state().playing && !this.dependencies.state().editing;
    try {
      this.dependencies.changed('reading', '正在检查控台与节目修改');
      const catalog = ma2CatalogSchema.parse(await this.dependencies.catalog({ ...session.connection, targets: [] }));
      if (!current()) return;
      if (JSON.stringify(catalog.directory) !== JSON.stringify(session.directory)) throw new Error('Show、插件会话或时间线目录已变化，请重新扫描后启用自动同步');
      const targets = state.project.rundown.flatMap(item => (item.lighting?.ma2Bindings ?? []).filter(binding => !binding.nativeEvents?.length && binding.playback !== 'native-timecode' && (refreshRemote || pending.some(change => change.bindingId === binding.id && change.itemId === item.id))).map(binding => ({ itemId: item.id, bindingId: binding.id, target: binding.timecode })));
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
        if (!current() || this.dependencies.state().project?.rundown.find(item => item.id === target.itemId)?.lighting !== source) {
          this.session = null; this.dependencies.changed('blocked', '控台已完成同步，但会话或本地编辑已改变；本地变更已保留，请手动回读确认'); return;
        }
        this.writing = false;
        this.dependencies.execute(session.documentId, applyMa2ReadbackCommand(target.itemId, binding.id, source, result.confirmed));
      }
      if (!current()) return;
      this.dependencies.changed('verified', '可写回的绑定时间线已核对；原生保留时间线不参与写回');
    } catch (error) {
      this.session = null;
      this.dependencies.changed('blocked', error instanceof Error ? error.message : String(error));
    } finally {
      this.busy = false; this.writing = false;
      if (this.session === session && !current()) this.dependencies.changed('waiting', '播放或编辑状态已变化，待停止并结束编辑后重新核对');
    }
  }
}
