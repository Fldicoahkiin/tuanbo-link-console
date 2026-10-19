import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ma2LiveConnectSchema, ma2LiveInputSchema, ma2LiveRequestSchema, type Ma2LiveConnect, type Ma2LiveInput, type Ma2LiveRequest, type Ma2LiveSnapshot } from '@tb/schema';
import type { SecureProfileStore } from './secure-profile-store';
import type { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { writeFileAtomically } from './atomic-file';
import { listMa2ExecutorPages } from './ma2-executor-page';
import { Ma2LivePlayback } from './ma2-live-playback';

const profilesSchema = z.array(z.object({ host: z.ipv4(), username: z.string().min(1).max(256) }).strict()).max(128);
export class Ma2LiveService {
  private client: Ma2LivePlayback | null = null;
  private scope = '';
  private verifiedAt = 0;
  private snapshot: Ma2LiveSnapshot | null = null;
  private failed = false;
  private generation = 0;
  private pressed = new Map<string, { page: number; slot: number; id: number }>();
  private guard: ReturnType<typeof setTimeout> | null = null;
  private opening: Promise<Ma2LiveSnapshot> | null = null;
  constructor(private readonly path: string, private readonly secrets: Pick<SecureProfileStore, 'saveCredential' | 'loadCredential'>, private readonly bridge: (request: Ma2LiveRequest) => Pick<Ma2OnpcBridge, 'request'>) {}
  private key(request: Ma2LiveRequest): string { return JSON.stringify([request.network, request.expectedSource]); }
  private secret(host: string, username: string): string { return `ma2-web-${createHash('sha256').update(`${host}:${username}`).digest('hex')}`; }
  private async profiles() {
    try { return profilesSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  }
  close(): void {
    this.generation += 1;
    this.release(); this.client?.close(); this.client = null; this.snapshot = null; this.scope = ''; this.failed = false;
  }
  release(): void {
    if (this.guard) clearTimeout(this.guard); this.guard = null;
    for (const button of this.pressed.values()) {
      if (this.client?.connected) this.client.input(button.page, button.slot, { kind: 'button', id: button.id, pressed: false });
    }
    this.pressed.clear();
  }
  async connect(input: Ma2LiveConnect): Promise<Ma2LiveSnapshot> {
    if (this.opening) {
      await this.opening;
      return this.read({ network: input.network, expectedSource: input.expectedSource, page: input.page, start: input.start });
    }
    const opening = this.connectSession(input); this.opening = opening;
    try { return await opening; }
    finally { if (this.opening === opening) this.opening = null; }
  }
  private async connectSession(input: Ma2LiveConnect): Promise<Ma2LiveSnapshot> {
    const request = ma2LiveConnectSchema.parse(input); this.close();
    const generation = this.generation;
    await listMa2ExecutorPages(this.bridge(request), { network: request.network, expectedSource: request.expectedSource });
    if (generation !== this.generation) throw new Error('控台连接已改变');
    const client = new Ma2LivePlayback(request.network.host); this.client = client;
    try {
      await client.connect(request.username, request.password);
      if (generation !== this.generation) throw new Error('控台连接已改变');
      const profiles = await this.profiles();
      await this.secrets.saveCredential(this.secret(request.network.host, request.username), request.password);
      await writeFileAtomically(this.path, JSON.stringify([...profiles.filter(profile => profile.host !== request.network.host), { host: request.network.host, username: request.username }], null, 2));
      if (generation !== this.generation) throw new Error('控台连接已改变');
      this.scope = this.key(request); this.verifiedAt = Date.now(); this.failed = false;
      return await this.read(ma2LiveRequestSchema.parse({ network: request.network, expectedSource: request.expectedSource, page: request.page, start: request.start }));
    } catch (error) { client.close(); if (generation === this.generation && this.client === client) this.failed = true; throw error; }
  }
  async read(input: Ma2LiveRequest): Promise<Ma2LiveSnapshot> {
    const request = ma2LiveRequestSchema.parse(input); this.bridge(request);
    if (this.failed) throw new Error('实时推杆已停止，请重新连接');
    if (!this.client) {
      const generation = this.generation;
      const profile = (await this.profiles()).find(value => value.host === request.network.host);
      if (!profile) throw new Error('连接实时推杆后，可显示控台当前值');
      const password = await this.secrets.loadCredential(this.secret(profile.host, profile.username));
      if (generation !== this.generation) throw new Error('控台连接已改变');
      return this.connect({ ...request, username: profile.username, password });
    }
    if (this.scope !== this.key(request)) { this.close(); throw new Error('控台 Show 或连接已改变，请重新读取页面'); }
    const generation = this.generation;
    const client = this.client;
    try {
      if (Date.now() - this.verifiedAt > 1000) { await listMa2ExecutorPages(this.bridge(request), { network: request.network, expectedSource: request.expectedSource }); this.verifiedAt = Date.now(); }
      if (generation !== this.generation) throw new Error('控台连接已改变');
      const snapshot = await client.read(request.page, request.start);
      if (generation !== this.generation) throw new Error('控台连接已改变');
      this.snapshot = snapshot;
      if (this.pressed.size) this.armRelease();
      return snapshot;
    } catch (error) { if (generation === this.generation && this.client === client) { this.release(); client.close(); this.failed = true; } throw error; }
  }
  private armRelease(): void {
    if (this.guard) clearTimeout(this.guard);
    this.guard = setTimeout(() => { this.release(); this.failed = true; this.client?.close(); }, 1500);
  }
  input(input: Ma2LiveInput): void {
    const request = ma2LiveInputSchema.parse(input); this.bridge(request);
    const release = request.action.kind === 'button' && !request.action.pressed;
    const key = request.action.kind === 'button' ? `${request.page}:${request.slot}:${request.action.id}` : '';
    if (release) {
      if (this.pressed.has(key)) { this.client?.input(request.page, request.slot, request.action); this.pressed.delete(key); }
      return;
    }
    if (Date.now() > request.deadlineAt || this.failed || this.scope !== this.key(request) || !this.client?.connected) throw new Error('推杆操作已过期或连接改变，未发送');
    const snapshot = this.snapshot;
    if (!snapshot || snapshot.page !== request.page || snapshot.start !== request.start || Date.now() - snapshot.readAt > 1000 || Date.now() - this.verifiedAt > 2000) throw new Error('实时状态已过期，请重新读取后操作');
    const block = snapshot.items.flatMap(item => item.blocks).find(value => value.slot === request.slot);
    const action = request.action;
    if (!block || action.kind === 'fader' && !block.fader || action.kind === 'button' && !block.buttons.some(button => button.id === action.id && button.name !== 'Empty')) throw new Error('此位置没有可操作的推杆或按键');
    if (action.kind === 'fader' && block.fader && (action.value < block.fader.min || action.value > block.fader.max)) throw new Error('推杆数值超出控台允许的范围，未发送');
    this.client.input(request.page, request.slot, request.action);
    if (request.action.kind === 'button' && request.action.pressed) { this.pressed.set(key, { page: request.page, slot: request.slot, id: request.action.id }); this.armRelease(); }
  }
}
