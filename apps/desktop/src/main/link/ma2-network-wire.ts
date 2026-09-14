import { randomBytes } from 'node:crypto';
import { Ma2BridgeFailure, type Ma2Operation, type Ma2Wire } from './ma2-onpc-bridge';
import { ma2ResponseLine, type Ma2Telnet } from './ma2-telnet';

/** Chunked RPC over an authenticated command channel; uncertain writes are never replayed. */
export class Ma2NetworkWire implements Ma2Wire {
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
  async exchange(id: string, operation: Ma2Operation, target: number, body: string, beforeSend: () => void): Promise<string> {
    if (!/^[a-f0-9]{32}$/.test(id) || !Number.isInteger(target) || target < 1 || target > 99999) throw new Error('无效的 MA2 网络请求');
    const data = Buffer.from(body);
    if (data.length > 32 * 1024 * 1024) throw new Error('MA2 交换数据超过 32 MB');
    let sent = false;
    try {
      if (await this.call('begin', id, `,'${operation}',${target},${data.length}`) !== 'ACK') throw new Error('MA2 未确认传输开始');
      for (let offset = 0; offset < data.length; offset += 256) {
        if (await this.call('chunk', id, `,${offset / 256 + 1},'${data.subarray(offset, offset + 256).toString('hex')}'`) !== 'ACK') throw new Error('MA2 未确认数据片段');
      }
      beforeSend(); sent = true;
      const receipt = /^DONE:(\d+)$/.exec(await this.call('run', id));
      const size = Number(receipt?.[1]);
      if (!Number.isInteger(size) || size < 1 || size > 33554500) throw new Error('MA2 响应长度无效');
      const chunks: Buffer[] = [];
      for (let offset = 0; offset < size; offset += 256) {
        const reply = await this.call('read', id, `,${offset}`);
        const encoded = /^DATA:((?:[a-f0-9]{2})+)$/.exec(reply)?.[1];
        if (!encoded || encoded.length !== Math.min(256, size - offset) * 2) throw new Error('MA2 回读片段长度不一致');
        chunks.push(Buffer.from(encoded, 'hex'));
      }
      const response = Buffer.concat(chunks).toString('utf8');
      const match = /^([a-f0-9]{32})\n(OK|ERROR)\n(\d+)\n([\s\S]*)$/.exec(response);
      if (!match || match[1] !== id || Buffer.byteLength(match[4] ?? '') !== Number(match[3])) throw new Error('MA2 回读身份或长度不一致');
      if (await this.call('release', id) !== 'ACK') throw new Error('MA2 未确认传输结束');
      if (match[2] !== 'OK') throw new Error(`MA2：${match[4]}`);
      return match[4] ?? '';
    } catch (error) {
      throw new Ma2BridgeFailure(error instanceof Error ? error.message : String(error), id, sent, { cause: error });
    }
  }
}
