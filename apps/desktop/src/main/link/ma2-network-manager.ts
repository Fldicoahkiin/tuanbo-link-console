import { ma2MtcSequenceSettings, matchesMa2MtcSongSelection, Ma2MtcSelectionService, type Ma2ConfirmedTimecode, type Ma2MtcPreparationTask } from './ma2-mtc-selection';
import { ma2MtcPlaybackSettings } from './ma2-timecode-xml';
import { ma2MidiInputMessage, readMa2Capabilities } from './ma2-capabilities';
import { editMa2Timeline, readMa2MtcRanges } from './ma2-timeline-edit';
import { loadMa2Sequence } from './ma2-sequence-snapshot';
import { ma2PlaybackRequestSchema, type Ma2PlaybackRequest, type Ma2Catalog, type Ma2CatalogRequest, ma2ObjectDirectorySchema, type Ma2ObjectDirectory } from '@tb/schema';
import { playMa2Cue, stopMa2ConsoleCues } from './ma2-pool-playback';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ma2NetworkSettingsSchema, ma2NetworkSaveSchema, ma2NetworkCatalogSchema, type Ma2Capabilities, type Ma2NetworkSettings, type Ma2NetworkSave, type Ma2NetworkStatus, type Ma2NetworkTarget, type Ma2ReadProgressUpdate } from '@tb/schema';
import { SecureProfileStore } from './secure-profile-store';
import { writeFileAtomically } from './atomic-file';
import { Ma2LoginRefusedError, Ma2Telnet, Ma2UnreachableError, ma2ResponseLine, type Ma2ConnectedPeer } from './ma2-telnet';
import { Ma2NetworkWire, ma2UsesLocalFiles } from './ma2-network-wire';
import { Ma2RequestJournal } from './ma2-request-journal';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2ApplyService } from './ma2-apply-service';
import { ensureMa2NetworkBridge, readMa2NetworkBridge, type Ma2BridgeState } from './ma2-bridge-installer';
import { checkMa2MtcStart, MA2_BRIDGE_MISSING_BEFORE_REQUEST, MA2_SONG_TIMECODE_SLOT, ma2MtcConflictTargets, ma2MtcRange, ma2SelectorTrackProblem } from '@tb/core/link';
import { readMa2ShowSource, verifyMa2ShowSource, type Ma2ShowSource } from './ma2-show-probe';
import { Ma2Relogin, Ma2ReloginStop, type Ma2ReloginClock, type Ma2ReloginLog, type Ma2ReloginPlan } from './ma2-relogin';
import { readMa2NativeLibrary } from './ma2-native-library';
import { readMa2EffectLibrary } from './ma2-effect-library';
import { Ma2LayoutService } from './ma2-layout-service';
import { listMa2ExecutorPages, readMa2ExecutorPage } from './ma2-executor-page';
import { Ma2ExecutorMutationService } from './ma2-executor-mutation-service';
import { Ma2ExecutorInputService } from './ma2-executor-input';
import { Ma2CueDeleteService } from './ma2-cue-delete-service';
import { readMa2Catalog } from './ma2-catalog';
import type { Ma2CommandPriority, Ma2QueueWait } from './ma2-command-queue';
import { readMa2NetworkPreview } from './ma2-network-preview';
import { Ma2LiveService } from './ma2-live-service';
import { Ma2SongWatch } from './ma2-song-watch';
import type { Ma2ConsoleBackups } from './ma2-console-backups';
import { SHOW_WAIT_SHOW_ON, holdForShow, isShowWait, type ShowGate, type ShowGateReader } from '@tb/core/link';

