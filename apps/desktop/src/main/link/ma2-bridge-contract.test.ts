import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, expect, it, vi } from 'vitest';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { createMa2TimecodeXml } from './ma2-create';
import { emptyMa2SequenceXml } from './ma2-timecode-xml';

const wire = vi.hoisted(() => ({ id: '', response: '', backup: null as string | null }));
vi.mock('node:fs/promises', () => ({
  stat: vi.fn(() => Promise.resolve({ isDirectory: () => true })),
  writeFile: vi.fn((_path: string, content: string) => { wire.id = content.split('\n')[0] ?? ''; return Promise.resolve(); }),
  rename: vi.fn(() => Promise.resolve()),
  readFile: vi.fn((path: string) => {
    if (path.includes('tblink_backup_')) return wire.backup === null ? Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })) : Promise.resolve(wire.backup);
    return Promise.resolve(`${wire.id}\nOK\n${Buffer.byteLength(wire.response)}\n${wire.response}`);
  })
}));
const source = readFileSync(fileURLToPath(new URL('./fixtures/ma2-timecode-3.7.xml', import.meta.url)), 'utf8');
beforeEach(() => { wire.id = ''; wire.response = source; wire.backup = null; });
it('执行器读取使用明确页号与编号，不要求已有 Timecode，也不允许命令文本', async () => {
  const executor = readFileSync(fileURLToPath(new URL('./fixtures/ma2-executor-3.3.xml', import.meta.url)), 'utf8');
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  wire.response = executor;
  await expect(bridge.request('EXECUTOR', 99, '219')).resolves.toBe(executor);
  await expect(bridge.request('EXECUTOR', 99, '219; Go')).rejects.toThrow('编号无效');
  await expect(bridge.request('EXECUTOR', 99, '0')).rejects.toThrow('编号无效');
  wire.response = readFileSync(fileURLToPath(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url)), 'utf8');
  await expect(bridge.request('EXECUTOR', 99, '219')).rejects.toThrow('单个明确执行器');
});
it('写入未确认时仅返回已读取且目标正确的备份，缺失或损坏不伪报', async () => {
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  const desired = source.replace('</Timecode>', '<FutureData value="keep" /></Timecode>');
  wire.backup = source;
  await expect(bridge.request('APPLY', 904, source, desired)).rejects.toMatchObject({ sent: true, backupFile: expect.stringMatching(/^tblink_backup_[a-f0-9]{32}\.xml$/) as unknown });
  wire.backup = null;
  await expect(bridge.request('APPLY', 904, source, desired)).rejects.toMatchObject({ backupFile: null });
  wire.backup = source.replace('index="903"', 'index="904"');
  await expect(bridge.request('APPLY', 904, source, desired)).rejects.toMatchObject({ backupFile: null, message: expect.stringContaining('备份检查失败') as unknown });
  wire.backup = 'broken';
  await expect(bridge.request('APPLY', 904, source, desired)).rejects.toMatchObject({ backupFile: null, message: expect.stringContaining('备份检查失败') as unknown });
});
it('创建只发送空 Timecode，播放期间阻止，回读不同不算成功', async () => {
  const desired = createMa2TimecodeXml(9903, 'TBLINK_CREATE', '3.3.4.3');
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  wire.response = desired;
  await expect(bridge.request('CREATE', 9903, '', desired)).resolves.toBe(desired);
  await expect(bridge.request('CREATE', 9903, desired, desired)).rejects.toThrow('旧对象');
  await expect(new Ma2OnpcBridge(process.cwd(), () => true).request('CREATE', 9903, '', desired)).rejects.toThrow('播放期间');
  await expect(bridge.request('CREATE', 904, '', source)).rejects.toThrow('必须为空');
  wire.response = desired.replace('TBLINK_CREATE', 'unexpected');
  await expect(bridge.request('CREATE', 9903, '', desired)).rejects.toThrow('同步没有完成');
});

