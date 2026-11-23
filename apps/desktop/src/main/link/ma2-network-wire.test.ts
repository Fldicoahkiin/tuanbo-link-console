import { expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ma2NetworkWire } from './ma2-network-wire';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';
import { Ma2CommandQueue } from './ma2-command-queue';
import { showStopped } from './fixtures/show-gates';
import { Ma2RequestJournal } from './ma2-request-journal';
import { MA2_BRIDGE_BUSY_BEFORE_REQUEST, MA2_BRIDGE_MISSING_BEFORE_REQUEST } from '@tb/core/link';

const id = '1234567890abcdef1234567890abcdef';
it.each([
  ['0001', 'SEQPACK:20:2', '序列片段'],
  ['00000004ff', 'SEQPACK:20:5', '不完整'],
  ['00000001780001', 'SEQPACK:20:7', '传输不完整'],
  ['ff', 'SEQDATA:1', '文字编码']
])('大序列的数据损坏时释放本次读取，下一次仍可读取（%s）', async (bytes, receipt, reason) => {
  const command = vi.fn()
    .mockResolvedValueOnce('ACK:lanes').mockResolvedValueOnce(receipt)
    .mockResolvedValueOnce(bytes).mockResolvedValueOnce('ACK');
  const wire = new Ma2NetworkWire({ command });
  await expect(wire.exchange(id, 'SEQUENCE', 99, '', () => undefined)).rejects.toThrow(reason);
  expect(command.mock.calls.at(-1)?.[0]).toContain(`'release','${id}')`);
  expect(wire.unreleasedRequests).toEqual([]);
  command.mockResolvedValueOnce('ACK:lanes').mockResolvedValueOnce('SEQDATA:2')
    .mockResolvedValueOnce('6f6b').mockResolvedValueOnce('ACK');
  await expect(wire.exchange(id, 'SEQUENCE', 99, '', () => undefined)).resolves.toBe('ok');
  expect(command.mock.calls.at(-1)?.[0]).toContain(`'release','${id}','received')`);
});

it('整首文件下载中能在两次分段之间让出通道，节目启动时取消余下读取', async () => {
  const commands = vi.fn().mockResolvedValueOnce('ACK:lanes').mockResolvedValueOnce('SEQDATA:9000')
    .mockResolvedValueOnce('00'.repeat(8192)).mockResolvedValueOnce('ACK');
  let received = 0;
  const beforeStep = (): void => { if (received) throw new Error('节目已经开始'); };
  await expect(new Ma2NetworkWire({ command: commands }).exchange(id, 'SEQUENCE', 99, '', () => undefined, undefined,
    progress => { if (progress) received = progress.completed; }, beforeStep)).rejects.toThrow('节目已经开始');
  expect(received).toBe(8192);
  expect(commands.mock.calls.filter(([line]) => String(line).includes("'readbatch'"))).toHaveLength(1);
  expect(commands.mock.calls.at(-1)?.[0]).toContain(`'release','${id}')`);
});

it('不能保存请求归属时不发送；明确拒绝的 begin 不遗留待释放记录', async () => {
  const command = vi.fn().mockResolvedValue('ACK');
  const released = vi.fn();
  const journal = { begin: () => { throw new Error('磁盘不可写'); }, released };
  await expect(new Ma2NetworkWire({ command }, false, journal).exchange(id, 'LIST', 1, '', () => undefined)).rejects.toThrow('磁盘不可写');
  expect(command).not.toHaveBeenCalled();
  command.mockResolvedValue(`ERR:${Buffer.from('Another network request is pending').toString('hex')}`);
  await expect(new Ma2NetworkWire({ command }, false, { begin: () => undefined, released }).exchange(id, 'LIST', 1, '', () => undefined)).rejects.toMatchObject({ sent: false, message: MA2_BRIDGE_BUSY_BEFORE_REQUEST });
  expect(command).toHaveBeenCalledTimes(1);
  expect(released).toHaveBeenCalledExactlyOnceWith(id);
});
it('组件明确未接收 begin 时可重新核对，未确认的写入不重发，旧请求不再占用', async () => {
  const command = vi.fn().mockResolvedValue('MISSING');
  const journal = { begin: vi.fn(), released: vi.fn() };
  const missing = vi.fn();
  const wire = new Ma2NetworkWire({ command }, false, journal, false, missing);
  await expect(wire.exchange(id, 'ASSIGNSEQ', 1, '', () => undefined)).rejects.toMatchObject({ sent: false, message: MA2_BRIDGE_MISSING_BEFORE_REQUEST });
  expect(journal.released).toHaveBeenCalledWith(id);
  expect(command).toHaveBeenCalledTimes(1);
  await wire.releaseAbandoned(id);
  expect(missing).toHaveBeenCalled();
});

