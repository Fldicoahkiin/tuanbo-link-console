import { randomInt } from 'node:crypto';
import type { Server } from 'node:http';

/** Test-only listener. Windows may allocate port 0 from a locally configured
 * range containing Fetch-blocked service ports (observed: "bad port"). Bind a
 * free dynamic/private port explicitly; never retry an HTTP request. */
export async function listenHttpTestServer(server: Server): Promise<void> {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: Error): void => { server.removeListener('listening', listening); reject(error); };
        const listening = (): void => { server.removeListener('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', listening);
        server.listen(randomInt(49152, 65536), '127.0.0.1');
      });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error('未能分配隔离 HTTP 测试端口');
}
