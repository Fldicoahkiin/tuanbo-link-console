import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { OBSWebSocket } from 'obs-websocket-js';
import { BeautyRuntime } from './beauty-runtime';
import { ObsBeauty } from './obs-beauty';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({ access: vi.fn().mockResolvedValue(undefined), mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(), rename: vi.fn(), writeFile: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function setup(): { runtime: BeautyRuntime; child: EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: PassThrough }; log: ReturnType<typeof vi.fn> } {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough() });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  const beauty = new ObsBeauty(new OBSWebSocket(), operation => operation(), operation => operation());
  vi.spyOn(beauty, 'prepare').mockResolvedValue({ sourceName: '机位', filterName: '团播·人像美颜', channel: 'Local\\tblink-beauty-1-1' });
  const log = vi.fn();
  return { runtime: new BeautyRuntime('C:/test/beauty', 'C:/test/reports', beauty, log), child, log };
}

it('受管引擎通过 stdin 正常退出，追踪状态依赖 OBS 接收与结果时效', async () => {
  vi.useFakeTimers();
  const { runtime, child } = setup();
  await runtime.start('机位');
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--proposal-model');
  const argumentsList = vi.mocked(spawn).mock.calls[0]?.[1];
  expect(argumentsList?.slice(argumentsList.indexOf('--proposal-backend'), argumentsList.indexOf('--proposal-backend') + 2)).toEqual(['--proposal-backend', 'directml']);
  expect(argumentsList?.slice(argumentsList.indexOf('--semantic-backend'), argumentsList.indexOf('--semantic-backend') + 2)).toEqual(['--semantic-backend', 'directml']);
  expect(argumentsList?.[argumentsList.indexOf('--semantic-model') + 1]).toMatch(/selfie_skin_probability\.onnx$/);
  expect(argumentsList).toContain('--semantic-probability');
  expect(argumentsList?.[argumentsList.indexOf('--instance-rtmdet-dir') + 1]).toMatch(/rtmdet-ins-tiny$/);
  expect(argumentsList).toContain('--profile-skin');
  expect(argumentsList).toContain('--body-on-demand');
  expect(runtime.status().phase).toBe('starting');
  child.stdout.write('{"started":true}\n');
  child.stdout.write('{"faces":2,"profiles":0,"sequence":3,"accepted":2,"age_ms":40,"face_status":1,"accepted_age_ms":80,"body_accepted_age_ms":null,"bodies":0,"body_accepted":0,"body_age_ms":0,"body_status":0}\n');
  expect(runtime.status()).toMatchObject({ phase: 'tracking', faces: 2 });
  await vi.advanceTimersByTimeAsync(1600);
  expect(runtime.status()).toMatchObject({ phase: 'waiting', faces: 0 });
  const stopped = runtime.stop();
  expect(child.stdin.writableEnded).toBe(true);
  child.emit('exit', 0);
  await stopped;
  expect(runtime.status().phase).toBe('idle');
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('补检模型缺失时明确失败且不启动缺功能的工作器', async () => {
  const { runtime } = setup();
  vi.mocked(access).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('补检模型缺失'));
  await expect(runtime.start('机位')).rejects.toThrow('补检模型缺失');
  expect(spawn).not.toHaveBeenCalled();
  expect(runtime.status()).toMatchObject({ phase: 'error' });
});

it('启动超时后不自动重试，迟到的消息不能覆盖错误状态', async () => {
  vi.useFakeTimers();
  const { runtime, child, log } = setup();
  await runtime.start('机位');
  await vi.advanceTimersByTimeAsync(15000);
  expect(runtime.status().message).toContain('超时');
  expect(child.stdin.writableEnded).toBe(true);
  child.stdout.write('{"started":true}\n');
  expect(runtime.status().phase).toBe('error');
  child.emit('exit', 0);
  expect(runtime.status().phase).toBe('error');
  expect(log).toHaveBeenCalledTimes(1);
  expect(spawn).toHaveBeenCalledTimes(1);
});

it('语义模型缺失时停止启动，不静默切换到没有遮罩保护的引擎', async () => {
  const { runtime } = setup();
  vi.mocked(access).mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)
    .mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('语义模型缺失'));
  await expect(runtime.start('机位')).rejects.toThrow('语义模型缺失');
  expect(spawn).not.toHaveBeenCalled();
  expect(runtime.status()).toMatchObject({ phase: 'error' });
});

