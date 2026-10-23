import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Ma2ApplyService } from './ma2-apply-service';
import { Ma2OnpcBridge } from './ma2-onpc-bridge';

type Connection = { bridge: Ma2OnpcBridge; service: Ma2ApplyService };

/** Directory aliases must share the same mailbox and complete-sync exclusion. */
export class Ma2Connections {
  private readonly connections = new Map<string, Connection>();
  /** `requireDirectory`: the directory must be the one the main process recorded (Ma2DataDirectory). */
  constructor(private readonly isPlaying: () => boolean, private readonly requireDirectory: (directory: string) => Promise<void>) {}

  async get(directory: string): Promise<Connection> {
    if (!isAbsolute(directory)) throw new Error('MA2 数据目录必须是绝对路径');
    await this.requireDirectory(directory);
    const canonical = await realpath(directory);
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    let connection = this.connections.get(key);
    if (!connection) {
      const bridge = new Ma2OnpcBridge(canonical, this.isPlaying);
      connection = { bridge, service: new Ma2ApplyService(bridge, this.isPlaying) };
      this.connections.set(key, connection);
    }
    return connection;
  }
}
