import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { LicensingService } from './service';
import { createLicensingServer } from './http';

const config = z.object({
  LICENSE_DATABASE: z.string().min(1), LICENSE_PRIVATE_KEY_FILE: z.string().min(1), LICENSE_KEY_ID: z.string().min(1),
  LICENSE_DATA_KEY_FILE: z.string().min(1), LICENSE_ADMIN_TOKEN_FILE: z.string().min(1),
  LICENSE_HOST: z.string().default('127.0.0.1'), LICENSE_PORT: z.coerce.number().int().min(1).max(65535).default(8787)
}).parse(process.env);
process.umask(0o077);
const service = new LicensingService(config.LICENSE_DATABASE, readFileSync(config.LICENSE_PRIVATE_KEY_FILE, 'utf8'), config.LICENSE_KEY_ID,
  Buffer.from(readFileSync(config.LICENSE_DATA_KEY_FILE, 'utf8').trim(), 'base64'));
const server = createLicensingServer(service, readFileSync(config.LICENSE_ADMIN_TOKEN_FILE, 'utf8').trim());
server.on('error', error => { console.error(`授权服务启动失败：${error.message}`); service.close(); process.exitCode = 1; });
server.listen(config.LICENSE_PORT, config.LICENSE_HOST, () => console.log('授权服务已启动；后台仅供运营核款，不是支付渠道回调。'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  const deadline = setTimeout(() => { console.error('授权服务停止超时'); process.exit(1); }, 10000);
  deadline.unref();
  server.close(() => { service.close(); clearTimeout(deadline); });
});