it('begin 的回答丢失后重启仍能释放本次占用，不重发原操作', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'ma2-lost-ack-'));
  try {
    const path = join(folder, 'requests.json');
    const journal = new Ma2RequestJournal(path);
    const wire = new Ma2NetworkWire({ command: () => {
      expect(new Ma2RequestJournal(path).pending()).toEqual([id]);
      return Promise.reject(new Error('connection closed after begin'));
    } }, false, journal);
    await expect(wire.exchange(id, 'LIST', 1, '', () => undefined)).rejects.toThrow('connection closed');
    const restarted = new Ma2RequestJournal(path);
    expect(restarted.pending()).toEqual([id]);
    const actions: string[] = [];
    const next = new Ma2NetworkWire({ command: (line) => { actions.push(line); return Promise.resolve('ACK'); } }, false, restarted);
    await next.releaseAbandoned(id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toContain(`'release','${id}'`);
    expect(new Ma2RequestJournal(path).pending()).toEqual([]);
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('本机大请求完整写入专用文件后才执行，上传不占用逐段命令', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tblink-upload-'));
  try {
    const temp = join(folder, 'temp'); await mkdir(temp);
    const path = join(temp, `tblink_network_${id}.input.bin`);
    const body = '完整中文 Cue 数据'.repeat(1000);
    const actions: string[] = []; let sent = false;
    const response = Buffer.from(`${id}\nOK\n2\nok`);
    const server = { command: async (line: string, match: (text: string) => string | null): Promise<string> => {
      const call = /TBLINK_NET\('([a-f0-9]{32})','([a-z]+)'/.exec(line)!;
      const action = call[2]!; actions.push(action);
      let reply = 'ACK';
      if (action === 'begin') reply = `ACK:lanes:file:${Buffer.from(path).toString('hex')}`;
      if (action === 'run') {
        expect(sent).toBe(true); expect(await readFile(path, 'utf8')).toBe(body);
        reply = `DONE:${response.length}`;
      }
      if (line.startsWith('Lua "for i=')) throw new Error('Unexpected batch format');
      if (action === 'release') await rm(path);
      return match(`TBLINK_RPC_${call[1]}:${reply}\r\n`)!;
    } };
    // Stop at beforeSend: no write to the console is allowed after the show starts,
    // and release still cleans the uploaded file.
    await expect(new Ma2NetworkWire(server, true).exchange(id, 'APPLY', 9000, body, () => { sent = true; throw new Error('播放开始'); })).rejects.toThrow('播放开始');
    expect(actions).toEqual(['begin', 'release']);
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(folder, { recursive: true, force: true }); }
});
it('本机大响应直接读文件，仍校验身份、大小与位置；远程不读取本机文件', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'tblink-wire-'));
  try {
    const temp = join(folder, 'temp'); await mkdir(temp);
    const path = join(temp, `tblink_network_${id}.bin`);
    const value = '中文完整灯具数据'.repeat(1000);
    const response = `${id}\nOK\n${Buffer.byteLength(value)}\n${value}`;
    await writeFile(path, response);
    let replyPath = path; let declared = Buffer.byteLength(response);
    const actions: string[] = [];
    const server = { command: (line: string, match: (text: string) => string | null): Promise<string> => {
      const call = /TBLINK_NET\('([a-f0-9]{32})','([a-z]+)'/.exec(line)!;
      actions.push(call[2]!);
      return Promise.resolve(match(`TBLINK_RPC_${call[1]}:${call[2] === 'run' ? `FILE:${declared}:${Buffer.from(replyPath).toString('hex')}` : 'ACK'}\r\n`)!);
    } };
    await expect(new Ma2NetworkWire(server, true).exchange(id, 'SEQUENCE', 8999, '', () => undefined)).resolves.toBe(value);
    expect(actions).toEqual(['begin', 'run', 'release']);
    await expect(new Ma2NetworkWire(server).exchange(id, 'SEQUENCE', 8999, '', () => undefined)).rejects.toThrow('远程控台');
    declared += 1;
    await expect(new Ma2NetworkWire(server, true).exchange(id, 'SEQUENCE', 8999, '', () => undefined)).rejects.toThrow('长度不一致');
    declared -= 1; replyPath = join(temp, 'another.bin');
    await expect(new Ma2NetworkWire(server, true).exchange(id, 'SEQUENCE', 8999, '', () => undefined)).rejects.toThrow('位置无效');
    replyPath = path; await writeFile(path, response.replace(id, 'f'.repeat(32)));
    await expect(new Ma2NetworkWire(server, true).exchange(id, 'SEQUENCE', 8999, '', () => undefined)).rejects.toThrow('数据对不上');
    expect(actions.at(-1)).toBe('release');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
function peer(options: { value?: string; wrongId?: boolean; truncate?: boolean; failRun?: boolean; steps?: number; stepNumbers?: number[]; verifyingSteps?: number[] } = {}) {
  const actions: string[] = [];
  let step = 0;
  const received: Buffer[] = [];
  const value = options.value ?? '中文 Cue'.repeat(220);
  const response = Buffer.from(`${options.wrongId ? 'a'.repeat(32) : id}\nOK\n${Buffer.byteLength(value)}\n${value}`);
  return {
    actions, received,
    command: (line: string, match: (text: string) => string | null): Promise<string> => {
      expect(Buffer.byteLength(line)).toBeLessThanOrEqual(1024);
      if (line.startsWith('Lua "for i=')) {
        const batch = /for i=0,(\d+) do TBLINK_NET\('([a-f0-9]{28})'.*,'read','[a-f0-9]{32}',(\d+)\+i\*256/.exec(line);
        if (!batch) throw new Error('Malformed batch');
        actions.push('read-batch');
        const replies = Array.from({ length: Number(batch[1]) + 1 }, (_, i) => {
          const offset = Number(batch[3]) + i * 256;
          return `TBLINK_RPC_${batch[2]}${i.toString(16).padStart(4, '0')}:DATA:${response.subarray(offset, offset + (options.truncate ? 255 : 256)).toString('hex')}\r\n`;
        }).join('');
        const parsed = match(replies); if (parsed === null) throw new Error('Incomplete batch');
        return Promise.resolve(parsed);
      }
      const call = /TBLINK_NET\('([a-f0-9]{32})','([a-z]+)','([a-f0-9]{32})'(.*?)\)/.exec(line);
      if (!call) throw new Error('Malformed command');
      const action = call[2]!; const args = call[4]!; actions.push(action);
      let result = 'ACK';
      if (action === 'chunk') {
        const chunk = /^,(\d+),'([a-f0-9]+)'$/.exec(args);
        if (!chunk || Number(chunk[1]) !== received.length + 1) throw new Error('Invalid chunk order');
        received.push(Buffer.from(chunk[2]!, 'hex'));
      }
      if (action === 'run') { if (options.failRun) throw new Error('Disconnected after write'); result = `DONE:${response.length}`; }
      // A stepping plugin: 'run' with 'steps' does the first step, each 'step' one more.
      if ((action === 'run' && args.startsWith(",'steps'") || action === 'step') && options.steps) {
        step += 1;
        result = step < options.steps ? `STEP:${options.stepNumbers?.[step - 1] ?? step}${options.verifyingSteps?.includes(step) ? ':verify' : ''}` : `DONE:${response.length}`;
      }
      if (action === 'read') {
        const offset = Number(args.slice(1));
        result = `DATA:${response.subarray(offset, offset + (options.truncate ? 255 : 256)).toString('hex')}`;
      }
      const parsed = match(`${line}\r\nTBLINK_RPC_${call[1]}:${result}\r\n [Channel]>`);
      if (parsed === null) throw new Error('Reply matcher failed');
      return Promise.resolve(parsed);
    }
  };
}
it('网络分段交换保持 UTF-8 字节、顺序与请求身份', async () => {
  const server = peer(); const body = '中文\n\";Go Executor 1.1\n'.repeat(200);
  let writes = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, body, () => { writes += 1; })).resolves.toBe('中文 Cue'.repeat(220));
  expect(Buffer.concat(server.received).toString('utf8')).toBe(body);
  expect(server.actions.filter((action) => action === 'run')).toHaveLength(1);
  expect(server.actions.at(-1)).toBe('release'); expect(writes).toBe(1);
});
it('目标错位、片段截断以及写入后断线均失败且不重发', async () => {
  for (const options of [{ wrongId: true }, { truncate: true }, { failRun: true }]) {
    const server = peer(options);
    await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, '', () => undefined)).rejects.toMatchObject({ sent: true });
    expect(server.actions.filter((action) => action === 'run')).toHaveLength(1);
  }
});
it('上传期间开始播放时不能提交控台写入', async () => {
  const server = peer();
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, 'data', () => { throw new Error('播放已开始'); })).rejects.toMatchObject({ sent: false });
  expect(server.actions).not.toContain('run');
  expect(server.actions.at(-1)).toBe('release');
});
it('取消在途分段读取后释放本次传输，不继续收取后续数据或重发', async () => {
  const controller = new AbortController();
  const server = peer({ value: 'x'.repeat(30000) });
  const command = async (...args: Parameters<typeof server.command>): Promise<string> => {
    const result = await server.command(...args);
    if (server.actions.at(-1) === 'read-batch') controller.abort(new Error('用户停止同步'));
    return result;
  };
  await expect(new Ma2NetworkWire({ command }).exchange(id, 'SEQUENCE', 9000, '', () => undefined, controller.signal)).rejects.toThrow('用户停止同步');
  expect(server.actions.filter(action => action === 'read-batch')).toHaveLength(1);
  expect(server.actions.filter(action => action === 'run')).toHaveLength(1);
  expect(server.actions.at(-1)).toBe('release');
});
it('排队时带原 Show 和会话重新申请；同一请求只运行一次，后排的读取也能完成', async () => {
  const busy = 'ERR:' + Buffer.from('[string "tblink_bridge"]:1875: Another network request is pending:31:32').toString('hex');
  const command = vi.fn().mockResolvedValueOnce(busy).mockResolvedValueOnce('ACK').mockResolvedValueOnce('DONE:41');
  let currentId = '';
  const line = async (query: string): Promise<string> => {
    if (query.includes(",'begin")) currentId = /,'(?:begin(?:[:a-f0-9]+)?)','([a-f0-9]{32})'/.exec(query)![1]!;
    if (query.includes('for i=')) return Buffer.from(currentId + '\nOK\n3\n3.7').toString('hex');
    if (query.includes(",'release',")) return 'ACK';
    return String(await command(query));
  };
  command.mockResolvedValueOnce('ACK').mockResolvedValueOnce('DONE:41');
  const bridge = new Ma2OnpcBridge(new Ma2NetworkWire({ command: line }), showStopped);
  await expect(Promise.all([bridge.request('PING', 1), bridge.request('PING', 1)])).resolves.toEqual(['3.7', '3.7']);
  expect(command.mock.calls[1]?.[0]).toContain(",'begin:31:32',");
  expect(command.mock.calls.filter(([q]) => String(q).includes(",'run',"))).toHaveLength(2);
});