/** One chosen console, machine settings only. Auto-connect never replays writes. */
/** Reading the console during a show could hold back its lighting: the check waits until playback stops. */
/** A command that waited behind another console job past its deadline is dropped, never sent late. */
export function ma2BusyMessage(off: boolean, waitedMs: number): string {
  const seconds = Math.max(1, Math.round(waitedMs / 1000));
  return off
    ? `控台正忙（比如在同步或读取歌曲），关灯指令等了 ${seconds} 秒没发出去，已经取消。这首歌的执行器可能还亮着，请再停一次，或者在控台上关掉`
    : `控台正忙（比如在同步或读取歌曲），这条灯光指令等了 ${seconds} 秒没发出去，已经取消，不会再发。请稍后再点一次`;
}
export class Ma2NetworkManager {
  private latestRanges: Awaited<ReturnType<typeof readMa2MtcRanges>> | undefined;
  playbackRanges(): typeof this.latestRanges {
    const source = this.identity?.source;
    return source && source.show === this.latestRanges?.show && source.generation === this.latestRanges.generation ? this.latestRanges : undefined;
  }
  private readonly cancelledPlayback = new Map<string, number>();
  private profiles: Ma2NetworkSettings[] = [];
  private capabilities: Ma2Capabilities | null = null;
  private settings: Ma2NetworkSettings | null = null;
  private connection: Ma2Telnet | null = null;
  private version: string | null = null;
  private error: string | null = null;
  /** The last connect reached nothing at the saved address, so a search may find the console elsewhere. */
  private unreachable = false;
  private passwordSaved = false;
  private busy = false;
  private generation = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 1000;
  private reconnectAllowed = false;
  private scheduleReconnect(): void {
    if (!this.reconnectAllowed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.reconnectAllowed) return;
      if (this.show('ma2.reconnect').kind === 'wait' || this.busy) { this.scheduleReconnect(); return; }
      // The show started while this waited: from now on only logging in again, with its limit (M5).
      if (this.show('ma2.connect').kind === 'wait') { this.error = null; this.relogin.dropped(this.dropReason); return; }
      void this.connect(true).then(status => {
        if (status.state !== 'connected') { this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2); this.scheduleReconnect(); }
      }, (cause: unknown) => {
        this.error = `恢复控台连接：${cause instanceof Error ? cause.message : String(cause)}`;
        this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
  }
  /** Why the line went down last, for the run log when logging in again starts later. */
  private dropReason = 'MA2 网络连接断开了';
  /** The settings of the connection the operator made in this run and has not disconnected (M5): only that one logs in again. */
  private armed: Ma2NetworkSettings | null = null;
  /** The console and Show that connection was made on: its version, and the Show and plugin session when they could be read. */
  private identity: { version: string; source: Ma2ShowSource | null } | null = null;
  private bridgeInstall: Promise<void> | null = null;
  private bridgeAdmissionWaiting = false;
  private disconnectingBridgeWait: Promise<void> | null = null;
  /** Logged in, but the plugin is missing or old (`wait`: install when idle), or its installation failed. */
  private bridgeIssue: { wait: boolean; message: string } | null = null;
  private readonly reloginLogs = new Set<(entry: Ma2ReloginLog) => void>();
  /** M5: the Telnet line, dropped by itself while the show is not idle, logs in again on its own (`ma2-relogin.ts`). */
  private readonly relogin: Ma2Relogin<Ma2NetworkSettings>;
  private services: { bridge: Ma2OnpcBridge; service: Ma2ApplyService } | null = null;
  private wire: Ma2NetworkWire | null = null;
  private requestJournal: Ma2RequestJournal | undefined;
  /** Plugin transactions (one per lane) left open by a dropped connection, released once on the next login to the same console. */
  private unreleased: { ids: string[]; settings: Ma2NetworkSettings } | null = null;
  private keepUnreleased(): void {
    const ids = this.wire?.unreleasedRequests ?? [];
    if (ids.length && this.settings) this.unreleased = { ids, settings: this.settings };
    this.wire = null;
  }
  private beforeConnectionChange: (() => Promise<()=>void>) | null = null;
  setBeforeConnectionChange(handler:()=>Promise<()=>void>):void { this.beforeConnectionChange=handler; }
  private sameTarget(settings:Ma2NetworkSettings):boolean {
    return this.settings!==null&&(['host','port','monitorPort','username'] as const).every(key=>this.settings?.[key]===settings[key]);
  }
  private readonly path: string;
  private layoutService: Ma2LayoutService | null = null;
  private songWatch: Ma2SongWatch | null = null;
  async checkSong(request: import('@tb/schema').Ma2SongCheckRequest): Promise<boolean> {
    const { bridge } = this.get(request.network);
    if (!this.connection) throw new Error('请先连接控台');
    this.songWatch ??= new Ma2SongWatch(this.show);
    return this.songWatch.changed(this.connection, bridge, request);
  }
  private liveService: Ma2LiveService | null = null;
  /** The web remote's Show checks go over the Telnet line only: they need no plugin, so a plugin waiting for the show to
   * stop (M5) does not stop them. */
  live(): Ma2LiveService { return this.liveService ??= new Ma2LiveService(`${this.path}.playback.json`, this.secrets, request => {
    this.target(request.network);
    if (this.connection?.state !== 'connected') throw new Error('请先连接控台');
    return this.connection;
  }); }
  private layouts(): Ma2LayoutService {
    if (!this.consoleBackups) throw new Error('控台备份记录还没准备好');
    return this.layoutService ??= new Ma2LayoutService(`${this.path}.layouts.json`, this.show, this.consoleBackups);
  }
  private mtcSelection: Ma2MtcSelectionService | null = null;
  async prepareMtcPlayback(network: Ma2NetworkTarget, force = true, targets: readonly number[] = [], verifiedSequence?: { number: number; xml: string }, verifiedTimecode?: Ma2ConfirmedTimecode, task?: Ma2MtcPreparationTask): Promise<boolean> {
    if (force) {
      task?.signal?.throwIfAborted();
      holdForShow(this.show, 'ma2.sync.write');
      const source = await this.editingSource(network);
      task?.signal?.throwIfAborted();
      task = { ...task, expectedSource: task?.expectedSource ?? source };
    }
    const { bridge } = this.get(network);
    if (!this.connection) throw new Error('请先连接控台');
    if (!this.consoleBackups) throw new Error('控台备份记录还没准备好');
    this.mtcSelection ??= new Ma2MtcSelectionService(this.show, this.consoleBackups);
    return this.mtcSelection.prepare(this.connection, bridge, network, force, targets, verifiedSequence, verifiedTimecode, task);
  }
  async editTimeline(request: import('@tb/schema').Ma2TimelineEditRequest) {
    if (!request.network) throw new Error('请先连接控台');
    const result = await editMa2Timeline(this.get(request.network).bridge, request);
    try { await this.prepareMtcPlayback(request.network, false, [request.target], undefined, undefined, { expectedSource: request.expectedSource }); }
    catch (error) {
      // The metadata write was verified. Keep that outcome even when song selection still needs attention.
      return { ...result, selectionWarning: error instanceof Error ? error.message : String(error) };
    }
    return result;
  }
  private consoleBackups: Ma2ConsoleBackups | null = null;
  setConsoleBackups(backups: Ma2ConsoleBackups): void { this.consoleBackups = backups; }
  private cueDeleteService: Ma2CueDeleteService | null = null;
  setCueDeletionProjectReader(load: (path: string) => Promise<import('@tb/schema').LinkProject>): void {
    this.cueDeleteService = new Ma2CueDeleteService(`${this.path}.cue-backups`, load, this.show);
  }
  async prepareCueDeletion(request: import('@tb/schema').Ma2CueDeletePrepare, report?: (value: Ma2ReadProgressUpdate) => void): Promise<import('@tb/schema').Ma2CueDeletePlan> {
    if (!this.cueDeleteService) throw new Error('控台删除功能还没准备好');
    return this.cueDeleteService.prepare(this.get(request.network).bridge, request, report);
  }
  async commitCueDeletion(request: import('@tb/schema').Ma2CueDeleteCommit, report?: (value: Ma2ReadProgressUpdate) => void): Promise<import('@tb/schema').Ma2CueDeleteResult> {
    const { bridge } = this.get(request.network);
    if (!this.cueDeleteService || !this.connection) throw new Error('控台删除功能还没准备好');
    return this.cueDeleteService.commit(this.connection, bridge, request, report);
  }
  async listLayouts(request: import('@tb/schema').Ma2LayoutDirectoryRequest): Promise<import('@tb/schema').Ma2LayoutDirectory> {
    const { bridge } = this.get(request.network); if (!this.connection) throw new Error('请先连接控台');
    return this.layouts().list(this.connection, bridge, request);
  }
  async listExecutorPages(request: import('@tb/schema').Ma2ExecutorPageDirectoryRequest) { return listMa2ExecutorPages(this.get(request.network).bridge, request); }
  async readExecutorPage(request: import('@tb/schema').Ma2ExecutorPageRequest) { return readMa2ExecutorPage(this.get(request.network).bridge, request); }
  private executorMutations: Ma2ExecutorMutationService | null = null;
  private executorInput = new Ma2ExecutorInputService();
  private executorMutationBusy = false;
  /** Which channel Button area keys use on this console now, and why (`ma2-executor-channel.ts`). Reads nothing. */
  executorChannel(request: import('@tb/schema').Ma2LayoutDirectoryRequest): import('@tb/schema').Ma2ExecutorChannel {
    this.get(request.network);
    return this.live().buttonChannel(request);
  }
  /** The operator's choice for Button area keys on this computer. A change lets go of every key held first. */
  async chooseExecutorChannel(choice: import('@tb/schema').Ma2ExecutorChannel['choice']): Promise<boolean> {
    if (this.live().keyChoice() === choice) return false;
    this.live().releaseButtons();
    await this.executorInput.release();
    return await this.live().chooseKeys(choice);
  }
  /** An executor key on the channel the press was made for; a press made for the other channel is not sent. A press
   * sent on the web remote comes back for the log. */
  async inputExecutor(request: import('@tb/schema').Ma2ExecutorInput): Promise<import('./ma2-live-service').Ma2ButtonPress | null> {
    this.get(request.network);
    const connection = this.connection; const generation = this.generation;
    if (!connection) throw new Error('请先连接控台');
    if (request.channel === 'webRemote') {
      if (request.pressed && this.executorMutationBusy) throw new Error('正在更新执行器位置，请等控台确认后再按');
      return this.live().inputButton(request);
    }
    if (request.pressed && this.live().keyChannel(request, request.slot) !== 'plugin') throw new Error('按键通道变了（现在走网页遥控），这次没有发送，请再按一次');
    if (request.pressed && this.bridgeIssue) throw new Error(this.bridgeIssue.message);
    await this.executorInput.input(connection, request, () => {
      if (this.generation !== generation || connection.state !== 'connected') throw new Error('控台连接变了，按键没有发送');
      if (request.pressed && this.executorMutationBusy) throw new Error('正在更新执行器位置，请等控台确认后再按');
    });
    return null;
  }
  async releaseExecutors(): Promise<void> {
    try { this.liveService?.releaseButtons(); }
    finally { await this.executorInput.release(); }
  }
  async updateExecutor(request: import('@tb/schema').Ma2ExecutorUpdateRequest): Promise<import('@tb/schema').Ma2ExecutorUpdateResult> {
    const { bridge } = this.get(request.network);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    if (this.executorMutationBusy) throw new Error('正在确认上一个执行器修改，请稍候');
    this.executorMutationBusy = true;
    try {
      this.liveService?.releaseButtons();
      await this.executorInput.release();
      if (this.connection !== connection || connection.state !== 'connected') throw new Error('控台连接变了，没有修改执行器');
      this.executorMutations ??= new Ma2ExecutorMutationService(`${this.path}.executor-backups`, this.show);
      return await this.executorMutations.update(connection, bridge, request);
    } finally { this.executorMutationBusy = false; }
  }
  async updateLayout(request: import('@tb/schema').Ma2LayoutUpdateRequest): Promise<import('@tb/schema').Ma2LayoutSnapshot> {
    const { bridge } = this.get(request.network); if (!this.connection) throw new Error('请先连接控台');
    return this.layouts().update(this.connection, bridge, request);
  }
  async readLayout(request: import('@tb/schema').Ma2LayoutReadRequest): Promise<import('@tb/schema').Ma2LayoutSnapshot> {
    const {bridge}=this.get(request.network); const connection=this.connection;
    if(!connection)throw new Error('请先连接控台');
    return this.layouts().read(connection,bridge,request);
  }
  async syncSong(request: import('@tb/schema').Ma2SongSyncRequest, report?: (progress: Ma2ReadProgressUpdate) => void, signal?: AbortSignal): Promise<import('@tb/schema').Ma2SongSyncResult> {
    await this.checkEditingSource(request.network, request.expectedSource);
    const { bridge } = this.get(request.network); const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    // A cached song check that still matches the console saves reading the whole Sequence again.
    const binding = request.binding;
    const baseline = binding && this.songWatch ? await this.songWatch.unchangedBaseline(connection, { network: request.network, expectedSource: request.expectedSource, sequence: binding.sequence, ...binding.executor ? { executor: binding.executor } : {} }, binding.baselineXml) : null;
    // The verified post-write export becomes the next check's baseline, so that check is not a full read either.
    const adoptReadback = async (exportFile: string, result: import('@tb/schema').Ma2SongSyncResult): Promise<boolean> => {
      if (!result.remoteRevision) return false;
      this.songWatch ??= new Ma2SongWatch(this.show);
      try {
        return await this.songWatch.adopt(connection, { network: request.network, expectedSource: request.expectedSource, sequence: result.binding.sequence, ...result.binding.executor ? { executor: result.binding.executor } : {}, revision: result.remoteRevision }, exportFile);
      } catch (cause) {
        this.notice?.('warning', `这次读取的内容没能接上上次复查的记录：${cause instanceof Error ? cause.message : String(cause)}；下次复查会重新读取整个序列`);
        return false;
      }
    };
    let verifiedTimecode: Ma2ConfirmedTimecode | undefined;
    const result = await this.layouts().syncSong(connection, bridge, request, report, signal, { consoleBaseline: baseline, adoptReadback,
      timecodeConfirmed: value => { verifiedTimecode = { ...value, show: request.expectedSource.show, generation: request.expectedSource.generation }; } });
    // A Sequence-only write has no song range yet. The Timecode writer that references it
    // will prepare and verify that specific range once its events are actually on the console.
    if (result.binding.timecode) await this.prepareMtcPlayback(request.network, false, [result.binding.timecode.number],
      { number: result.binding.sequence, xml: await loadMa2Sequence(result.binding.baselineXml) }, verifiedTimecode, { expectedSource: request.expectedSource, signal });
    return result;
  }
  async newCue(request: import('@tb/schema').Ma2NewCueRequest): Promise<import('@tb/schema').Ma2NewCueResult> {
    const {bridge}=this.get(request.network); const connection=this.connection;
    if(!connection)throw new Error('请先连接控台');
    return this.layouts().create(connection,bridge,request);
  }
  constructor(directory: string, private readonly secrets: Pick<SecureProfileStore, 'hasCredential' | 'saveCredential' | 'loadCredential'>, private readonly show: ShowGateReader = () => ({ kind: 'allow' }), private readonly bundledBridge?: string, private readonly resolveLocalAddress: (host: string) => Promise<string | undefined> = () => Promise.resolve(undefined), private readonly validatePeers?: (host: string, peers: readonly Ma2ConnectedPeer[]) => Promise<void>, private readonly awaitListener?: (host: string, port: number) => Promise<void>, private readonly notice?: (level: 'info' | 'warning', message: string) => void, reloginClock?: Ma2ReloginClock) {
    this.path = join(directory, 'link-integrations', 'ma2-network.json');
    this.relogin = new Ma2Relogin<Ma2NetworkSettings>(CONSOLE_RELOGIN, settings => this.loginOnly(settings), entry => { for (const listener of this.reloginLogs) listener(entry); }, reloginClock);
  }
  private target(target: Ma2NetworkTarget): void {
    const settings = this.settings;
    if (!settings || target.host !== settings.host || target.port !== settings.port || target.monitorPort !== settings.monitorPort || target.username !== settings.username) throw new Error('MA2 连接目标已改变，请重新读取控台');
  }
  get(target: Ma2NetworkTarget): { bridge: Ma2OnpcBridge; service: Ma2ApplyService } {
    this.target(target);
    if (this.capabilities && (!this.capabilities.objects || !this.capabilities.files)) throw new Error(this.capabilities.message);
    // Logged in again during the show without a usable plugin (M5): what needs it waits, and says why.
    if (this.connection?.state === 'connected' && !this.services && this.bridgeIssue) throw new Error(this.bridgeIssue.message);
    if (this.connection?.state !== 'connected') throw new Error('请先连接 MA2 控台');
    if (!this.services) throw new Error('已登录，请先在设置里点“读取控台灯光到现有歌曲”');
    return this.services;
  }
  /** Every line logging the Telnet line in again writes for the run log (M5). */
  onReloginLog(listener: (entry: Ma2ReloginLog) => void): () => void {
    this.reloginLogs.add(listener);
    return () => { this.reloginLogs.delete(listener); };
  }
  /** The show changed: a plugin that waited for it to stop is installed now (M5). */
  showChanged(): void { void this.installDeferred(); }
  cancelPlayback(sessionId: string): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.cancelledPlayback) if (expiresAt < now) this.cancelledPlayback.delete(id);
    this.cancelledPlayback.set(sessionId, now + 180000);
  }
  get connectionGeneration():number { return this.generation; }
  /** Resolves with how long the command waited for the console line and what held it (M1: a lights-off's wait). */
  async playCue(input: Ma2PlaybackRequest, options?:{beforeSend?:()=>void;priority?:Ma2CommandPriority;immediateOff?:boolean}): Promise<Ma2QueueWait> {
    const request = ma2PlaybackRequestSchema.parse(input);
    const settings = this.settings; const connection = this.connection; const generation = this.generation;
    if (!settings || !connection || connection.state !== 'connected') throw new Error('序列池播放需要先在设备设置连接 MA2 网络');
    if (Object.entries(request.network).some(([key, value]) => Reflect.get(settings, key) !== value)) throw new Error('控台连接目标已改变，请重新选择 Cue');
    const queuedAt = Date.now();
    const current = (): void => {
      if (generation !== this.generation || connection.state !== 'connected' || this.cancelledPlayback.has(request.sessionId)) throw new Error('灯光播放已经停了，还没发出的灯光指令不再发送');
      if (Date.now() > request.deadlineAt) throw new Error(ma2BusyMessage(request.action.action === 'off', Date.now() - queuedAt));
    };
    current();
    // An Off passes queued sync reads and writes, so stopping a song switches its lights off first.
    return playMa2Cue(connection, request.action, ()=>{current();options?.beforeSend?.();},options?.priority ?? (request.action.action === 'off' ? 'stop' : 'playback'), options);
  }
  /** A newer song can claim the executor while this release waits for the socket. */
  async playPendingOff(request: Ma2PlaybackRequest, stillOwed: () => boolean): Promise<Ma2QueueWait | null> {
    const withdrawn = new Error('执行器已由新节目接管或关灯请求已更新');
    try {
      return await this.playCue(request, { beforeSend: () => { if (!stillOwed()) throw withdrawn; } });
    } catch (error) {
      if (error === withdrawn) return null;
      throw error;
    }
  }
  async stopConsoleCues(): Promise<void> {
    const connection = this.connection;
    if (!connection || connection.state !== 'connected') throw new Error('控台未连接，无法停止控台上的 Cue');
    const generation = this.generation;
    const stopDesk = stopMa2ConsoleCues(connection, () => {
      if (connection !== this.connection || generation !== this.generation || connection.state !== 'connected') throw new Error('控台连接已变化，请核对后再按停止');
    });
    // Put Off on the wire first. Cancel old presses before yielding to the command queue.
    const releaseInputs = async (): Promise<void> => {
      try { this.liveService?.release(); }
      finally { await this.releaseExecutors(); }
    };
    const results = await Promise.allSettled([stopDesk, releaseInputs()]);
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason instanceof Error ? result.reason.message : String(result.reason)] : []);
    if (errors.length) throw new Error(errors.join('；'));
  }
  private credentialId(settings: Ma2NetworkSettings): string { return `ma2-${createHash('sha256').update(`${settings.host}:${settings.port}:${settings.username}`).digest('hex')}`; }
  async readCatalog(target: Ma2NetworkTarget, onProgress?: (progress: Ma2ReadProgressUpdate) => void, signal?: AbortSignal, targets?: readonly number[], checkpoint?: (catalog: Ma2Catalog, entry?: Ma2Catalog['entries'][number]) => Promise<void>, expectedSource?: Ma2CatalogRequest['expectedSource'], checkMtcFor?: readonly number[], otherClockBindings?: Ma2CatalogRequest['otherClockBindings'], songPlayback?: Ma2CatalogRequest['songPlayback']): Promise<Ma2Catalog> {
    const started = performance.now();
    if (targets?.length === 0) {
      signal?.throwIfAborted();
      holdForShow(this.show, 'ma2.sync.read');
      let inputNote: string | undefined;
      const source = await this.editingSource(target, checkMtcFor?.length ? slot => {
        inputNote = slot !== null && `TC Slot ${slot}` !== MA2_SONG_TIMECODE_SLOT ? ma2MidiInputMessage(slot) : undefined;
      } : undefined);
      if (checkMtcFor?.length) {
        // A console operator can move a different Timecode into this song without changing the Show or its generation.
        const ranges = await readMa2MtcRanges(this.get(target).bridge, signal, checkMtcFor);
        signal?.throwIfAborted();
        if (ranges.show !== source.show || ranges.generation !== source.generation) throw new Error('控台的节目目录刚有变化，请重新核对当前节目');
        this.latestRanges = ranges;
        const directory = ma2ObjectDirectorySchema.parse({ ...source, entries: ranges.entries.map(({ target, name }) => ({ target, name })) });
        const result: Ma2Catalog = { directory, afterRollSeconds: ranges.afterRollSeconds, entries: [], readAt: new Date().toISOString(),
          songOffsets: ranges.entries.filter(entry => checkMtcFor.includes(entry.target)).map(({ target, offset }) => ({ target, offset })) };
        if (ranges.selectorTrackConflict) return { ...result, selectorTrackConflict: ranges.selectorTrackConflict, playbackConflict: ma2SelectorTrackProblem(ranges.selectorTrackConflict) };
        const selector = ranges.selectorReady || ranges.selectorSettingsTarget;
        // A missing binding has its own recovery action. Check it before reporting an overlap.
        if (checkMtcFor.every(number => directory.entries.some(entry => entry.target === number))) {
          const otherClocks = new Map(otherClockBindings?.map(binding => [binding.target, binding.slot]));
          for (const entry of ranges.entries) {
            if (!checkMtcFor.includes(entry.target)) continue;
            if (entry.slot !== MA2_SONG_TIMECODE_SLOT && entry.slot !== otherClocks.get(entry.target)) {
              const location = entry.slot ? `使用的是 ${entry.slot}` : '没有指定外部时码槽';
              result.playbackConflict = `Timecode ${entry.target} ${location}。请在控台将这条时间线的时码槽设为 ${MA2_SONG_TIMECODE_SLOT}，再点同步。`;
              break;
            }
            if (entry.slot !== MA2_SONG_TIMECODE_SLOT && !result.playbackClockNote) {
              result.playbackClockNote = `Timecode ${entry.target} 使用 ${entry.slot || '控台内部时钟'}。要跟随歌曲，请在控台选择 ${MA2_SONG_TIMECODE_SLOT} 并再次同步。`;
            }
            if (entry.missingExecutorTarget) {
              const { track, event, frame } = entry.missingExecutorTarget;
              result.playbackConflict = `Timecode ${entry.target} 第 ${track} 轨没有可用的执行器，第 ${event} 个动作（第 ${frame} 帧）无法执行。请在控台给这条轨道指定执行器，再点同步。`;
              break;
            }
            if (entry.missingCueTarget) {
              const { track, event, frame } = entry.missingCueTarget;
              result.playbackConflict = `Timecode ${entry.target} 第 ${track} 轨第 ${event} 个灯光点（第 ${frame} 帧）缺少目标 Cue。请在控台给这个点重新指定 Cue，或移除这个点，再点同步。`;
              break;
            }
            if (entry.routeMismatch) {
              const { track, executor, assigned, referenced, step } = entry.routeMismatch;
              const assignment = assigned ? `分配的是序列 ${assigned}` : '没有分配序列';
              result.playbackConflict = executor
                ? `Timecode ${entry.target} 的第 ${step} 步引用序列 ${referenced}，执行器 ${executor} ${assignment}。请在控台核对这一步的目标或执行器分配，再点同步。`
                : `Timecode ${entry.target} 第 ${track} 轨缺少执行器，第 ${step} 步引用序列 ${referenced}。请在控台给这条轨道重新指定执行器，再点同步。`;
              break;
            }
            const musicMs = songPlayback && Math.round(songPlayback.startMs * 30 / 1000) === Number(entry.offset) ? songPlayback.durationMs : 0;
            // A cleared song may still be armed by an existing selector at its former start.
            if (entry.slot === MA2_SONG_TIMECODE_SLOT && (entry.last !== '' || selector)) result.needsPlaybackPreparation = true;
            if (entry.slot === MA2_SONG_TIMECODE_SLOT && (entry.last !== '' || musicMs > 0)) {
              const song = ma2MtcRange(entry);
              const end = Math.max(song.end, song.start + Math.ceil(musicMs * 30 / 1000));
              const other = ranges.otherTimedCues?.find(cue => cue.seconds * 30 >= song.start && cue.seconds * 30 < end);
              if (other) {
                result.playbackConflict = `Timecode ${entry.target} 播放期间，序列 ${other.sequence} 的 Cue ${Number(other.cue)} 也会跟随同一时码。请核对 Timecode ${other.owner} 对应的节目，或在控台将该 Cue 的触发方式改为 Go，再点同步。`;
                break;
              }
              try { checkMa2MtcStart(ranges.entries, entry.target, song.start * 1000 / 30, musicMs, false, ranges.afterRollSeconds); }
              catch (error) {
                if (!(error instanceof Error) || !ma2MtcConflictTargets(error.message)) throw error;
                result.playbackConflict = error.message;
                break;
              }
            }
          }
        }
        if (result.needsPlaybackPreparation && !result.playbackConflict && selector) {
          const bridge = this.get(target).bridge;
          const timeline = await bridge.request('READ', selector, '', '', signal);
          const sequence = await bridge.request('SEQUENCE', selector, '', '', signal);
          await this.checkEditingSource(target, source);
          const desired = ranges.selectorSettingsTarget ? ma2MtcPlaybackSettings(timeline, true) : timeline;
          const manual = sequence.includes('<Trigger') ? ma2MtcSequenceSettings(sequence) : null;
          if (matchesMa2MtcSongSelection({ ...ranges, selectorReady: selector }, checkMtcFor, desired, manual?.xml ?? sequence, songPlayback)) {
            if (manual?.cues.length) result.selectorTriggerTarget = selector;
            if (ranges.selectorCommandTarget) result.selectorCommandTarget = ranges.selectorCommandTarget;
            if (ranges.selectorSettingsTarget) result.selectorSettingsTarget = selector;
            const changed = ranges.entries.filter(entry => checkMtcFor.includes(entry.target) && entry.playbackSettingsChanged).map(entry => entry.target);
            if (changed.length) result.songSettingsTargets = changed;
            const automatic = ranges.entries.filter(entry => checkMtcFor.includes(entry.target) && entry.automaticCueTriggers).map(entry => entry.target);
            if (automatic.length) result.songTriggerTargets = automatic;
            if (!changed.length && !automatic.length && !result.selectorSettingsTarget && !result.selectorCommandTarget && !result.selectorTriggerTarget) delete result.needsPlaybackPreparation;
          }
        }
        if (inputNote && !result.playbackConflict && !result.playbackClockNote && ranges.entries.some(entry => checkMtcFor.includes(entry.target) && entry.slot === MA2_SONG_TIMECODE_SLOT)) result.playbackClockNote = inputNote;
        return result;
      }
    }
    const { bridge } = this.get(target);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    const cache = new Map<number, import('./ma2-timecode-xml').Ma2SequenceReport['sequences'][number]>();
    const metrics = { elapsedMs: 0, requests: 0, bytes: 0, phases: {} as Record<string, number> };
    const measuredBridge: Pick<Ma2OnpcBridge, 'request'> = { request: async (...args) => { metrics.requests += 1; const value = await bridge.request(...args); metrics.bytes += Buffer.byteLength(value, 'utf8'); return value; } };
    let sequenceDirectory: Ma2ObjectDirectory | undefined;
    const trafficBefore = connection.readTraffic();
    const catalog = await readMa2Catalog(bridge, this.show, undefined, onProgress, signal, { targets, metrics, checkpoint, expectedSource, metadata: async numbers => {
      const missing = numbers.filter(number => !cache.has(number));
      if (missing.length) {
        const start = performance.now();
        sequenceDirectory ??= ma2ObjectDirectorySchema.parse(JSON.parse(await measuredBridge.request('LISTSEQ', 1)));
        const library = await readMa2NativeLibrary(connection, measuredBridge, this.show, undefined, 'library', signal, missing, {
          sessionDirectory: sequenceDirectory, measure: bytes => { metrics.requests += 1; metrics.bytes += bytes; }
        });
        metrics.phases.sequences = (metrics.phases.sequences ?? 0) + performance.now() - start;

        for (const sequence of library.sequences) cache.set(sequence.sequence, { number: sequence.sequence, name: sequence.name, cues: sequence.cues });
      }
      return { version: this.version ?? '', sequences: numbers.flatMap(number => { const entry = cache.get(number); return entry ? [entry] : []; }) };
    } });
    // The program started before the directory was checked again: what was read stays, marked not yet confirmed.
    const held = sequenceDirectory ? this.show('ma2.sync.read') : null;
    if (held?.kind === 'wait' && !catalog.sourceUnverified) { catalog.sourceUnverified = true; catalog.incomplete ??= `${held.message}序列都读完了，还没核对控台序列目录，停下后重新读取确认。`; }
    if (sequenceDirectory && !signal?.aborted && held?.kind === 'allow') {
      try {
        const verified = ma2ObjectDirectorySchema.parse(JSON.parse(await measuredBridge.request('LISTSEQ', 1)));
        if (JSON.stringify(sequenceDirectory) !== JSON.stringify(verified)) throw new Error('序列目录已变化');
      } catch (error) { catalog.sourceUnverified = true; catalog.incomplete = `序列来源复核未完成：${error instanceof Error ? error.message : String(error)}`; }
    }
    const trafficAfter = connection.readTraffic();
    catalog.metrics = { ...metrics, elapsedMs: performance.now() - started, queueMs: trafficAfter.queueMs - trafficBefore.queueMs, wireCommands: trafficAfter.wireCommands - trafficBefore.wireCommands, sentBytes: trafficAfter.sentBytes - trafficBefore.sentBytes, receivedBytes: trafficAfter.receivedBytes - trafficBefore.receivedBytes };
    await checkpoint?.(catalog);
    return catalog;
  }
  async preview(target: Ma2NetworkTarget, timecode: number, timeOriginMs = 0, signal?: AbortSignal, expectedSource?: Ma2ShowSource): Promise<import('@tb/schema').Ma2TimecodePreview> {
    const { bridge } = this.get(target);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    // Yield between complete read operations. An edit must never abort a shared
    // bridge transaction or invalidate other commands already in its queue.
    const gate: ShowGateReader = op => { signal?.throwIfAborted(); return this.show(op); };
    return readMa2NetworkPreview(timecode, timeOriginMs, () => {
      this.get(target);
      holdForShow(gate, 'ma2.sync.read');
      return bridge.request('READ', timecode);
    }, targets => readMa2NativeLibrary(connection, bridge, gate, undefined, 'library', undefined, targets, { referencedOnly: true }), expectedSource);
  }
  private async editingSource(target: Ma2NetworkTarget, onInputSlot?: (slot: number | null) => void): Promise<Ma2ShowSource> {
    this.target(target);
    if (this.bridgeIssue?.wait) await this.installDeferred();
    this.get(target);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    const observed = await readMa2ShowSource(connection, onInputSlot);
    if (connection !== this.connection) throw new Error('控台连接已变化');
    if (observed.generation) return observed;
    this.bridgeMissing(connection);
    await this.installDeferred();
    if (connection !== this.connection) throw new Error('控台连接已变化');
    this.get(target);
    const restored = await readMa2ShowSource(connection, onInputSlot);
    if (connection !== this.connection || !restored.generation) throw new Error('控台没有确认连接组件已启动，请重新连接控台');
    return restored;
  }
  /** No native write has started. The coordinator must adopt the live directory before this edit can run. */
  async checkEditingSource(target: Ma2NetworkTarget, expected: Ma2ShowSource): Promise<void> {
    holdForShow(this.show, 'ma2.sync.read');
    const source = await this.editingSource(target);
    if (source.show !== expected.show || source.version !== expected.version || source.generation !== expected.generation) {
      throw new Error(MA2_BRIDGE_MISSING_BEFORE_REQUEST);
    }
  }
  async readLibrary(target: Ma2NetworkTarget, onProgress?: (progress: Ma2ReadProgressUpdate) => void | Promise<void>, phase: 'library' | 'verification' = 'library', signal?: AbortSignal, targets?: readonly number[], expectedSource?: Ma2CatalogRequest['expectedSource'], details?: Ma2CatalogRequest['details']): Promise<import('@tb/schema').Ma2EffectLibrary> {
    this.target(target);
    if (this.bridgeIssue?.wait) await this.installDeferred();
    const { bridge } = this.get(target);
    if (!this.connection) throw new Error('请先连接控台');
    if (details === 'source') {
      if (targets?.length !== 0) throw new Error('核对来源时不能读取序列内容');
      signal?.throwIfAborted();
      holdForShow(this.show, 'ma2.sync.read');
      const source = await this.editingSource(target);
      signal?.throwIfAborted();
      holdForShow(this.show, 'ma2.sync.read');
      const directory = ma2ObjectDirectorySchema.parse({ ...source, entries: [] });
      return { directory, sequences: [], fixtureUsage: [], errors: [], fixtureDetails: 'unavailable', readAt: new Date().toISOString() };
    }
    if (details === 'attributes' || details === 'empty-cues') return readMa2EffectLibrary(bridge, this.show, onProgress, signal, targets, expectedSource, details, this.connection);
    return readMa2NativeLibrary(this.connection, bridge, this.show, onProgress, phase, signal, targets, { expectedSource });
  }
  async initialize(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.path, 'utf8'));
      const catalog = ma2NetworkCatalogSchema.safeParse(raw);
      if (catalog.success) { this.settings = catalog.data.active; this.profiles = catalog.data.profiles; }
      else { this.settings = ma2NetworkSettingsSchema.parse(raw); this.profiles = [this.settings]; }
    }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
      this.error = 'MA2 网络设置读取失败，请重新保存连接设置'; return;
    }
    try { this.passwordSaved = await this.secrets.hasCredential(this.credentialId(this.settings)); }
    catch { this.error = '读取保存的 MA2 密码失败，请重新保存密码'; return; }
    if (this.settings.autoConnect) await this.connect();
  }
  /** `connection` names this connection: every new login, and every disconnect, gives a new one, so a result read on an
   * earlier connection is not shown for this one (status-center, check-basis.ts). */
  status(): Ma2NetworkStatus {
    const relogin = this.settings ? this.relogin.view(consoleScope(this.settings)) : null;
    const stopped = relogin?.kind === 'stopped' ? relogin.reason : null;
    const error = this.error ?? (this.bridgeIssue && !this.bridgeIssue.wait ? this.bridgeIssue.message : null) ?? stopped;
    return { profiles: this.profiles, capabilities: this.capabilities, settings: this.settings, passwordSaved: this.passwordSaved, connection: this.generation,
      state: this.connection?.state === 'connected' && !this.version ? 'connecting' : this.connection?.state ?? 'disconnected', version: this.version, error,
      ...(this.version && !this.services && !this.bridgeIssue ? { awaitingRead: true as const } : {}),
      ...error && this.unreachable ? { unreachable: true } : {},
      ...relogin && relogin.kind !== 'idle' && relogin.kind !== 'connected' ? { relogin } : {},
      ...this.bridgeIssue?.wait ? { pluginWait: this.bridgeIssue.message } : {} };
  }
  async save(payload: Ma2NetworkSave): Promise<Ma2NetworkStatus> {
    holdForShow(this.show, 'ma2.connect');
    if (this.busy) throw new Error('MA2 正在连接，请稍后保存');
    const { settings, password } = ma2NetworkSaveSchema.parse(payload);
    this.busy = true;
    let release:(()=>void)|undefined;
    try {
      const replaceConnection=!this.sameTarget(settings)||password!==undefined;
      if(replaceConnection&&this.connection?.state==='connected')release=await this.beforeConnectionChange?.();
      const id = this.credentialId(settings);
      if (password !== undefined) await this.secrets.saveCredential(id, password);
      const profiles = this.profiles.filter((profile) => this.credentialId(profile) !== id || profile.monitorPort !== settings.monitorPort);
      profiles.push(settings);
      if (profiles.length > 128) throw new Error('最多保存 128 个控台连接');
      await writeFileAtomically(this.path, JSON.stringify({ format: 1, active: settings, profiles }));
      this.profiles = profiles;
      if(replaceConnection)this.disconnect();
      this.settings = settings; this.error = null; this.unreachable = false;
      this.passwordSaved = await this.secrets.hasCredential(id);
      return this.status();
    } finally { release?.();this.busy = false; }
  }
  async connect(recoverSession = false): Promise<Ma2NetworkStatus> {
    const gate = this.show('ma2.connect');
    // During the show only the console this run connected to, and only logging in (M5): it takes over from logging in
    // again on its own, and its counts start again. Another console, or one never connected, waits for the stop.
    if (gate.kind === 'wait') return this.connectDuringShow(gate.message);
    if (this.busy) throw new Error('MA2 正在连接');
    if (!this.settings) throw new Error('请先保存控台 IP 和登录用户');
    if (this.connection?.state === 'connected') return this.status();
    const armed = this.armed;
    if (recoverSession && this.identity?.source && armed) {
      this.busy = true;
      try {
        await this.loginOnly(armed);
        this.relogin.connected(consoleScope(armed), armed);
      } finally { this.busy = false; }
      return this.status();
    }
    this.disconnect(); this.error = null; this.unreachable = false; this.busy = true;
    const generation = this.generation;
    try {
      const settings = this.settings;
      const password = this.passwordSaved ? await this.secrets.loadCredential(this.credentialId(settings)) : '';
      const localAddress = await this.resolveLocalAddress(settings.host);
      await this.awaitListener?.(settings.host, settings.port);
      if (generation !== this.generation) return this.status();
      const connection = this.line(settings, localAddress);
      this.connection = connection;
      const version = await connection.connect(settings.username, password);
      if (generation !== this.generation) return this.status();
      this.version = version;
      this.identity = { version, source: null };
      this.armed = settings;
      this.relogin.connected(consoleScope(settings), settings);
    } catch (error) { if (generation === this.generation) { this.connection?.disconnect(); this.services = null; this.error = error instanceof Error ? error.message : String(error); this.unreachable = error instanceof Ma2UnreachableError; this.version = null; } }
    finally { this.busy = false; }
    return this.status();
  }
  /** The explicit read/check action owns bridge setup. Login and status polling never enter here. */
  async startReading(target: Ma2NetworkTarget): Promise<void> {
    this.target(target);
    const connection = this.connection, version = this.version;
    if (!connection || connection.state !== 'connected' || !version) throw new Error('请先登录控台');
    if (this.services) return;
    if (this.busy) throw new Error('MA2 正在处理连接请求');
    holdForShow(this.show, 'ma2.connect');
    this.busy = true;
    const current = (): void => {
      if (connection !== this.connection || connection.state !== 'connected') throw new Error('控台连接已改变，请重新读取控台');
    };
    try {
      await this.releaseAbandoned(connection);
      current();
      if (this.bundledBridge && !await this.prepareBridge(connection, this.bundledBridge)) throw new Error(this.bridgeIssue?.message ?? '请等节目停止后读取控台');
      current();
      const source = await readMa2ShowSource(connection);
      current();
      this.identity = { version, source };
      this.openServices(connection);
    } finally { this.busy = false; }
  }
  /** gma.show.getvar('SHOWFILE'), the value the bridge reports as directory.show.
   * Hex keeps non-ASCII show names intact over telnet; the H keeps an empty name matchable. */
  async currentShow(): Promise<string> {
    const connection = this.connection;
    if (!connection || connection.state !== 'connected') throw new Error('请先连接 MA2 控台');
    if (!this.identity?.source) throw new Error('已登录，请先读取控台');
    const marker = `TBLINK_SHOW_${randomBytes(16).toString('hex')}`;
    const script = `local s=tostring(gma.show.getvar('SHOWFILE') or '');gma.echo('${marker}:H'..(s:gsub('.',function(b)return string.format('%02x',string.byte(b))end)))`;
    const reply = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, `${marker}:`));
    if (!/^H(?:[0-9a-f]{2})*$/.test(reply)) throw new Error('控台返回的 Show 名称无法识别');
    const show = Buffer.from(reply.slice(1), 'hex').toString('utf8');
    if (!show) throw new Error('控台没有加载 Show');
    return show;
  }
  /** `gate`: what the show says about checking the console now (ShowStateService, 'ma2.check'): held and stopped check,
   * a moving program waits (2026-11-10 第 3 题). */
  async checkCapabilities(gate: ShowGate): Promise<Ma2NetworkStatus> {
    if (gate.kind === 'wait') throw new Error(gate.message);
    if (this.busy) throw new Error('MA2 正在处理连接请求');
    const connection = this.connection;
    if (!connection || connection.state !== 'connected' || !this.version) throw new Error('请先登录控台');
    const generation = this.generation; this.busy = true; this.capabilities = null;
    try {
      const checked = await readMa2Capabilities(connection, this.version);
      if (generation === this.generation && connection.state === 'connected') this.capabilities = checked;
    } finally { this.busy = false; }
    return this.status();
  }
  disconnect(): Ma2NetworkStatus {
    this.reconnectAllowed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.relogin.stop(); this.armed = null; this.identity = null; this.latestRanges = undefined;
    this.liveService?.close(); this.liveService?.consoleChanged();
    this.keepUnreleased();
    this.generation += 1;
    const connection = this.connection; this.connection = null;
    connection?.disconnect(); this.version = null; this.services = null; this.capabilities = null; this.bridgeIssue = null;
    return this.status();
  }
  /** One Telnet line to the console. Ending on its own: the idle reconnect while the show is idle, as before; while it is
   * not, logging in again (M5). A line closed here is no longer `this.connection` and says nothing. */
  private line(settings: Ma2NetworkSettings, localAddress: string | undefined): Ma2Telnet {
    const connection: Ma2Telnet = new Ma2Telnet({ ...settings, ...(localAddress ? { localAddress } : {}) }, (state, cause) => {
      if (state === 'disconnected' && this.connection === connection) this.lost(cause?.message ?? 'MA2 网络连接断开了');
    }, 5000, this.validatePeers ? peers => this.validatePeers!(settings.host, peers) : undefined);
    return connection;
  }
  private lost(reason: string): void {
    this.keepUnreleased();
    this.version = null; this.capabilities = null;
    // A login on its way finds out itself and counts as one attempt.
    if (this.relogin.outage) return;
    if (!this.reconnectAllowed) { this.error = reason; return; }
    this.dropReason = reason;
    if (this.show('ma2.connect').kind === 'wait') { this.error = null; this.relogin.dropped(reason); return; }
    this.error = 'MA2 连接已断开，正在恢复；编辑继续保存在本地';
    this.scheduleReconnect();
  }
  private openServices(connection: Ma2Telnet): void {
    if (!this.settings) throw new Error('控台连接已变化');
    const { host, port, monitorPort, username } = this.settings;
    const target = { host, port, monitorPort, username };
    const wire = new Ma2NetworkWire(connection, ma2UsesLocalFiles(host), this.requestJournal, Boolean(this.bundledBridge), () => {
      if (this.wire === wire) this.bridgeMissing(connection);
    }); this.wire = wire;
    const bridge = new Ma2OnpcBridge(wire, this.show);
    this.mtcSelection?.invalidate();
    this.services = { bridge, service: new Ma2ApplyService(bridge, this.show, {
      source: () => readMa2ShowSource(connection),
      verify: source => verifyMa2ShowSource(connection, source),
      prepare: (timecode, onConsoleCheck) => {
        if (this.connection !== connection || this.services?.bridge !== bridge) throw new Error('控台连接已变化');
        return this.prepareMtcPlayback(target, false, [timecode.number], undefined, timecode, {
          onConsoleCheck,
          checkCurrentSong: async () => {
            const checked = await this.readCatalog(target, undefined, undefined, [], undefined, undefined, [timecode.number]);
            if (checked.directory.show !== timecode.show || checked.directory.generation !== timecode.generation || this.connection !== connection) {
              throw new Error('控台 Show 或连接已切换，请重新核对当前节目');
            }
            if (checked.playbackConflict) throw new Error(checked.playbackConflict);
            if (!checked.directory.entries.some(entry => entry.target === timecode.number)) throw new Error(`当前 Show 中找不到 Timecode ${timecode.number}，请核对节目绑定后再同步`);
            return !checked.needsPlaybackPreparation;
          }
        });
      }
    }) };
    this.bridgeIssue = null;
    this.reconnectAllowed = true; this.reconnectDelay = 1000;
  }
  /** Plugin transactions a dropped line left open, released once on the next login to the same console (a short command each). */
  private async releaseAbandoned(connection: Ma2Telnet): Promise<void> {
    const abandoned = this.unreleased; this.unreleased = null;
    if (!this.settings) throw new Error('控台连接目标已改变');
    const key = createHash('sha256').update(consoleScope(this.settings)).digest('hex');
    const journal = new Ma2RequestJournal(`${this.path}.requests/${key}.json`); this.requestJournal = journal;
    const ids = new Set([...journal.pending(), ...(abandoned && this.sameTarget(abandoned.settings) ? abandoned.ids : [])]);
    for (const id of ids) {
      try { await new Ma2NetworkWire(connection, false, journal).releaseAbandoned(id); this.notice?.('info', `已释放上次断线时未完成的控台请求 ${id}`); }
      catch (cause) { this.notice?.('warning', `上次断线时未完成的控台请求 ${id} 未能释放：${cause instanceof Error ? cause.message : String(cause)}；控台插件会在 2 分钟内自动释放`); }
    }
  }
  /** The operator connects during the show (M5): only the console this run connected to, and only logging in. */
  private async connectDuringShow(wait: string): Promise<Ma2NetworkStatus> {
    const settings = this.settings, armed = this.armed;
    if (!settings || !armed || !this.sameTarget(armed)) throw new Error(wait);
    if (this.busy) throw new Error('MA2 正在连接');
    if (this.connection?.state === 'connected') return this.status();
    this.relogin.stop(); this.busy = true;
    try { await this.loginOnly(settings, false); this.relogin.connected(consoleScope(settings), settings); }
    catch (error) { this.error = error instanceof Error ? error.message : String(error); this.unreachable = error instanceof Ma2UnreachableError; }
    finally { this.busy = false; }
    return this.status();
  }
  /**
   * Logging in again during the show (M5, design 03 §4.2.5), by itself or by the operator: the saved login only, the
   * monitor port, the plugin transactions a dropped line left open, and two short checks, never a read of the console's
   * contents or a sync (2026-10-30: no reading again after a reconnect). The console must be the one, and its Show the
   * one, this run connected to; what a person must deal with throws `Ma2ReloginStop`. The plugin is only looked at:
   * missing or old, it waits for the show to stop (`installDeferred`). Lights-off and the web remote need no plugin.
   */
  private async loginOnly(settings: Ma2NetworkSettings, resumeReadSession = true): Promise<void> {
    const previous = this.connection; this.connection = null; previous?.disconnect();
    this.keepUnreleased();
    this.services = null; this.bridgeIssue = null; this.version = null; this.capabilities = null; this.error = null; this.unreachable = false;
    this.generation += 1;
    const generation = this.generation;
    const current = (): void => { if (generation !== this.generation) throw new Error('控台连接已改变'); };
    let password = '';
    if (this.passwordSaved) {
      try { password = await this.secrets.loadCredential(this.credentialId(settings)); }
      catch (cause) { throw new Ma2ReloginStop(`保存的控台密码读不出来（${cause instanceof Error ? cause.message : String(cause)}），没有再自动登录。请在设备设置里重新保存密码后点连接`); }
    }
    const localAddress = await this.resolveLocalAddress(settings.host);
    await this.awaitListener?.(settings.host, settings.port);
    current();
    const connection = this.line(settings, localAddress);
    this.connection = connection;
    try {
      let version: string;
      try { version = await connection.connect(settings.username, password); }
      catch (cause) { throw cause instanceof Ma2LoginRefusedError ? new Ma2ReloginStop(cause.message) : cause; }
      current();
      if (!resumeReadSession || !this.identity?.source) {
        if (this.identity && this.identity.version !== version) throw new Ma2ReloginStop('控台软件版本已改变，请核对后重新连接');
        this.version = version;
        this.identity = { version, source: null };
        return;
      }
      await this.releaseAbandoned(connection);
      current();
      const source = await readMa2ShowSource(connection);
      current();
      const before = this.identity;
      if (before && before.version !== version) throw new Ma2ReloginStop(`连上的不是原来那台控台（控台软件版本是 ${version}，原来是 ${before.version}），没有接着用。请确认控台后点连接`);
      if (before?.source && before.source.show !== source.show) throw new Ma2ReloginStop(`控台上的 Show 换了（现在是「${source.show || '没有加载'}」，原来是「${before.source.show}」），没有接着用，也没有重新读取。请确认控台后点连接`);
      const bridge: Ma2BridgeState = this.bundledBridge ? await readMa2NetworkBridge(connection, this.bundledBridge) : 'ready';
      current();
      if (connection.state !== 'connected') throw new Error('MA2 网络连接又断开了');
      this.version = version;
      if (bridge === 'ready') this.openServices(connection);
      else { this.bridgeIssue = { wait: true, message: bridgeWaitText(bridge) }; this.notice?.('warning', this.bridgeIssue.message); }
      this.identity = { version, source };
      if (before?.source) this.liveService?.consoleBack(before.source, source);
    } catch (error) {
      if (generation === this.generation && this.connection === connection) { this.connection = null; connection.disconnect(); this.version = null; this.unreachable = error instanceof Ma2UnreachableError; }
      throw error;
    }
    void this.installDeferred();
  }
  /** The plugin that waited for the show to stop (M5), installed once it has: as the operator's connect would. */
  private bridgeMissing(connection: Ma2Telnet): void {
    if (connection !== this.connection || this.bridgeIssue || !this.bundledBridge) return;
    this.services = null;
    this.bridgeIssue = { wait: true, message: this.show('ma2.connect').kind === 'wait' ? bridgeWaitText('missing') : '控台连接组件已停止，正在恢复连接' };
    this.notice?.('warning', this.bridgeIssue.message);
  }
  private installDeferred(): Promise<void> {
    if (this.bridgeInstall) return this.bridgeInstall;
    const task = this.installMissingBridge();
    this.bridgeInstall = task;
    return task.finally(() => { if (this.bridgeInstall === task) this.bridgeInstall = null; });
  }
  private async prepareBridge(connection: Ma2Telnet, source: string): Promise<boolean> {
    try {
      await ensureMa2NetworkBridge(connection, source, async waiting => {
        if (this.disconnectingBridgeWait) await this.disconnectingBridgeWait;
        if (this.connection !== connection || connection.state !== 'connected') throw new Error('控台连接已停止');
        holdForShow(this.show, 'ma2.connect');
        this.bridgeAdmissionWaiting = waiting;
      }, ma2UsesLocalFiles(this.settings?.host ?? ''));
      return true;
    } catch (cause) {
      if (!isShowWait(cause)) throw cause;
      this.bridgeIssue = { wait: true, message: `${SHOW_WAIT_SHOW_ON}灯光连接组件等节目停止后继续准备` };
      this.notice?.('info', this.bridgeIssue.message);
      return false;
    } finally { this.bridgeAdmissionWaiting = false; }
  }
  private async installMissingBridge(): Promise<void> {
    const connection = this.connection, issue = this.bridgeIssue, source = this.bundledBridge;
    if (!issue?.wait || !source || !connection || connection.state !== 'connected' || this.busy || this.show('ma2.connect').kind === 'wait') return;
    const generation = this.generation; this.busy = true;
    try {
      if (!await this.prepareBridge(connection, source)) return;
      if (generation !== this.generation) return;
      const before = this.identity?.source ?? null;
      let after: Ma2ShowSource | null = null;
      try { after = await readMa2ShowSource(connection); }
      catch (cause) { this.notice?.('warning', `控台插件装上了，但没读到控台现在的 Show：${cause instanceof Error ? cause.message : String(cause)}`); }
      if (generation !== this.generation) return;
      if (!after?.generation) throw new Error('控台没有确认连接组件已启动');
      this.openServices(connection);
      if (this.identity) this.identity = { ...this.identity, source: after };
      if (before) this.liveService?.consoleBack(before, after);
      this.notice?.('info', '控台连接组件已恢复，已核对当前 Show，可以继续同步');
    } catch (cause) {
      if (generation !== this.generation) return;
      this.bridgeIssue = { wait: false, message: `演出停了，但控台插件没装上：${cause instanceof Error ? cause.message : String(cause)}。请断开控台再连接一次` };
      this.notice?.('warning', this.bridgeIssue.message);
    } finally { this.busy = false; }
  }
  async disconnectByOperator():Promise<Ma2NetworkStatus>{
    const waiting = this.bridgeAdmissionWaiting;
    if(this.busy && (!waiting || this.disconnectingBridgeWait))throw new Error('MA2 正在连接，请稍后断开');
    let finishWait: (() => void) | undefined;
    if (waiting) this.disconnectingBridgeWait = new Promise(resolve => { finishWait = resolve; });
    this.busy=true;
    let release:(()=>void)|undefined;
    try{if(this.connection?.state==='connected')release=await this.beforeConnectionChange?.();return this.disconnect();}
    finally{release?.();this.disconnectingBridgeWait=null;finishWait?.();if(!waiting)this.busy=false;}
  }
}