it('人体实例模型缺失时明确报错且不启动不完整引擎', async () => {
  const { runtime } = setup();
  for (let index = 0; index < 5; index++) vi.mocked(access).mockResolvedValueOnce(undefined);
  vi.mocked(access).mockRejectedValueOnce(new Error('人体实例模型缺失'));
  await expect(runtime.start('机位')).rejects.toThrow('人体实例模型缺失');
  expect(spawn).not.toHaveBeenCalled();
  expect(runtime.status()).toMatchObject({ phase: 'error', message: expect.stringContaining('人体实例模型缺失') });
});

it('异常进程退出保留诊断，断开连接则协作关闭并回到空闲', async () => {
  const { runtime, child } = setup();
  await runtime.start('机位');
  child.stderr.write('model failure');
  child.emit('exit', 1);
  expect(runtime.status().message).toContain('model failure');
  const next = setup();
  await next.runtime.start('机位');
  next.runtime.close();
  expect(next.child.stdin.writableEnded).toBe(true);
  next.child.emit('exit', 0);
  expect(next.runtime.status().phase).toBe('idle');
});

it('身体独立接收状态显示美体人数，过期或错误身体结果不得显示生效', async () => {
  const { runtime, child } = setup();
  await runtime.start('机位');
  expect(vi.mocked(spawn).mock.calls[0]?.[1]).toContain('--body-model');
  child.stdout.write('{"started":true}\n');
  const packet = { faces: 0, profiles: 0, sequence: 10, accepted: 10, age_ms: 30, face_status: 2, accepted_age_ms: 50, body_accepted_age_ms: 180, bodies: 6, body_accepted: 4, body_age_ms: 40, body_status: 1 };
  child.stdout.write(`${JSON.stringify(packet)}\n`);
  expect(runtime.status()).toMatchObject({ phase: 'tracking', message: '面部精修 0 人 · 美体 6 人' });
  child.stdout.write(`${JSON.stringify({ ...packet, body_status: 3 })}\n`);
  expect(runtime.status().phase).toBe('waiting');
  child.stdout.write(`${JSON.stringify({ ...packet, body_accepted_age_ms: 251 })}\n`);
  expect(runtime.status().phase).toBe('waiting');
  child.stdout.write(`${JSON.stringify({ ...packet, body_accepted: 11 })}\n`);
  expect(runtime.status().phase).toBe('waiting');
  runtime.close(); child.emit('exit', 0);
});

it('人脸显示依据原生状态和已接受结果年龄，不依赖旧帧率的固定帧差', async () => {
  const { runtime, child } = setup();
  await runtime.start('机位'); child.stdout.write('{"started":true}\n');
  const packet = { faces: 2, profiles: 0, sequence: 20, accepted: 14, age_ms: 40, face_status: 1, accepted_age_ms: 210,
    bodies: 0, body_accepted: 0, body_age_ms: 0, body_status: 0, body_accepted_age_ms: null };
  child.stdout.write(`${JSON.stringify(packet)}\n`);
  expect(runtime.status()).toMatchObject({ phase: 'tracking', faces: 2 });
  for (const invalid of [{ face_status: 3 }, { accepted_age_ms: 251 }, { accepted_age_ms: null }, { accepted: 21 }, { sequence: 46 }]) {
    child.stdout.write(`${JSON.stringify({ ...packet, ...invalid })}\n`);
    expect(runtime.status()).toMatchObject({ phase: 'waiting', faces: 0 });
  }
  runtime.close(); child.emit('exit', 0);
});

it.each([
  '{"unknown":true}',
  '{"faces":99,"sequence":4,"accepted":3,"age_ms":20,"bodies":0,"body_accepted":0,"body_age_ms":0,"body_status":0}',
  '{"started":true}',
  '{"frames":12,"report":"unexpected.json"}',
  '{broken'
])('无效或意外协议 %s 明确失败，迟到状态不能恢复绿色', async message => {
  const { runtime, child, log } = setup();
  await runtime.start('机位'); child.stdout.write('{"started":true}\n');
  child.stdout.write(`${message}\n`);
  expect(runtime.status()).toMatchObject({ phase: 'error', faces: 0 });
  expect(runtime.status().message).toContain('分析引擎响应无效');
  expect(child.stdin.writableEnded).toBe(true);
  child.stdout.write('{"started":true}\n');
  expect(runtime.status().phase).toBe('error'); expect(log).toHaveBeenCalledTimes(1);
  child.emit('exit', 0);
});