it('控台明确拒绝占用后取消，只清除自己的本地登记', async () => {
  const controller = new AbortController(), released = vi.fn();
  const command = vi.fn(() => { controller.abort(new Error('用户停止同步')); return Promise.resolve('ERR:' + Buffer.from('Another network request is pending:31:32').toString('hex')); });
  await expect(new Ma2NetworkWire({ command }, false, { begin: () => undefined, released }).exchange(id, 'READ', 1, '', () => undefined, controller.signal)).rejects.toMatchObject({ sent: false, message: '用户停止同步' });
  expect(command).toHaveBeenCalledOnce(); expect(released).toHaveBeenCalledWith(id);
});

it('没有取得请求时不释放其他客户端正在进行的传输', async () => {
  const commands: string[] = [];
  const connection = { command: (line: string): Promise<string> => {
    commands.push(line);
    return Promise.reject(new Error('Another network request is pending'));
  } };
  await expect(new Ma2NetworkWire(connection).exchange(id, 'SEQUENCE', 1, '', () => undefined)).rejects.toMatchObject({ sent: false });
  expect(commands).toHaveLength(1);
  expect(commands[0]).toContain("'begin'");
});
it('清理失败保留原始错误和发送状态，不重试清理或写入', async () => {
  const server = peer({ failRun: true });
  let releases = 0;
  const connection = { command: (line: string, match: (text: string) => string | null): Promise<string> => {
    if (line.includes("'release'")) { releases++; return Promise.reject(new Error('连接已断开')); }
    return server.command(line, match);
  } };
  await expect(new Ma2NetworkWire(connection).exchange(id, 'SYNC', 9901, '', () => undefined)).rejects.toMatchObject({ sent: true, message: 'Disconnected after write；传输清理未确认：连接已断开' });
  expect(releases).toBe(1);
  expect(server.actions.filter(action => action === 'run')).toHaveLength(1);
});
it('网络传输沿用本机桥的对象验证与播放保护', async () => {
  let calls = 0;
  const bridge = new Ma2OnpcBridge({ exchange: () => { calls += 1; return Promise.resolve('<MA><Timecode index="4" /></MA>'); } }, showStopped);
  await expect(bridge.request('READ', 6)).rejects.toThrow();
  await expect(bridge.request('APPLY', 6, 'invalid', 'invalid')).rejects.toThrow();
  expect(calls).toBe(1);
});

