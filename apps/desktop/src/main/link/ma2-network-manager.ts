import { ma2PlaybackRequestSchema, type Ma2PlaybackRequest, type Ma2Catalog, type Ma2CatalogRequest, ma2ObjectDirectorySchema, type Ma2ObjectDirectory } from '@tb/schema';
import { playMa2Cue } from './ma2-pool-playback';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ma2NetworkSettingsSchema, ma2NetworkSaveSchema, ma2NetworkCatalogSchema, ma2TimecodeRangesSchema, type Ma2Capabilities, type Ma2NetworkSettings, type Ma2NetworkSave, type Ma2NetworkStatus, type Ma2NetworkTarget, type Ma2ReadProgressUpdate } from '@tb/schema';
import { SecureProfileStore } from './secure-profile-store';
import { writeFileAtomically } from './atomic-file';
import { Ma2Telnet, Ma2UnreachableError, ma2ResponseLine, type Ma2ConnectedPeer } from './ma2-telnet';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2ApplyService } from './ma2-apply-service';
import { ensureMa2NetworkBridge } from './ma2-bridge-installer';
import { readMa2NativeLibrary } from './ma2-native-library';
import { readMa2EffectLibrary } from './ma2-effect-library';
import { Ma2LayoutService } from './ma2-layout-service';
import { listMa2ExecutorPages, readMa2ExecutorPage } from './ma2-executor-page';
import { Ma2ExecutorMutationService } from './ma2-executor-mutation-service';
import { Ma2ExecutorInputService } from './ma2-executor-input';
import { Ma2CueDeleteService } from './ma2-cue-delete-service';
import { readMa2Catalog } from './ma2-catalog';
import { readMa2NetworkPreview } from './ma2-network-preview';
import { Ma2LiveService } from './ma2-live-service';
import { Ma2SongWatch } from './ma2-song-watch';
import type { Ma2ConsoleBackups } from './ma2-console-backups';