it('回读必须属于请求的唯一 Timecode，响应正常不代表目标正确', async () => {
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  await expect(bridge.request('READ', 904)).resolves.toBe(source);
  await expect(bridge.request('READ', 905)).rejects.toThrow('和绑定的 Timecode 对不上');
});
it('写入后的扩展数据丢失必须报告未完成同步', async () => {
  const desired = source.replace('</Timecode>', '<FutureData value="keep" /></Timecode>');
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  await expect(bridge.request('APPLY', 904, source, desired)).rejects.toThrow('同步没有完成');
  wire.response = desired;
  await expect(bridge.request('APPLY', 904, source, desired)).resolves.toBe(desired);
});
it('同时读取依次交换，避免覆盖插件请求文件', async () => {
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  const first = bridge.request('READ', 904);
  await expect(Promise.all([first, bridge.request('READ', 904)])).resolves.toEqual([source, source]);
});
it('快照只接受 Timecode 引用的序列，且不能作为写入 XML 使用', async () => {
  const tc = readFileSync(fileURLToPath(new URL('./fixtures/ma2-timecode-fractional-3.3.xml', import.meta.url)), 'utf8');
  const seq = readFileSync(fileURLToPath(new URL('./fixtures/ma2-sequence-fractional-3.3.xml', import.meta.url)), 'utf8');
  const object = seq.match(/<Sequ\s[\s\S]*?<\/Sequ>/)?.[0];
  if (!object) throw new Error('测试序列不存在');
  wire.response = tc.replace('</MA>', `${object}</MA>`);
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  await expect(bridge.request('SNAPSHOT', 9902)).resolves.toBe(wire.response);
  await expect(bridge.request('APPLY', 9902, wire.response, wire.response)).rejects.toThrow('Timecode 以外');
  wire.response = tc;
  await expect(bridge.request('SNAPSHOT', 9902)).rejects.toThrow('关联序列缺失');
  wire.response = tc.replace('</MA>', `${object.replace('index="9900"', 'index="9990"')}</MA>`);
  await expect(bridge.request('SNAPSHOT', 9902)).rejects.toThrow('关联序列缺失');
});
it('来源序列 Cue 读取接受数百个编号，拒绝非编号文本', async () => {
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  wire.response = emptyMa2SequenceXml(9000, '3.7.0.5');
  await expect(bridge.request('SEQCUES', 9000, Array.from({ length: 600 }, (_, index) => `${index + 1}.000`).join(','))).resolves.toBe(wire.response);
  await expect(bridge.request('SEQCUES', 9000, '1.000;Delete Sequence 1')).rejects.toThrow('范围无效');
});
it('清理旧备份只接受本软件的写前备份文件名，回执只能是请求里的名字', async () => {
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  const backup = `tblink_library_${'a'.repeat(32)}`;
  wire.response = backup;
  await expect(bridge.request('DISCARD', 1, `${backup},tblink_backup_${'b'.repeat(32)}`)).resolves.toBe(backup);
  for (const list of ['tblink_layout_' + 'a'.repeat(32), '../show', `${backup};os.remove`, `tblink_watch_${'a'.repeat(16)}`]) await expect(bridge.request('DISCARD', 1, list)).rejects.toThrow('清理列表无效');
  wire.response = `tblink_label_${'c'.repeat(32)}`;
  await expect(bridge.request('DISCARD', 1, backup)).rejects.toThrow('回执与请求不一致');
});
it('读取时间码节目范围：只接受空请求，回执按 schema 校验', async () => {
  const bridge = new Ma2OnpcBridge(process.cwd(), () => false);
  wire.response = JSON.stringify({ show: 'Show', entries: [{ target: 9906, name: 'TcProbe', offset: '0', length: '6000', slot: 'TC Slot 1', frame: '30 FPS', last: '5940' }] });
  await expect(bridge.request('TCRANGES', 1)).resolves.toBe(wire.response);
  await expect(bridge.request('TCRANGES', 2)).rejects.toThrow('请求格式无效');
  await expect(bridge.request('TCRANGES', 1, 'x')).rejects.toThrow('请求格式无效');
  wire.response = JSON.stringify({ show: 'Show', entries: [{ target: 0 }] });
  await expect(bridge.request('TCRANGES', 1)).rejects.toThrow();
});