it('完整快照仅回读一次，写入复用同一目标和完全相同的原始快照', async () => {
  const server = peer({ value: '<MA>原始全量序列</MA>'.repeat(1000) });
  const wire = new Ma2NetworkWire(server);
  const expected = await wire.exchange(id, 'SNAPSHOT', 9901, '', () => undefined);
  expect(server.actions.filter(action => action === 'read-batch').length).toBeLessThan(10);
  const desired = '<MA>修改后的时间线</MA>';
  await wire.exchange(id, 'SYNC', 9901, `${Buffer.byteLength(expected)}\n${expected}${desired}`, () => undefined);
  expect(server.actions).toContain('beginsync');
  expect(Buffer.concat(server.received).toString()).toBe(desired);
});

it.each(['target', 'content'] as const)('快照 %s 不一致时不使用控台缓存引用', async change => {
  const server = peer({ value: '<MA>完整原文</MA>' });
  const wire = new Ma2NetworkWire(server);
  const original = await wire.exchange(id, 'SNAPSHOT', 9901, '', () => undefined);
  const expected = change === 'content' ? original.replace('原文', '变动') : original;
  const body = `${Buffer.byteLength(expected)}\n${expected}<MA/>`;
  await wire.exchange(id, 'SYNC', change === 'target' ? 9902 : 9901, body, () => undefined);
  expect(server.actions).not.toContain('beginsync');
  expect(Buffer.concat(server.received).toString()).toBe(body);
});

