import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { NativeMidiOutput } from './native-midi-output';

const windowsTest = it.skipIf(process.platform !== 'win32' || process.env.TBLINK_NATIVE_MIDI_TEST !== '1');
const executable = () => resolve(process.env.TBLINK_PLAYBACK_ENGINE_EXE ?? 'tools/playback-engine/bin/tblink-playback.exe');

// Native process/protocol tests only. No installed MIDI output is opened, so
// these cannot be counted as physical MIDI delivery or the six-hour loopback.
windowsTest('真实辅助进程拒绝不存在的精确端口，退出可回收，不打开默认设备', async () => {
  const errors: string[] = [];
  const output = new NativeMidiOutput(executable(), error => errors.push(error.message));
  await expect(output.open(`TBLINK-ABSENT-${randomUUID()}`)).rejects.toThrow('指定输出端口不存在');
  await expect(output.close()).rejects.toThrow('异常退出：3');
  expect(errors).toHaveLength(1);
}, 10000);

windowsTest('原生边界拒绝截断包、超量长度、错误操作及未准备发送，不消费后续动作', async () => {
  const packet = Buffer.alloc(27); packet.write('TBM1'); packet.writeUInt32LE(1, 4); packet.writeUInt32LE(2, 8);
  packet.writeUInt32LE(3, 12); packet.writeBigUInt64LE(process.hrtime.bigint() / 100n + 1_000_000n, 16);
  packet.set([0x90, 60, 100], 24);
  const oversized = Buffer.from(packet.subarray(0, 24)); oversized.writeUInt32LE(65537, 12);
  const wrongOperation = Buffer.from(packet); wrongOperation.writeUInt32LE(3, 8);
  for (const bytes of [Buffer.from('TBM'), packet.subarray(0, 25), oversized, wrongOperation, packet]) {
    const child = spawn(executable(), ['--midi-output'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (data: string) => { stdout += data; }); child.stderr.on('data', (data: string) => { stderr += data; });
    const finished = new Promise<number | null>((resolve, reject) => { child.once('close', resolve); child.once('error', reject); child.stdin.on('error', reject); });
    child.stdin.end(bytes);
    expect(await finished).toBe(3); expect(stderr).toBe('');
    if (bytes === packet) expect(JSON.parse(stdout)).toEqual({ version: 1, requestId: 1, code: -1, acceptedAt100ns: '0' });
    else expect(stdout).toBe('');
  }
}, 10000);
