import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import { type BeautyRuntimeState } from '@tb/schema';
import type { ObsBeauty } from './obs-beauty';
import { installBeautyPlugin } from './beauty-plugin-install';
import { beautyPipeAccessDeniedMessage } from './obs-bridge-access';

const packetSchema = z.union([
  z.object({ started: z.literal(true) }).strict(),
  z.object({ ready: z.literal(true), faces: z.number().int().min(0).max(6), bodies: z.number().int().min(0).max(6) }).strict(),
  z.object({ frames: z.number().int().nonnegative(), report: z.string().min(1) }).strict(),
  z.object({ faces: z.number().int().min(0).max(6), profiles: z.number().int().min(0).max(6), sequence: z.number().int().nonnegative(), accepted: z.number().int().nonnegative(), age_ms: z.number().nonnegative(),
    face_status: z.number().int().min(0).max(4), accepted_age_ms: z.number().nonnegative().nullable(), body_accepted_age_ms: z.number().nonnegative().nullable(),
    bodies: z.number().int().min(0).max(6), body_accepted: z.number().int().nonnegative(), body_age_ms: z.number().nonnegative(), body_status: z.number().int().min(0).max(4) }).strict().refine(packet => packet.faces + packet.profiles <= 6, '面部总数超出限制')
]);
const trackingMessage = (faces: number, profiles: number, bodies: number): string => `面部精修 ${faces} 人${profiles ? ` · 仅磨皮/美白 ${profiles} 人` : ''} · 美体 ${bodies} 人`;
const initial = (): BeautyRuntimeState => ({ phase: 'idle', sourceName: null, filterName: null, faces: 0, message: '尚未启动美颜' });

