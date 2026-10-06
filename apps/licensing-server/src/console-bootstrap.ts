import { readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { ConsoleAuth } from './console-auth';
import { migrateConsole } from './console-database';

// Run locally on the server as the service user; no credentials in argv or stdout.
const config = z.object({ LICENSE_DATABASE: z.string().min(1), CONSOLE_KEY_FILE: z.string().min(1), CONSOLE_BOOTSTRAP_USERNAME: z.string().regex(/^[a-zA-Z0-9._-]{3,64}$/), CONSOLE_BOOTSTRAP_OUTPUT: z.string().min(1) }).parse(process.env);
process.umask(0o077);
const db = new DatabaseSync(config.LICENSE_DATABASE);
try {
  migrateConsole(db);
  const auth = new ConsoleAuth(db, Buffer.from(readFileSync(config.CONSOLE_KEY_FILE, 'utf8').trim(), 'base64'));
  // Reserve output first, so an existing path cannot strand the first owner.
  writeFileSync(config.CONSOLE_BOOTSTRAP_OUTPUT, '', { flag: 'wx', mode: 0o600 });
  const result = auth.bootstrap(config.CONSOLE_BOOTSTRAP_USERNAME);
  writeFileSync(config.CONSOLE_BOOTSTRAP_OUTPUT, JSON.stringify(result), { mode: 0o600 });
  console.log('负责人开通凭据已写入受限输出文件；24 小时内在管理站的账号开通页使用。');
} finally { db.close(); }