/** One chosen console, machine settings only. Auto-connect never replays writes. */
export class Ma2NetworkManager {
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
      if (this.isPlaying() || this.busy) { this.scheduleReconnect(); return; }
      void this.connect().then(status => {
        if (status.state !== 'connected') { this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2); this.scheduleReconnect(); }
      }, (cause: unknown) => {
        this.error = `恢复控台连接：${cause instanceof Error ? cause.message : String(cause)}`;
        this.reconnectDelay = Math.min(30000, this.reconnectDelay * 2);
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
    this.reconnectTimer.unref();
  }
  private services: { bridge: Ma2OnpcBridge; service: Ma2ApplyService } | null = null;
  private wire: Ma2NetworkWire | null = null;
  /** A plugin transaction left open by a dropped connection, released once on the next login to the same console. */
  private unreleased: { id: string; settings: Ma2NetworkSettings } | null = null;
  private keepUnreleased(): void {
    const id = this.wire?.unreleasedRequest;
    if (id && this.settings) this.unreleased = { id, settings: this.settings };
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
  /** Read-only: where every console Timecode show sits in time, for placing a song that has no start yet. */
  async timecodeRanges(network: Ma2NetworkTarget): Promise<import('@tb/schema').Ma2TimecodeRanges> {
    return ma2TimecodeRangesSchema.parse(JSON.parse(await this.get(network).bridge.request('TCRANGES', 1)));
  }
  async checkSong(request: import('@tb/schema').Ma2SongCheckRequest): Promise<boolean> {
    const { bridge } = this.get(request.network);
    if (!this.connection) throw new Error('请先连接控台');
    this.songWatch ??= new Ma2SongWatch(this.isPlaying);
    return this.songWatch.changed(this.connection, bridge, request);
  }
  private liveService: Ma2LiveService | null = null;
  live(): Ma2LiveService { return this.liveService ??= new Ma2LiveService(`${this.path}.playback.json`, this.secrets, request => this.get(request.network).bridge); }
  private layouts(): Ma2LayoutService {
    if (!this.consoleBackups) throw new Error('控台备份记录还没准备好');
    return this.layoutService ??= new Ma2LayoutService(`${this.path}.layouts.json`, this.isPlaying, this.consoleBackups);
  }
  private consoleBackups: Ma2ConsoleBackups | null = null;
  setConsoleBackups(backups: Ma2ConsoleBackups): void { this.consoleBackups = backups; }
  private cueDeleteService: Ma2CueDeleteService | null = null;
  setCueDeletionProjectReader(load: (path: string) => Promise<import('@tb/schema').LinkProject>): void {
    this.cueDeleteService = new Ma2CueDeleteService(`${this.path}.cue-backups`, load, this.isPlaying);
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
  async listExecutorPages(request: import('@tb/schema').Ma2LayoutDirectoryRequest) { return listMa2ExecutorPages(this.get(request.network).bridge, request); }
  async readExecutorPage(request: import('@tb/schema').Ma2ExecutorPageRequest) { return readMa2ExecutorPage(this.get(request.network).bridge, request); }
  private executorMutations: Ma2ExecutorMutationService | null = null;
  private executorInput = new Ma2ExecutorInputService();
  private executorMutationBusy = false;
  async inputExecutor(request: import('@tb/schema').Ma2ExecutorInput): Promise<void> {
    this.get(request.network);
    const connection = this.connection; const generation = this.generation;
    if (!connection) throw new Error('请先连接控台');
    await this.executorInput.input(connection, request, () => {
      if (this.generation !== generation || connection.state !== 'connected') throw new Error('控台连接变了，按键没有发送');
      if (request.pressed && this.executorMutationBusy) throw new Error('正在更新执行器位置，请等控台确认后再按');
    });
  }
  async releaseExecutors(): Promise<void> { await this.executorInput.release(); }
  async updateExecutor(request: import('@tb/schema').Ma2ExecutorUpdateRequest): Promise<import('@tb/schema').Ma2ExecutorUpdateResult> {
    const { bridge } = this.get(request.network);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    if (this.executorMutationBusy) throw new Error('正在确认上一个执行器修改，请稍候');
    this.executorMutationBusy = true;
    try {
      await this.executorInput.release();
      if (this.connection !== connection || connection.state !== 'connected') throw new Error('控台连接变了，没有修改执行器');
      this.executorMutations ??= new Ma2ExecutorMutationService(`${this.path}.executor-backups`, this.isPlaying);
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
    const { bridge } = this.get(request.network); const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    // A cached song check that still matches the console saves reading the whole Sequence again.
    const binding = request.binding;
    const baseline = binding && this.songWatch ? await this.songWatch.unchangedBaseline(connection, { network: request.network, expectedSource: request.expectedSource, sequence: binding.sequence, ...binding.executor ? { executor: binding.executor } : {} }, binding.baselineXml) : null;
    // The verified post-write export becomes the next check's baseline, so that check is not a full read either.
    const adoptReadback = async (exportFile: string, result: import('@tb/schema').Ma2SongSyncResult): Promise<boolean> => {
      if (!result.remoteRevision) return false;
      this.songWatch ??= new Ma2SongWatch(this.isPlaying);
      try {
        return await this.songWatch.adopt(connection, { network: request.network, expectedSource: request.expectedSource, sequence: result.binding.sequence, ...result.binding.executor ? { executor: result.binding.executor } : {}, revision: result.remoteRevision }, exportFile);
      } catch (cause) {
        this.notice?.('warning', `这次读取的内容没能接上上次复查的记录：${cause instanceof Error ? cause.message : String(cause)}；下次复查会重新读取整个序列`);
        return false;
      }
    };
    return this.layouts().syncSong(connection, bridge, request, report, signal, { consoleBaseline: baseline, adoptReadback });
  }
  async newCue(request: import('@tb/schema').Ma2NewCueRequest): Promise<import('@tb/schema').Ma2NewCueResult> {
    const {bridge}=this.get(request.network); const connection=this.connection;
    if(!connection)throw new Error('请先连接控台');
    return this.layouts().create(connection,bridge,request);
  }
  constructor(directory: string, private readonly secrets: Pick<SecureProfileStore, 'hasCredential' | 'saveCredential' | 'loadCredential'>, private readonly isPlaying: () => boolean = () => false, private readonly bundledBridge?: string, private readonly resolveLocalAddress: (host: string) => Promise<string | undefined> = () => Promise.resolve(undefined), private readonly validatePeers?: (host: string, peers: readonly Ma2ConnectedPeer[]) => Promise<void>, private readonly awaitListener?: (host: string, port: number) => Promise<void>, private readonly notice?: (level: 'info' | 'warning', message: string) => void) { this.path = join(directory, 'link-integrations', 'ma2-network.json'); }
  get(target: Ma2NetworkTarget): { bridge: Ma2OnpcBridge; service: Ma2ApplyService } {
    const settings = this.settings;
    if (!settings || target.host !== settings.host || target.port !== settings.port || target.monitorPort !== settings.monitorPort || target.username !== settings.username) throw new Error('MA2 连接目标已改变，请重新读取控台');
    if (this.capabilities && (!this.capabilities.objects || !this.capabilities.files)) throw new Error(this.capabilities.message);
    if (this.connection?.state !== 'connected' || !this.services) throw new Error('请先连接 MA2 控台');
    return this.services;
  }
  cancelPlayback(sessionId: string): void {
    const now = Date.now();
    for (const [id, expiresAt] of this.cancelledPlayback) if (expiresAt < now) this.cancelledPlayback.delete(id);
    this.cancelledPlayback.set(sessionId, now + 180000);
  }
  get connectionGeneration():number { return this.generation; }
  async playCue(input: Ma2PlaybackRequest, options?:{beforeSend?:()=>void;priority?:'normal'|'playback'|'stop'}): Promise<void> {
    const request = ma2PlaybackRequestSchema.parse(input);
    const settings = this.settings; const connection = this.connection; const generation = this.generation;
    if (!settings || !connection || connection.state !== 'connected') throw new Error('序列池播放需要先在设备设置连接 MA2 网络');
    if (Object.entries(request.network).some(([key, value]) => Reflect.get(settings, key) !== value)) throw new Error('控台连接目标已改变，请重新选择 Cue');
    const current = (): void => {
      if (generation !== this.generation || connection.state !== 'connected' || this.cancelledPlayback.has(request.sessionId)) throw new Error('灯光播放已结束，排队的 Cue 已取消');
      if (Date.now() > request.deadlineAt) throw new Error('灯光调用已过期，没有补发，请重新定位后播放');
    };
    current();
    await playMa2Cue(connection, request.action, ()=>{current();options?.beforeSend?.();},options?.priority);
  }
  private credentialId(settings: Ma2NetworkSettings): string { return `ma2-${createHash('sha256').update(`${settings.host}:${settings.port}:${settings.username}`).digest('hex')}`; }
  async readCatalog(target: Ma2NetworkTarget, onProgress?: (progress: Ma2ReadProgressUpdate) => void, signal?: AbortSignal, targets?: readonly number[], checkpoint?: (catalog: Ma2Catalog, entry?: Ma2Catalog['entries'][number]) => Promise<void>, expectedSource?: Ma2CatalogRequest['expectedSource']): Promise<Ma2Catalog> {
    const started = performance.now();
    const { bridge } = this.get(target);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    const cache = new Map<number, import('./ma2-timecode-xml').Ma2SequenceReport['sequences'][number]>();
    const metrics = { elapsedMs: 0, requests: 0, bytes: 0, phases: {} as Record<string, number> };
    const measuredBridge: Pick<Ma2OnpcBridge, 'request'> = { request: async (...args) => { metrics.requests += 1; const value = await bridge.request(...args); metrics.bytes += Buffer.byteLength(value, 'utf8'); return value; } };
    let sequenceDirectory: Ma2ObjectDirectory | undefined;
    const trafficBefore = connection.readTraffic();
    const catalog = await readMa2Catalog(bridge, this.isPlaying, undefined, onProgress, signal, { targets, metrics, checkpoint, expectedSource, metadata: async numbers => {
      const missing = numbers.filter(number => !cache.has(number));
      if (missing.length) {
        const start = performance.now();
        sequenceDirectory ??= ma2ObjectDirectorySchema.parse(JSON.parse(await measuredBridge.request('LISTSEQ', 1)));
        const library = await readMa2NativeLibrary(connection, measuredBridge, this.isPlaying, undefined, 'library', signal, missing, bytes => { metrics.requests += 1; metrics.bytes += bytes; }, sequenceDirectory);
        metrics.phases.sequences = (metrics.phases.sequences ?? 0) + performance.now() - start;

        for (const sequence of library.sequences) cache.set(sequence.sequence, { number: sequence.sequence, name: sequence.name, cues: sequence.cues });
      }
      return { version: this.version ?? '', sequences: numbers.flatMap(number => { const entry = cache.get(number); return entry ? [entry] : []; }) };
    } });
    if (sequenceDirectory && !signal?.aborted && !this.isPlaying()) {
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
  async preview(target: Ma2NetworkTarget, timecode: number, timeOriginMs = 0): Promise<import('@tb/schema').Ma2TimecodePreview> {
    const { bridge } = this.get(target);
    const connection = this.connection;
    if (!connection) throw new Error('请先连接控台');
    return readMa2NetworkPreview(timecode, timeOriginMs, () => {
      this.get(target);
      if (this.isPlaying()) throw new Error('请停止播放后读取灯光');
      return bridge.request('READ', timecode);
    }, targets => readMa2NativeLibrary(connection, bridge, this.isPlaying, undefined, 'library', undefined, targets));
  }
  async readLibrary(target: Ma2NetworkTarget, onProgress?: (progress: Ma2ReadProgressUpdate) => void | Promise<void>, phase: 'library' | 'verification' = 'library', signal?: AbortSignal, targets?: readonly number[], expectedSource?: Ma2CatalogRequest['expectedSource'], details?: Ma2CatalogRequest['details']): Promise<import('@tb/schema').Ma2EffectLibrary> {
    const { bridge } = this.get(target);
    if (!this.connection) throw new Error('请先连接控台');
    if (details === 'attributes') return readMa2EffectLibrary(bridge, this.isPlaying, onProgress, signal, targets, expectedSource, details, this.connection);
    return readMa2NativeLibrary(this.connection, bridge, this.isPlaying, onProgress, phase, signal, targets, undefined, undefined, expectedSource);
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
  status(): Ma2NetworkStatus { return { profiles: this.profiles, capabilities: this.capabilities, settings: this.settings, passwordSaved: this.passwordSaved, state: this.connection?.state === 'connected' && !this.services ? 'connecting' : this.connection?.state ?? 'disconnected', version: this.version, error: this.error, ...this.error && this.unreachable ? { unreachable: true } : {} }; }
  async save(payload: Ma2NetworkSave): Promise<Ma2NetworkStatus> {
    if (this.isPlaying()) throw new Error('播放期间不能更换控台连接');
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
  async connect(): Promise<Ma2NetworkStatus> {
    if (this.isPlaying()) throw new Error('播放期间不能更换控台连接');
    if (this.busy) throw new Error('MA2 正在连接');
    if (!this.settings) throw new Error('请先保存控台 IP 和登录用户');
    if(this.connection?.state==='connected'&&this.services)return this.status();
    const recovering = this.reconnectAllowed;
    this.disconnect(); this.reconnectAllowed = recovering; this.error = null; this.unreachable = false; this.busy = true;
    const generation = this.generation;
    try {
      const settings = this.settings;
      const password = this.passwordSaved ? await this.secrets.loadCredential(this.credentialId(settings)) : '';
      const localAddress = await this.resolveLocalAddress(settings.host);
      await this.awaitListener?.(settings.host, settings.port);
      if (generation !== this.generation) return this.status();
      const connection = new Ma2Telnet({ ...settings, ...(localAddress ? { localAddress } : {}) }, (state) => {
        if (state === 'disconnected' && this.connection === connection) {
          this.keepUnreleased();
          this.version = null; this.capabilities = null;
          this.error = 'MA2 连接已断开，正在恢复；编辑继续保存在本地';
          this.scheduleReconnect();
        }
      }, 5000, this.validatePeers ? peers => this.validatePeers!(settings.host, peers) : undefined);
      this.connection = connection;
      const version = await connection.connect(settings.username, password);
      if (generation !== this.generation) return this.status();
      this.version = version;
      // Free the slot before installing or upgrading the bridge: an upgrade needs an idle transaction too.
      const abandoned = this.unreleased; this.unreleased = null;
      if (abandoned && this.sameTarget(abandoned.settings)) {
        try { await new Ma2NetworkWire(connection).releaseAbandoned(abandoned.id); this.notice?.('info', `已释放上次断线时未完成的控台请求 ${abandoned.id}`); }
        catch (cause) { this.notice?.('warning', `上次断线时未完成的控台请求 ${abandoned.id} 未能释放：${cause instanceof Error ? cause.message : String(cause)}；控台插件会在 2 分钟内自动释放`); }
      }
      if (generation !== this.generation) return this.status();
      if (this.bundledBridge) await ensureMa2NetworkBridge(connection, this.bundledBridge);
      if (generation !== this.generation) return this.status();
      const wire = new Ma2NetworkWire(connection); this.wire = wire;
      const bridge = new Ma2OnpcBridge(wire, this.isPlaying);
      this.services = { bridge, service: new Ma2ApplyService(bridge, this.isPlaying) };
      this.reconnectAllowed = true; this.reconnectDelay = 1000;
    } catch (error) { if (generation === this.generation) { this.connection?.disconnect(); this.services = null; this.error = error instanceof Error ? error.message : String(error); this.unreachable = error instanceof Ma2UnreachableError; this.version = null; } }
    finally { this.busy = false; }
    return this.status();
  }
  /** gma.show.getvar('SHOWFILE'), the value the bridge reports as directory.show.
   * Hex keeps non-ASCII show names intact over telnet; the H keeps an empty name matchable. */
  async currentShow(): Promise<string> {
    const connection = this.connection;
    if (!connection || connection.state !== 'connected') throw new Error('请先连接 MA2 控台');
    const marker = `TBLINK_SHOW_${randomBytes(16).toString('hex')}`;
    const script = `local s=tostring(gma.show.getvar('SHOWFILE') or '');gma.echo('${marker}:H'..(s:gsub('.',function(b)return string.format('%02x',string.byte(b))end)))`;
    const reply = await connection.command(`Lua "${script}"`, text => ma2ResponseLine(text, `${marker}:`));
    if (!/^H(?:[0-9a-f]{2})*$/.test(reply)) throw new Error('控台返回的 Show 名称无法识别');
    const show = Buffer.from(reply.slice(1), 'hex').toString('utf8');
    if (!show) throw new Error('控台没有加载 Show');
    return show;
  }
  async checkCapabilities(): Promise<Ma2NetworkStatus> {
    if (this.isPlaying()) throw new Error('请停止播放后检测控台兼容性');
    if (this.busy) throw new Error('MA2 正在处理连接请求');
    const connection = this.connection;
    if (!connection || connection.state !== 'connected' || !this.version) throw new Error('请先登录控台');
    const generation = this.generation; this.busy = true; this.capabilities = null;
    try {
      const marker = `TBLINK_CAP_${randomBytes(16).toString('hex')}`;
      const script = "tostring(_VERSION)..':'..tostring(type(TBLINK_NET)=='function')..':'..tostring(type(gma.show.getobj)=='table' and type(gma.show.getobj.handle)=='function')..':'..tostring(type(io)=='table' and type(io.open)=='function')";
      const result = await connection.command(`Lua "gma.echo('${marker}:'..${script})"`, (text) => ma2ResponseLine(text, `${marker}:`));
      const parts = result.split(':');
      if (parts.length !== 4 || !parts.slice(1).every((part) => part === 'true' || part === 'false')) throw new Error('控台返回的功能信息无法识别');
      if (generation !== this.generation) return this.status();
      const plugin = parts[1] === 'true', objects = parts[2] === 'true', files = parts[3] === 'true';
      this.capabilities = { version: this.version, lua: parts[0]!, plugin, objects, files,
        message: plugin && objects && files ? '基本功能可用。请先读取目标 Timecode 检查内容，写入后联动台会再读回确认。' : !plugin ? '没有检测到控台插件，请导出插件并在控台上运行后重新检测。' : '这个控台版本缺少需要的功能，无法自动同步。' };
    } finally { this.busy = false; }
    return this.status();
  }
  disconnect(): Ma2NetworkStatus {
    this.reconnectAllowed = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.liveService?.close();
    this.keepUnreleased();
    this.generation += 1;
    const connection = this.connection; this.connection = null;
    connection?.disconnect(); this.version = null; this.services = null; this.capabilities = null;
    return this.status();
  }
  async disconnectByOperator():Promise<Ma2NetworkStatus>{
    if(this.busy)throw new Error('MA2 正在连接，请稍后断开');
    this.busy=true;
    let release:(()=>void)|undefined;
    try{if(this.connection?.state==='connected')release=await this.beforeConnectionChange?.();return this.disconnect();}
    finally{release?.();this.busy=false;}
  }
}
