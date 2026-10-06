import type { DatabaseSync } from 'node:sqlite';

export function migrateConsole(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS console_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);`);
    if (Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM console_migrations').get()?.version) > 1) throw new Error('管理数据库版本高于当前程序，请使用匹配的服务版本');
    if (!db.prepare('SELECT version FROM console_migrations WHERE version=1').get()) {
      db.exec(`
        CREATE TABLE console_users (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE COLLATE NOCASE, role TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, password TEXT, totp TEXT NOT NULL, last_step INTEGER NOT NULL DEFAULT -1, invite_hash TEXT UNIQUE, invite_until INTEGER, recovery TEXT NOT NULL DEFAULT '[]');
        CREATE TABLE console_sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES console_users(id), csrf TEXT NOT NULL, created INTEGER NOT NULL, touched INTEGER NOT NULL, verified INTEGER NOT NULL);
        CREATE TABLE console_attempts (key TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL);
        CREATE TABLE console_operations (id TEXT PRIMARY KEY, actor TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT, state TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE console_audit (id TEXT PRIMARY KEY, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, reason TEXT NOT NULL, result TEXT NOT NULL, request_id TEXT NOT NULL);
        CREATE TABLE console_order_meta (order_id TEXT PRIMARY KEY REFERENCES orders(id), created TEXT NOT NULL, source TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL);
        CREATE TABLE console_tickets (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), license_id TEXT REFERENCES licenses(id), category TEXT NOT NULL, note TEXT NOT NULL, state TEXT NOT NULL, conclusion TEXT NOT NULL, created TEXT NOT NULL, updated TEXT NOT NULL, actor TEXT NOT NULL);
        CREATE TABLE console_refunds (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), amount_fen INTEGER NOT NULL, reference TEXT NOT NULL UNIQUE, handled_at TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL);
        CREATE TABLE console_invoices (id TEXT PRIMARY KEY, order_id TEXT NOT NULL REFERENCES orders(id), state TEXT NOT NULL, buyer TEXT NOT NULL, tax_id TEXT NOT NULL, reference TEXT NOT NULL, reason TEXT NOT NULL, actor TEXT NOT NULL, created TEXT NOT NULL);
        CREATE TABLE console_health (name TEXT PRIMARY KEY, state TEXT NOT NULL, checked_at TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE INDEX console_audit_target ON console_audit(target,at);
        CREATE INDEX console_audit_actor ON console_audit(actor,at);
        CREATE INDEX console_tickets_order ON console_tickets(order_id,state);
        CREATE INDEX console_refunds_order ON console_refunds(order_id);
        CREATE INDEX console_invoices_order ON console_invoices(order_id);
        CREATE INDEX console_sessions_user ON console_sessions(user_id);
        CREATE INDEX console_meta_created ON console_order_meta(created);
        CREATE INDEX console_order_customer ON orders(json_extract(body,'$.customer'));
        CREATE INDEX console_license_order ON licenses(order_id);
        CREATE INDEX console_business_audit ON audit(target,action,at);
      `);
      db.prepare('INSERT INTO console_migrations VALUES(1,?)').run(new Date().toISOString());
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
