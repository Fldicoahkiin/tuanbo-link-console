import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { ma2NetworkSettingsSchema, ma2NetworkSaveSchema, ma2NetworkCatalogSchema, type Ma2Capabilities, type Ma2NetworkSettings, type Ma2NetworkSave, type Ma2NetworkStatus, type Ma2NetworkTarget, type Ma2ReadProgressUpdate } from '@tb/schema';
import { SecureProfileStore } from './secure-profile-store';
import { writeFileAtomically } from './atomic-file';
import { Ma2Telnet, ma2ResponseLine } from './ma2-telnet';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2ApplyService } from './ma2-apply-service';
import { ensureMa2NetworkBridge } from './ma2-bridge-installer';
import { readMa2NativeLibrary } from './ma2-native-library';
import { readMa2Catalog } from './ma2-catalog';

/** One chosen console, machine settings only. Auto-connect never replays writes. */
export class Ma2NetworkManager {
  private profiles: Ma2NetworkSettings[] = [];
  private capabilities: Ma2Capabilities | null = null;
  private settings: Ma2NetworkSettings | null = null;
  private connection: Ma2Telnet | null = null;
  private version: string | null = null;
  private error: string | null = null;
  private passwordSaved = false;
  private busy = false;
  private generation = 0;
  private services: { bridge: Ma2OnpcBridge; service: Ma2ApplyService } | null = null;
  private readonly path: string;
  constructor(directory: string, private readonly secrets: Pick<SecureProfileStore, 'hasCredential' | 'saveCredential' | 'loadCredential'>, private readonly isPlaying: () => boolean = () => false, private readonly bundledBridge?: string) { this.path = join(directory, 'link-integrations', 'ma2-network.json'); }
  get(target: Ma2NetworkTarget): { bridge: Ma2OnpcBridge; service: Ma2ApplyService } {
    const settings = this.settings;
    if (!settings || target.host !== settings.host || target.port !== settings.port || target.monitorPort !== settings.monitorPort || target.username !== settings.username) throw new Error('MA2 连接目标已改变，请重新读取控台');
    if (this.capabilities && (!this.capabilities.objects || !this.capabilities.files)) throw new Error(this.capabilities.message);
    if (this.connection?.state !== 'connected' || !this.services) throw new Error('请先连接 MA2 控台');
    return this.services;
  }
  private credentialId(settings: Ma2NetworkSettings): string { return `ma2-${createHash('sha256').update(`${settings.host}:${settings.port}:${settings.username}`).digest('hex')}`; }
  async readCatalog(target: Ma2NetworkTarget, onProgress?: (progress: Ma2ReadProgressUpdate) => void, signal?: AbortSignal): Promise<import('@tb/schema').Ma2Catalog> {
    const { bridge } = this.get(target);
    const before = await this.readLibrary(target, onProgress, 'library', signal);
    const result = await readMa2Catalog(bridge, this.isPlaying, { version: before.directory.version, sequences: before.sequences.map(sequence => ({ number: sequence.sequence, name: sequence.name, cues: sequence.cues })) }, onProgress, signal);
    const after = await this.readLibrary(target, onProgress, 'verification', signal);
    if (JSON.stringify(before.directory) !== JSON.stringify(after.directory) || JSON.stringify(before.sequences) !== JSON.stringify(after.sequences)) throw new Error('扫描期间控台序列发生变化，请重新扫描');
    return result;
  }
  async readLibrary(target: Ma2NetworkTarget, onProgress?: (progress: Ma2ReadProgressUpdate) => void, phase: 'library' | 'verification' = 'library', signal?: AbortSignal): Promise<import('@tb/schema').Ma2EffectLibrary> {
    const { bridge } = this.get(target);
    if (!this.connection) throw new Error('请先连接控台');
    return readMa2NativeLibrary(this.connection, bridge, this.isPlaying, onProgress, phase, signal);
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
    catch { this.error = 'MA2 安全凭证读取失败，请重新保存密码'; return; }
    if (this.settings.autoConnect) await this.connect();
  }
  status(): Ma2NetworkStatus { return { profiles: this.profiles, capabilities: this.capabilities, settings: this.settings, passwordSaved: this.passwordSaved, state: this.connection?.state === 'connected' && !this.services ? 'connecting' : this.connection?.state ?? 'disconnected', version: this.version, error: this.error }; }
  async save(payload: Ma2NetworkSave): Promise<Ma2NetworkStatus> {
    if (this.isPlaying()) throw new Error('播放期间不能更换控台连接');
    if (this.busy) throw new Error('MA2 正在连接，请稍后保存');
    const { settings, password } = ma2NetworkSaveSchema.parse(payload);
    this.busy = true;
    try {
      const id = this.credentialId(settings);
      if (password !== undefined) await this.secrets.saveCredential(id, password);
      const profiles = this.profiles.filter((profile) => this.credentialId(profile) !== id || profile.monitorPort !== settings.monitorPort);
      profiles.push(settings);
      if (profiles.length > 128) throw new Error('最多保存 128 个控台连接');
      await writeFileAtomically(this.path, JSON.stringify({ format: 1, active: settings, profiles }));
      this.profiles = profiles;
      this.disconnect(); this.settings = settings; this.error = null;
      this.passwordSaved = await this.secrets.hasCredential(id);
      return this.status();
    } finally { this.busy = false; }
  }
  async connect(): Promise<Ma2NetworkStatus> {
    if (this.isPlaying()) throw new Error('播放期间不能更换控台连接');
    if (this.busy) throw new Error('MA2 正在连接');
    if (!this.settings) throw new Error('请先保存控台 IP 与登录用户');
    this.disconnect(); this.error = null; this.busy = true;
    const generation = this.generation;
    try {
      const settings = this.settings;
      const password = this.passwordSaved ? await this.secrets.loadCredential(this.credentialId(settings)) : '';
      if (generation !== this.generation) return this.status();
      const connection = new Ma2Telnet(settings, (state) => {
        if (state === 'disconnected' && this.connection === connection) { this.version = null; this.capabilities = null; this.error = 'MA2 已断开，请重新连接'; }
      });
      this.connection = connection;
      const version = await connection.connect(settings.username, password);
      if (generation !== this.generation) return this.status();
      this.version = version;
      if (this.bundledBridge) await ensureMa2NetworkBridge(connection, this.bundledBridge);
      if (generation !== this.generation) return this.status();
      const bridge = new Ma2OnpcBridge(new Ma2NetworkWire(connection), this.isPlaying);
      this.services = { bridge, service: new Ma2ApplyService(bridge, this.isPlaying) };
    } catch (error) { if (generation === this.generation) { this.connection?.disconnect(); this.services = null; this.error = error instanceof Error ? error.message : String(error); this.version = null; } }
    finally { this.busy = false; }
    return this.status();
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
      if (parts.length !== 4 || !parts.slice(1).every((part) => part === 'true' || part === 'false')) throw new Error('控台能力响应格式不支持');
      if (generation !== this.generation) return this.status();
      const plugin = parts[1] === 'true', objects = parts[2] === 'true', files = parts[3] === 'true';
      this.capabilities = { version: this.version, lua: parts[0]!, plugin, objects, files,
        message: plugin && objects && files ? '基础接口可用；请读取目标 Timecode 检查 XML，写入后仍需回读确认。' : !plugin ? '未检测到网络桥插件，请导出并在控台运行插件后重新检测。' : '此版本缺少所需对象或文件接口，自动工程同步不可用。' };
    } finally { this.busy = false; }
    return this.status();
  }
  disconnect(): Ma2NetworkStatus {
    this.generation += 1;
    const connection = this.connection; this.connection = null;
    connection?.disconnect(); this.version = null; this.services = null; this.capabilities = null;
    return this.status();
  }
}