it('精简 Cue 快照仍使用控台原始快照引用，不能上传精简数据替代写前核对', async () => {
  const compact = '<MA><Timecode index="9906"/><Sequ index="8998"><Cue index="1"><Number number="1" sub_number="100"/><CuePart index="0" name="测试 Cue"/></Cue></Sequ></MA>';
  const server = peer({ value: compact });
  const wire = new Ma2NetworkWire(server);
  const received = await wire.exchange(id, 'SCOPE', 9907, '8999', () => undefined);
  server.received.length = 0;
  const desired = '<MA><Timecode index="9906"/></MA>';
  await wire.exchange(id, 'SYNC', 9907, `${Buffer.byteLength(received)}\n${received}${desired}`, () => undefined);
  expect(server.actions).toContain('beginsync');
  expect(Buffer.concat(server.received).toString()).toBe(desired);
});

it('插件分步：run 之后一条一条发 step 到 DONE，每步之前问一次 beforeStep，每步算一次进度', async () => {
  const server = peer({ steps: 4 });
  let asked = 0; let progressed = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SNAPSHOT', 9901, '', () => undefined, undefined, () => { progressed += 1; }, () => { asked += 1; })).resolves.toBe('中文 Cue'.repeat(220));
  expect(server.actions).toEqual(['begin', 'run', 'step', 'step', 'step', 'read-batch', 'release']);
  expect(asked).toBe(4);
  expect(progressed).toBeGreaterThanOrEqual(3);
});
it('分步以前的插件：run 直接回 DONE，照常走完，beforeStep 只问一次', async () => {
  const server = peer();
  let asked = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SNAPSHOT', 9901, '', () => undefined, undefined, undefined, () => { asked += 1; })).resolves.toBe('中文 Cue'.repeat(220));
  expect(server.actions).toEqual(['begin', 'run', 'read-batch', 'release']);
  expect(asked).toBe(1);
});
it('beforeStep 叫停：下一步不发，释放这次事务，算已发出，不重发', async () => {
  const server = peer({ steps: 3 });
  let asked = 0;
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, 'data', () => undefined, undefined, undefined, () => { asked += 1; if (asked === 2) throw new Error('时间码开始走了'); })).rejects.toMatchObject({ sent: true, message: '时间码开始走了' });
  expect(server.actions).toEqual(['begin', 'chunk', 'run', 'release']);
});
it('第一步之前叫停：什么都没执行，算没发出', async () => {
  const server = peer({ steps: 3 });
  await expect(new Ma2NetworkWire(server).exchange(id, 'SYNC', 9901, 'data', () => undefined, undefined, undefined, () => { throw new Error('时间码开始走了'); })).rejects.toMatchObject({ sent: false });
  expect(server.actions).toEqual(['begin', 'chunk', 'release']);
});
it('插件报的步数对不上就停下释放，不接着发', async () => {
  const server = peer({ steps: 4, stepNumbers: [1, 3] });
  await expect(new Ma2NetworkWire(server).exchange(id, 'SNAPSHOT', 9901, '', () => undefined)).rejects.toMatchObject({ sent: true, message: '控台分步执行的回答对不上' });
  expect(server.actions).toEqual(['begin', 'run', 'step', 'release']);
});
it('只允许 SEQGO 进入只读确认阶段，进入后不允许退回写入阶段', async () => {
  for (const operation of ['SYNC', 'SEQGO'] as const) {
    const server = peer({ steps: 4, verifyingSteps: [1] });
    await expect(new Ma2NetworkWire(server).exchange(id, operation, 3, '', () => undefined)).rejects.toThrow('确认阶段');
    expect(server.actions.filter(action => action === 'run')).toHaveLength(1);
    expect(server.actions.at(-1)).toBe('release');
  }
});
it('SEQGO 已完成写入后，取消或播放开始仍完成分批读回，不重新提交写入', async () => {
  const server = peer({ steps: 5, verifyingSteps: [2, 3, 4], value: 'verified' });
  const controller = new AbortController();
  let gates = 0;
  const command = async (...args: Parameters<typeof server.command>) => {
    const reply = await server.command(...args);
    if (reply.includes(':verify')) controller.abort(new Error('已取消'));
    return reply;
  };
  await expect(new Ma2NetworkWire({ command }).exchange(id, 'SEQGO', 3, '', () => undefined, controller.signal, undefined, () => { gates++; })).resolves.toBe('verified');
  expect(gates).toBe(2);
  expect(server.actions.filter(action => action === 'run')).toHaveLength(1);
  expect(server.actions.filter(action => action === 'step')).toHaveLength(4);
  expect(server.actions.at(-1)).toBe('release');
});
it('步与步之间排着的关灯先发，再发下一步', async () => {
  const queue = new Ma2CommandQueue();
  const order: string[] = [];
  const server = peer({ steps: 3 });
  const connection = { command: (line: string, match: (text: string) => string | null): Promise<string> => queue.schedule(async () => {
    const result = await server.command(line, match);
    const action = server.actions.at(-1)!;
    order.push(action);
    // Lights-off arrives while the first step is on the console.
    if (action === 'run') void queue.schedule(() => { order.push('off'); return Promise.resolve(''); }, 'stop');
    return result;
  }, 'normal') };
  await new Ma2NetworkWire(connection).exchange(id, 'SNAPSHOT', 9901, '', () => undefined);
  expect(order).toEqual(['begin', 'run', 'off', 'step', 'step', 'read-batch', 'release']);
});