export class BeautyRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private exit: Promise<void> | null = null;
  private state = initial();
  private busy = false;
  private updated = 0;
  private accepted: { faceUntil: number; bodyUntil: number; faces: number; profiles: number; bodies: number } | null = null;
  private stopping = false;
  private readonly listeners = new Set<(state: BeautyRuntimeState) => void>();
  constructor(private readonly root: string, private readonly reports: string, private readonly beauty: ObsBeauty,
    private readonly log: (message: string) => void) {}

  subscribe(listener: (state: BeautyRuntimeState) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  status(): BeautyRuntimeState {
    if (this.state.phase === 'tracking' && this.accepted) {
      const now = performance.now();
      const faces = now <= this.accepted.faceUntil ? this.accepted.faces : 0;
      const profiles = now <= this.accepted.faceUntil ? this.accepted.profiles : 0;
      const bodies = now <= this.accepted.bodyUntil ? this.accepted.bodies : 0;
      return faces || profiles || bodies
        ? { ...this.state, faces, message: trackingMessage(faces, profiles, bodies) }
        : { ...this.state, phase: 'waiting', faces: 0, message: '已确认结果超过时效，正在等待新的 OBS 接收确认' };
    }
    if ((this.state.phase === 'tracking' || this.state.phase === 'waiting') && Date.now() - this.updated > 1500) {
      return { ...this.state, phase: 'waiting', faces: 0, message: '未收到新画面，请确认来源可见；过期美颜已失效' };
    }
    return this.state;
  }
  private publish(next: BeautyRuntimeState): void {
    if (next.phase !== 'tracking') this.accepted = null;
    this.state = next; this.updated = Date.now();
    for (const listener of this.listeners) listener(next);
    if (next.phase === 'error') this.log(next.message);
  }
  async install(): Promise<string> {
    if (!process.env.ProgramData) throw new Error('Windows ProgramData 路径不可用');
    if (this.busy || this.child) throw new Error('请先停止美颜，再安装组件');
    this.busy = true;
    try { return await installBeautyPlugin(this.root, process.env.ProgramData); }
    catch (error) { this.log(`美颜组件安装失败：${String(error)}`); throw error; }
    finally { this.busy = false; }
  }

  async start(sourceName: string): Promise<BeautyRuntimeState> {
    if (this.busy) throw new Error('美颜正在启动或停止');
    this.busy = true;
    try {
      if (this.child) throw new Error('请先停止当前美颜，再切换来源');
      const executable = join(this.root, 'runtime/tblink-beauty-worker/tblink-beauty-worker.exe');
      const model = join(this.root, 'face_landmarker.task');
      const bodyModel = join(this.root, 'pose_landmarker_lite.task');
      const proposalModel = join(this.root, 'face_detection_yunet_2023mar.onnx');
      const semanticModel = join(this.root, 'selfie_skin_probability.onnx');
      const instanceDirectory = join(this.root, 'rtmdet-ins-tiny');
      await access(executable); await access(model); await access(bodyModel); await access(proposalModel); await access(semanticModel);
      await access(join(instanceDirectory, 'raw-heads.onnx')); await mkdir(this.reports, { recursive: true });
      this.publish({ phase: 'starting', sourceName, filterName: null, faces: 0, message: '正在准备来源与分析引擎' });
      const target = await this.beauty.prepare(sourceName);
      const child = spawn(executable, ['--channel', target.channel, '--model', model, '--body-model', bodyModel, '--body-on-demand',
        '--proposal-model', proposalModel, '--proposal-backend', 'directml', '--semantic-model', semanticModel,
        '--semantic-backend', 'directml', '--semantic-probability', '--instance-rtmdet-dir', instanceDirectory,
        '--profile-skin', '--managed', '--report', join(this.reports, `${randomUUID()}.json`)], { windowsHide: true, stdio: 'pipe' });
      this.child = child; this.stopping = false;
      let stderr = '', pending = '', failed = false, started = false;
      const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
      const fail = (message: string): void => {
        clearTimeout(startup);
        failed = true;
        this.publish({ ...this.state, phase: 'error', faces: 0, message });
        child.stdin.end();
      };
      const startup = setTimeout(() => fail('分析引擎启动超时，请检查运行日志后手动启动'), 15000);
      child.stdin.on('error', error => { if (!this.stopping && !failed) fail(`分析引擎控制通道异常：${error.message}`); });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + stderrDecoder.write(chunk)).slice(-8000); });
      child.stdout.on('data', (chunk: Buffer) => {
        if (failed || this.stopping) return;
        pending += stdoutDecoder.write(chunk);
        if (pending.length > 64_000) { fail('分析引擎返回的数据过长'); return; }
        const lines = pending.split('\n'); pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const packet = packetSchema.parse(JSON.parse(line));
            if ('started' in packet) {
              if (started) throw new Error('重复的启动确认');
              started = true; clearTimeout(startup); this.publish({ phase: 'waiting', sourceName, filterName: target.filterName, faces: 0, message: '引擎已启动，等待画面中的人像' });
            }
            else if (!started) throw new Error('尚未确认启动便收到分析结果');
            else if ('ready' in packet) { /* Detection alone is not proof that OBS accepted it. */ }
            else if ('frames' in packet) { throw new Error('分析引擎在未请求停止时结束会话'); }
            else {
              const frameFresh = packet.sequence > 0 && packet.age_ms <= 1500;
              const faceAccepted = frameFresh && packet.face_status === 1 && packet.accepted > 0 && packet.sequence >= packet.accepted && packet.sequence - packet.accepted < 32 && packet.accepted_age_ms !== null && packet.accepted_age_ms <= 250;
              const faces = faceAccepted ? packet.faces : 0;
              const profiles = faceAccepted ? packet.profiles : 0;
              const bodyReady = frameFresh && packet.bodies > 0 && packet.body_status === 1 && packet.body_accepted > 0 && packet.sequence >= packet.body_accepted && packet.sequence - packet.body_accepted < 32 && packet.body_accepted_age_ms !== null && packet.body_accepted_age_ms <= 250;
              const active = faces > 0 || profiles > 0 || bodyReady;
              const observed = performance.now();
              this.accepted = { faceUntil: faceAccepted && packet.accepted_age_ms !== null ? observed + 250 - packet.accepted_age_ms : 0,
                bodyUntil: bodyReady && packet.body_accepted_age_ms !== null ? observed + 250 - packet.body_accepted_age_ms : 0,
                faces, profiles, bodies: bodyReady ? packet.bodies : 0 };
              const message = !frameFresh ? 'OBS 美颜分析画面已停更，请检查当前场景和美颜滤镜；过期结果不参与输出'
                : active ? trackingMessage(faces, profiles, bodyReady ? packet.bodies : 0) : '等待清晰可见的人脸或身体；无有效结果的部位保持原画面';
              if (!frameFresh && this.state.message !== message) this.log(`${sourceName}：${message}（画面年龄 ${Math.round(packet.age_ms)}ms）`);
              this.publish({ phase: active ? 'tracking' : 'waiting', sourceName, filterName: target.filterName, faces, message });
            }
          } catch (error) { fail(`分析引擎响应无效：${String(error)}`); break; }
        }
      });
      this.exit = new Promise(resolve => {
        child.once('error', error => { clearTimeout(startup); failed = true; this.publish({ ...this.state, phase: 'error', message: `美颜引擎启动失败：${error.message}` }); this.child = null; resolve(); });
        child.once('exit', code => {
          clearTimeout(startup);
          if (this.stopping) this.publish(initial());
          // The worker opens OBS's beauty channel with Windows APIs; error 5 there is ERROR_ACCESS_DENIED.
          else if (!failed) this.publish({ ...this.state, phase: 'error', faces: 0, message: stderr.includes('[WinError 5]')
            ? `美颜引擎已退出（${code}）：${beautyPipeAccessDeniedMessage}` : `美颜引擎已退出（${code}）：${stderr.slice(-1500)}` });
          this.child = null; resolve();
        });
      });
      return this.state;
    } catch (error) {
      this.publish({ phase: 'error', sourceName, filterName: null, faces: 0, message: String(error) }); throw error;
    } finally { this.busy = false; }
  }

  async stop(): Promise<void> {
    if (this.busy) throw new Error('美颜正在启动或停止');
    if (!this.child) { this.publish(initial()); return; }
    this.busy = true; this.stopping = true; this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exit, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('美颜引擎未正常退出，保留进程；未强杀')), 8000); })]);
      this.publish(initial());
    } catch (error) { this.publish({ ...this.state, phase: 'error', message: String(error) }); throw error; }
    finally { clearTimeout(timer); this.busy = false; }
  }
  close(): void { this.stopping = true; this.child?.stdin.end(); }
}
