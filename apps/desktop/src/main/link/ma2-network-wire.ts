import { randomBytes } from 'node:crypto';
import { Ma2BridgeFailure, type Ma2Operation, type Ma2Wire } from './ma2-onpc-bridge';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

/** Chunked RPC over an authenticated command channel; uncertain writes are never replayed. */
export class Ma2NetworkWire implements Ma2Wire {
  private snapshot: { id: string; target: number; content: Buffer } | null = null;
  constructor(private readonly connection: Pick<Ma2Telnet, 'command'>) {}
  private async call(action: string, id: string, argumentsText = ''): Promise<string> {
    const token = randomBytes(16).toString('hex');
    const missing = Buffer.from('请先在 MA2 运行新版 tblink_bridge 插件').toString('hex');
    const prefix = `TBLINK_RPC_${token}:`;
    const line = `Lua "if TBLINK_NET then TBLINK_NET('${token}','${action}','${id}'${argumentsText}) else gma.echo('${prefix}ERR:${missing}') end"`;
    const result = await this.connection.command(line, (text) => ma2ResponseLine(text, prefix));
    if (result.startsWith('ERR:')) {
      const encoded = result.slice(4);
      if (!/^(?:[a-f0-9]{2})+$/.test(encoded)) throw new Error('MA2 插件错误响应格式无效');
      throw new Error(`MA2：${Buffer.from(encoded, 'hex').toString('utf8')}`);
    }
    return result;
  }
  async exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void, signal?: AbortSignal, progress?: () => void): Promise<string> {
    signal?.throwIfAborted();
    if (!/^[a-f0-9]{32}$/.test(id) || !Number.isInteger(target) || target < 1 || target > 99999) throw new Error('无效的 MA2 网络请求');
    let data = Buffer.from(body);
    if (data.length > 32 * 1024 * 1024) throw new Error('MA2 交换数据超过 32 MB');
    const newline = data.indexOf(10);
    const length = newline > 0 && /^\d+$/.test(data.subarray(0, newline).toString()) ? Number(data.subarray(0, newline).toString()) : -1;
    const reference = operation === 'SYNC' && this.snapshot?.target === target && length === this.snapshot.content.length && data.subarray(newline + 1, newline + 1 + length).equals(this.snapshot.content) ? this.snapshot.id : null;
    if (reference) data = data.subarray(newline + 1 + length);
    let sent = false;
    let acquired = false;
    let releaseAttempted = false;
    try {
      if (await this.call(reference ? 'beginsync' : 'begin', id, `,'${reference ?? operation}',${target},${data.length}`) !== 'ACK') throw new Error('MA2 未确认传输开始');
      acquired = true;
      for (let offset = 0; offset < data.length; offset += 256) {
        signal?.throwIfAborted();
        if (await this.call('chunk', id, `,${offset / 256 + 1},'${data.subarray(offset, offset + 256).toString('hex')}'`) !== 'ACK') throw new Error('MA2 未确认数据片段');
        progress?.();
      }
      signal?.throwIfAborted(); beforeSend(); sent = true;
      const receipt = /^DONE:(\d+)$/.exec(await this.call('run', id));
      const size = Number(receipt?.[1]);
      if (!Number.isInteger(size) || size < 1 || size > 33554500) throw new Error('MA2 响应长度无效');
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < size; offset += 8192) {
        signal?.throwIfAborted();
        chunks.push(await this.readBatch(id, offset, size));
        progress?.();
      }
      const response = Buffer.concat(chunks).toString('utf8');
      const match = /^([a-f0-9]{32})\n(OK|ERROR)\n(\d+)\n([\s\S]*)$/.exec(response);
      if (!match || match[1] !== id || Buffer.byteLength(match[4] ?? '') !== Number(match[3])) throw new Error('MA2 回读身份或长度不一致');
      releaseAttempted = true;
      if (await this.call('release', id) !== 'ACK') throw new Error('MA2 未确认传输结束');
      if (match[2] !== 'OK') throw new Error(`MA2：${match[4]}`);
      if (operation === 'SNAPSHOT' || operation === 'SCOPE') this.snapshot = { id, target, content: Buffer.from(match[4] ?? '') };
      return match[4] ?? '';
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      // Release only this transaction. Never execute it again or clear another client's request.
      if (acquired && !releaseAttempted) {
        try { if (await this.call('release', id) !== 'ACK') throw new Error('控台未确认释放'); }
        catch (cleanupError) { message += `；传输清理未确认：${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`; }
      }
      throw new Ma2BridgeFailure(message, id, sent, { cause: error });
    }
  }
  private async readBatch(id: string, offset: number, size: number): Promise<Buffer> {
    const token = randomBytes(14).toString('hex');
    const count = Math.min(32, Math.ceil((size - offset) / 256));
    const line = `Lua "for i=0,${count - 1} do TBLINK_NET('${token}'..string.format('%04x',i),'read','${id}',${offset}+i*256) end"`;
    const value = await this.connection.command(line, text => {
      const parts: string[] = [];
      for (let i = 0; i < count; i++) {
        const result = ma2ResponseLine(text, `TBLINK_RPC_${token}${i.toString(16).padStart(4, '0')}:`);
        if (result === null) return null;
        const encoded = /^DATA:((?:[a-f0-9]{2})+)$/.exec(result)?.[1];
        if (!encoded || encoded.length !== Math.min(256, size - offset - i * 256) * 2) throw new Error('MA2 批量回读片段缺失或无效');
        parts.push(encoded);
      }
      return parts.join('');
    });
    return Buffer.from(value, 'hex');
  }
}
