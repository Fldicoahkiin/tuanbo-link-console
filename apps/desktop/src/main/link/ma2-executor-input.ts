import { randomBytes } from 'node:crypto';
import { ma2ExecutorFunctions } from '@tb/core/link';
import { ma2ExecutorInputSchema, type Ma2ExecutorInput } from '@tb/schema';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';
import { runMa2GuardedLua } from './ma2-lua-command';

/** Native assigned button functions, including press/release, without a second WebRemote login. */
export class Ma2ExecutorInputService {
  private held = new Map<string, { connection: Pick<Ma2Telnet, 'command'>; request: Ma2ExecutorInput; released: boolean; leaseEndsAt: number }>();
  async input(connection: Pick<Ma2Telnet, 'command'>, input: Ma2ExecutorInput, current: () => void): Promise<void> {
    const request = ma2ExecutorInputSchema.parse(input);
    const code = request.expectedItem.buttons?.[request.button] ?? (request.button === 0 ? request.expectedItem.button : null);
    if (code === null || code === undefined || !ma2ExecutorFunctions[code]) throw new Error('该执行器按键没有已读取的可用功能，请刷新此页');
    const held = this.held.get(request.sessionId);
    if (!request.pressed && !held) return;
    if (held && (held.connection !== connection || held.request.page !== request.page || held.request.slot !== request.slot || held.request.button !== request.button)) throw new Error('执行器按住会话已变化');
    const key = held ?? { connection, request, released: false, leaseEndsAt: 0 };
    if (!request.pressed) {
      // Cancel queued press/renew operations immediately, before the higher
      // priority release reaches the wire. Keep the same object in their guards.
      key.released = true;
      if (Date.now() > key.leaseEndsAt) { this.held.delete(request.sessionId); return; }
    }
    const beforeSend = (): void => {
      if (!request.pressed) return;
      if (key.released) throw new Error('按键已松开，已取消排队的按下');
      current();
      if (Date.now() > request.deadlineAt) throw new Error('按键操作已过期，未补发，请重新点击');
    };
    beforeSend();
    const token = randomBytes(16).toString('hex');
    const hex = (value: string) => Buffer.from(value).toString('hex');
    const call = `TBLINK_EXEC_INPUT('${token}','${request.sessionId.replaceAll('-', '')}',${request.page},${request.slot},${request.button},${request.pressed ? 'true' : 'false'},${code},${request.expectedItem.sequence ?? 0},'${hex(request.expectedItem.name)}','${hex(request.expectedSource.show)}','${hex(request.expectedSource.generation)}','${hex(request.expectedItem.reference.join('.'))}')`;
    const body = `assert(TBLINK_EXEC_INPUT,'请重新连接以更新按键桥');return ${call}`;
    const line = `Lua "if TBLINK_EXEC_INPUT then ${call} else gma.echo('TBLINK_EXEC_${token}:MISSING') end"`;
    if (request.pressed) {
      key.request = request;
      // A queued command cannot execute after deadlineAt, and the native
      // bridge releases within two seconds of its last accepted press.
      key.leaseEndsAt = Math.max(key.leaseEndsAt, request.deadlineAt + 2000);
      this.held.set(request.sessionId, key);
    }
    const result = Buffer.byteLength(line) < 900
      ? await connection.command(line, text => ma2ResponseLine(text, `TBLINK_EXEC_${token}:`), beforeSend, request.pressed ? 'playback' : 'stop')
      : await runMa2GuardedLua({ command: (command, match, guard) => connection.command(command, match, guard, request.pressed ? 'playback' : 'stop') }, body, beforeSend);
    if (result.startsWith('ERR:')) {
      const message = result.slice(4);
      throw new Error(`执行器按键未确认：${/^(?:[a-f0-9]{2})+$/.test(message) ? Buffer.from(message, 'hex').toString('utf8') : '控台返回错误格式无效'}`);
    }
    if (request.pressed ? !['SENT', 'HELD'].includes(result) : result !== 'RELEASED') throw new Error('执行器按键桥未就绪，请重新连接控台');
    if (!request.pressed) this.held.delete(request.sessionId);
  }
  async release(): Promise<void> {
    const held = [...this.held.values()];
    const results = await Promise.allSettled(held.map(({ connection, request }) => this.input(connection, { ...request, pressed: false }, () => undefined)));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed.length) throw new Error(`按键释放回读未确认，控台租约将在 2 秒内释放：${failed.map(result => String(result.reason)).join('；')}`);
  }
}
