import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { roleSchema, userSchema, type ConsoleRole, type ConsoleUser } from './console-contract';
import { ServiceError } from './service';

const accountSchema = z.object({ id: z.string(), username: z.string(), role: roleSchema, enabled: z.number(), password: z.string().nullable(), totp: z.string(), last_step: z.number(), invite_hash: z.string().nullable(), invite_until: z.number().nullable(), recovery: z.string() });
type Account = z.infer<typeof accountSchema>;
export type ConsoleSession = { hash: string; user: ConsoleUser; csrf: string; verifiedAt: number };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const redactConsoleText = (value: string): string => value.replace(/\b(?:TBA|TBD)-[A-Fa-f0-9]+\b/g, '[凭据已隐藏]').replace(/\b[A-Fa-f0-9]{32,}\b/g, '[敏感值已隐藏]');
const derive = (password: string, salt: string) => new Promise<Buffer>((resolve, reject) => {
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => { if (error) reject(error); else resolve(key); });
});
function base32(bytes: Buffer): string {
  let bits = 0; let value = 0; let result = '';
  for (const byte of bytes) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits) result += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[(value << (5 - bits)) & 31];
  return result;
}
export function totpCode(secretHex: string, step: number): string {
  const counter = Buffer.alloc(8); counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', Buffer.from(secretHex, 'hex')).update(counter).digest();
  const offset = mac[mac.length - 1]! & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, '0');
}
export class ConsoleAuth {
  constructor(private readonly db: DatabaseSync, private readonly key: Buffer, private readonly now: () => number = Date.now) {
    if (key.length !== 32) throw new Error('管理认证密钥必须为 32 字节');
  }
  seal(value: string): string {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from('tblink:console:v1'));
    return Buffer.concat([iv, cipher.update(value, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  open(value: string): string {
    const bytes = Buffer.from(value, 'base64'); const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAAD(Buffer.from('tblink:console:v1')); cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(12, -16)), cipher.final()]).toString('utf8');
  }
  audit(actor: string, action: string, target: string, reason: string, result: string, requestId: string): void {
    const safeReason = redactConsoleText(reason);
    this.db.prepare('INSERT INTO console_audit VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), new Date(this.now()).toISOString(), actor, action, target, safeReason, result, requestId);
  }
  private attempts(key: string): number {
    this.db.prepare('DELETE FROM console_attempts WHERE until < ?').run(this.now());
    return Number(this.db.prepare('SELECT count FROM console_attempts WHERE key=?').get(digest(key))?.count ?? 0);
  }
  private record(key: string): void {
    this.db.prepare('INSERT INTO console_attempts VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(digest(key), this.now() + 900000);
  }
  limit(key: string, max = 10): void {
    if (this.attempts(key) >= max) throw new ServiceError(429, 'RATE_LIMITED', '认证尝试过多，请十五分钟后再试');
    this.record(key);
  }
  private account(id: string): Account {
    const value = this.db.prepare('SELECT * FROM console_users WHERE id=?').get(id);
    if (!value) throw new ServiceError(404, 'USER_NOT_FOUND', '人员不存在');
    return accountSchema.parse(value);
  }
  private publicUser(account: Account): ConsoleUser {
    return userSchema.parse({ ...account, enabled: Boolean(account.enabled), enrolled: Boolean(account.password) });
  }
  createUser(username: string, role: ConsoleRole): { id: string; token: string } {
    if (this.db.prepare('SELECT id FROM console_users WHERE username=? COLLATE NOCASE').get(username)) throw new ServiceError(409, 'USERNAME_EXISTS', '用户名已存在');
    const id = randomUUID(); const token = randomBytes(32).toString('hex');
    this.db.prepare('INSERT INTO console_users(id,username,role,totp,invite_hash,invite_until) VALUES(?,?,?,?,?,?)').run(id, username, role, this.seal(randomBytes(20).toString('hex')), digest(token), this.now() + 86400000);
    return { id, token };
  }
  bootstrap(username: string): { id: string; token: string } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT * FROM console_users').all();
      if (existing.length) {
        const prior = existing.length === 1 ? accountSchema.parse(existing[0]) : null;
        if (!prior || prior.password || prior.role !== 'owner' || prior.username !== username) throw new Error('已有管理员，请由现有管理员管理人员');
        const token = randomBytes(32).toString('hex');
        this.db.prepare('UPDATE console_users SET invite_hash=?,invite_until=?,totp=?,last_step=-1 WHERE id=?').run(digest(token), this.now() + 86400000, this.seal(randomBytes(20).toString('hex')), prior.id);
        this.db.exec('COMMIT'); return { id: prior.id, token };
      }
      const result = this.createUser(username, 'owner'); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private invitation(token: string): Account {
    const row = this.db.prepare('SELECT * FROM console_users WHERE invite_hash=? AND invite_until>? AND enabled=1').get(digest(token), this.now());
    if (!row) throw new ServiceError(401, 'INVALID_INVITATION', '开通凭据无效或过期');
    return accountSchema.parse(row);
  }
  enrollmentInfo(token: string): { username: string; secret: string; uri: string } {
    const account = this.invitation(token); const secret = base32(Buffer.from(this.open(account.totp), 'hex'));
    return { username: account.username, secret, uri: `otpauth://totp/${encodeURIComponent(`团播运营:${account.username}`)}?secret=${secret}&issuer=${encodeURIComponent('团播运营')}&algorithm=SHA1&digits=6&period=30` };
  }
  private consumeCode(account: Account, code: string, allowRecovery: boolean): boolean {
    const step = Math.floor(this.now() / 30000); const secret = this.open(account.totp);
    if (/^\d{6}$/.test(code)) {
      for (const candidate of [step, step - 1, step + 1]) {
        if (candidate <= account.last_step || candidate < 0 || !timingSafeEqual(Buffer.from(totpCode(secret, candidate)), Buffer.from(code))) continue;
        return this.db.prepare('UPDATE console_users SET last_step=? WHERE id=? AND last_step<?').run(candidate, account.id, candidate).changes === 1;
      }
    }
    if (allowRecovery) {
      const hashes = z.array(z.string()).parse(JSON.parse(account.recovery)); const hash = digest(code);
      if (hashes.includes(hash)) return this.db.prepare('UPDATE console_users SET recovery=? WHERE id=? AND recovery=?').run(JSON.stringify(hashes.filter(item => item !== hash)), account.id, account.recovery).changes === 1;
    }
    return false;
  }
  async enroll(token: string, password: string, code: string, requestId: string): Promise<{ recoveryCodes: string[] }> {
    const initial = this.invitation(token); const salt = randomBytes(16).toString('hex'); const passwordHash = `${salt}:${(await derive(password, salt)).toString('hex')}`;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const account = this.invitation(token);
      if (initial.id !== account.id || !this.consumeCode(account, code, false)) throw new ServiceError(401, 'INVALID_CODE', '验证码无效或已使用');
      const codes = Array.from({ length: 8 }, () => randomBytes(16).toString('hex'));
      this.db.prepare('UPDATE console_users SET password=?,invite_hash=NULL,invite_until=NULL,recovery=? WHERE id=?').run(passwordHash, JSON.stringify(codes.map(digest)), account.id);
      this.audit(account.id, 'auth.enrolled', account.id, '', 'success', requestId);
      this.db.exec('COMMIT'); return { recoveryCodes: codes };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  async login(username: string, password: string, code: string, requestId: string): Promise<{ token: string; session: ConsoleSession }> {
    const row = this.db.prepare('SELECT * FROM console_users WHERE username=? COLLATE NOCASE').get(username);
    const initial = row ? accountSchema.parse(row) : null;
    const [salt, hash] = (initial?.password ?? `unavailable:${'0'.repeat(128)}`).split(':');
    const key = await derive(password, salt!);
    const account = initial ? this.account(initial.id) : null;
    const passwordValid = account !== null && account.enabled !== 0 && account.password !== null && account.password === initial?.password && timingSafeEqual(key, Buffer.from(hash!, 'hex'));
    // 密码正确后的验证码失败按账号跨来源计数：不知道密码的人锁不住账号，知道密码的人也不能分散来源穷举验证码。
    // 锁定期间与其他失败同样返回 401，不暴露密码是否正确。
    const codeAttempts = `login-code:${initial?.id ?? ''}`;
    if (!passwordValid || this.attempts(codeAttempts) >= 10 || !this.consumeCode(account, code, true)) {
      if (passwordValid) this.record(codeAttempts);
      this.audit(account?.id ?? 'anonymous', 'auth.login', account?.id ?? '', '', 'denied', requestId);
      throw new ServiceError(401, 'INVALID_LOGIN', '账号、密码或验证码无效');
    }
    const token = randomBytes(32).toString('hex'); const csrf = randomBytes(32).toString('hex'); const now = this.now();
    this.db.prepare('DELETE FROM console_sessions WHERE touched<? OR created<?').run(now - 1800000, now - 28800000);
    this.db.prepare('INSERT INTO console_sessions VALUES(?,?,?,?,?,?)').run(digest(token), account.id, csrf, now, now, now);
    this.audit(account.id, 'auth.login', account.id, '', 'success', requestId);
    return { token, session: { hash: digest(token), user: this.publicUser(account), csrf, verifiedAt: now } };
  }
  session(token: string): ConsoleSession {
    const row = this.db.prepare('SELECT * FROM console_sessions WHERE hash=? AND touched>? AND created>?').get(digest(token), this.now() - 1800000, this.now() - 28800000);
    if (!row) throw new ServiceError(401, 'SESSION_EXPIRED', '请重新登录');
    const parsed = z.object({ hash: z.string(), user_id: z.string(), csrf: z.string(), verified: z.number() }).parse(row);
    const account = this.account(parsed.user_id);
    if (!account.enabled || !account.password) throw new ServiceError(401, 'SESSION_EXPIRED', '请重新登录');
    this.db.prepare('UPDATE console_sessions SET touched=? WHERE hash=?').run(this.now(), parsed.hash);
    return { hash: parsed.hash, user: this.publicUser(account), csrf: parsed.csrf, verifiedAt: parsed.verified };
  }
  verify(session: ConsoleSession, code: string, requestId: string): void {
    if (!this.consumeCode(this.account(session.user.id), code, true)) {
      this.audit(session.user.id, 'auth.verify', session.user.id, '', 'denied', requestId);
      throw new ServiceError(401, 'INVALID_CODE', '验证码无效或已使用，请等待下一枚验证码');
    }
    this.db.prepare('UPDATE console_sessions SET verified=? WHERE hash=?').run(this.now(), session.hash);
    this.audit(session.user.id, 'auth.verify', session.user.id, '', 'success', requestId);
  }
  logout(session: ConsoleSession, requestId: string): void { this.db.prepare('DELETE FROM console_sessions WHERE hash=?').run(session.hash); this.audit(session.user.id, 'auth.logout', session.user.id, '', 'success', requestId); }
  users(): ConsoleUser[] { return this.db.prepare('SELECT * FROM console_users ORDER BY username').all().map(row => this.publicUser(accountSchema.parse(row))); }
  updateUser(id: string, role: ConsoleRole, enabled: boolean): void {
    const prior = this.account(id);
    if (prior.role === 'owner' && prior.enabled && prior.password && (role !== 'owner' || !enabled)) {
      const owners = this.db.prepare("SELECT COUNT(*) AS n FROM console_users WHERE role='owner' AND enabled=1 AND password IS NOT NULL").get();
      if (Number(owners?.n) <= 1) throw new ServiceError(409, 'LAST_OWNER', '不能禁用或降级最后一个已开通的管理员');
    }
    this.db.prepare('UPDATE console_users SET role=?,enabled=? WHERE id=?').run(role, Number(enabled), id);
    this.db.prepare('DELETE FROM console_sessions WHERE user_id=?').run(id);
  }
  resetUser(id: string): { token: string } {
    const account = this.account(id);
    if (account.role === 'owner' && account.password && Number(this.db.prepare("SELECT COUNT(*) AS n FROM console_users WHERE role='owner' AND enabled=1 AND password IS NOT NULL").get()?.n) <= 1) throw new ServiceError(409, 'LAST_OWNER', '请先开通另一名管理员，再重置此账号');
    const token = randomBytes(32).toString('hex');
    this.db.prepare("UPDATE console_users SET password=NULL,totp=?,last_step=-1,recovery='[]',invite_hash=?,invite_until=? WHERE id=?").run(this.seal(randomBytes(20).toString('hex')), digest(token), this.now() + 86400000, id);
    this.db.prepare('DELETE FROM console_sessions WHERE user_id=?').run(id); return { token };
  }
}