/** One console connection's settings, as the key logging in again is armed with. */
const consoleScope = (settings: Ma2NetworkSettings): string => JSON.stringify([settings.host, settings.port, settings.monitorPort, settings.username]);
/** The Telnet line's words for logging in again (M5); the row's limit text is the table's. */
const CONSOLE_RELOGIN: Ma2ReloginPlan = {
  row: 'ma2.relogin', line: 'console',
  words: {
    attempt: (attempt: number, seconds: number, minutes: number, first: boolean, reason: string): string => `控台断开了，第 ${attempt} 次自动重新登录：已经断了 ${seconds} 秒，最多试 ${minutes} 分钟。${first ? '断开的原因' : '上一次没登上'}：${reason}`,
    succeeded: (attempt: number, seconds: number): string => `控台自动重新登录成功：第 ${attempt} 次登上，断了 ${seconds} 秒。没有重新读取控台，关灯和按键照常`,
    limit: (limitText: string, tried: number): string => `${limitText}（试了 ${tried} 次）`,
    stopped: (reason: string): string => `控台没有再自动重新登录：${reason}`
  },
  needsPerson: (error: unknown): boolean => error instanceof Ma2ReloginStop
};
/** What waits while the plugin waits for the show to stop. A wait, so it starts as one (`isShowWait`). */
function bridgeWaitText(state: Exclude<Ma2BridgeState, 'ready'>): string {
  const what = state === 'missing' ? '控台上的联动台插件不见了（控台载入过 Show 或重启过），停止以后会自动重新装上'
    : state === 'old' ? '控台上的联动台插件是旧版本，停止以后会自动换成新版本'
    : '控台的连接接口被一个不认识的插件占用了，停止以后会再检查一次';
  return `${SHOW_WAIT_SHOW_ON}${what}。这期间关灯和网页遥控照常，走控台插件的按键、同步和读取控台先等着。`;
}