it('检测到人像通知不会冒充 OBS 接收确认，允许分块协议', async () => {
  const { runtime, child } = setup();
  await runtime.start('机位');
  child.stdout.write('{"star'); child.stdout.write('ted":true}\n');
  child.stdout.write('{"ready":true,"faces":6,"bodies":6}\n');
  expect(runtime.status()).toMatchObject({ phase: 'waiting', faces: 0 });
  runtime.close(); child.emit('exit', 0);
});

it('未启动确认便收到状态拒绝生效，诊断保留跨块中文', async () => {
  const { runtime, child } = setup();
  await runtime.start('机位');
  child.stdout.write('{"ready":true,"faces":2,"bodies":0}\n');
  expect(runtime.status()).toMatchObject({ phase: 'error', faces: 0 });
  child.emit('exit', 1);
  const next = setup(); await next.runtime.start('机位');
  const bytes = Buffer.from('模型加载失败');
  next.child.stderr.write(bytes.subarray(0, 2)); next.child.stderr.write(bytes.subarray(2));
  next.child.emit('exit', 1);
  expect(next.runtime.status().message).toContain('模型加载失败');
});


it('基础美肤独立计数，不冒充五官精修，过期或未确认结果不显示生效', async () => {
  const { runtime, child } = setup();
  await runtime.start('机位'); child.stdout.write('{"started":true}\n');
  const packet = { faces: 0, profiles: 2, sequence: 20, accepted: 19, age_ms: 30, face_status: 1, accepted_age_ms: 180,
    bodies: 0, body_accepted: 0, body_age_ms: 0, body_status: 0, body_accepted_age_ms: null };
  child.stdout.write(`${JSON.stringify(packet)}\n`);
  expect(runtime.status()).toMatchObject({ phase: 'tracking', faces: 0, message: '面部精修 0 人 · 仅磨皮/美白 2 人 · 美体 0 人' });
  for (const invalid of [{ accepted_age_ms: 251 }, { accepted_age_ms: null }, { face_status: 3 }, { accepted: 21 }, { sequence: 51 }]) {
    child.stdout.write(`${JSON.stringify({ ...packet, ...invalid })}\n`);
    expect(runtime.status()).toMatchObject({ phase: 'waiting', faces: 0 });
    expect(runtime.status().message).not.toContain('仅磨皮/美白');
  }
  child.stdout.write(`${JSON.stringify({ ...packet, faces: 2, profiles: 1 })}\n`);
  expect(runtime.status()).toMatchObject({ phase: 'tracking', faces: 2, message: '面部精修 2 人 · 仅磨皮/美白 1 人 · 美体 0 人' });
  child.stdout.write(`${JSON.stringify({ ...packet, faces: 6, profiles: 1 })}\n`);
  expect(runtime.status().phase).toBe('error');
  child.emit('exit', 0);
});


it('两次心跳之间按已接受结果剩余寿命分别撤销面部和身体状态', async () => {
  vi.useFakeTimers();
  const { runtime, child } = setup();
  await runtime.start('机位'); child.stdout.write('{"started":true}\n');
  const packet = { faces: 1, profiles: 1, sequence: 20, accepted: 19, age_ms: 30, face_status: 1, accepted_age_ms: 210,
    bodies: 2, body_accepted: 19, body_age_ms: 30, body_status: 1, body_accepted_age_ms: 100 };
  child.stdout.write(`${JSON.stringify(packet)}\n`);
  expect(runtime.status().message).toBe('面部精修 1 人 · 仅磨皮/美白 1 人 · 美体 2 人');
  vi.setSystemTime(Date.now() - 60000);
  await vi.advanceTimersByTimeAsync(41);
  expect(runtime.status()).toMatchObject({ phase: 'tracking', faces: 0, message: '面部精修 0 人 · 美体 2 人' });
  await vi.advanceTimersByTimeAsync(110);
  expect(runtime.status().phase).toBe('waiting');
  child.stdout.write(`${JSON.stringify(packet)}\n`);
  expect(runtime.status()).toMatchObject({ phase: 'tracking', faces: 1 });
  runtime.close(); child.emit('exit', 0);
});
