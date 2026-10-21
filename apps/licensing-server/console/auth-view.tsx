import { useState, type FormEvent } from 'react';
import { ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import QRCode from 'qrcode';
import { sessionSchema } from '../src/console-contract';
import { api, errorMessage } from './api';

export function AuthView({ onLogin }: { onLogin: (session: z.infer<typeof sessionSchema>) => void }) {
  const [enroll, setEnroll] = useState(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [info, setInfo] = useState<{ username: string; secret: string; uri: string } | null>(null); const [qr, setQr] = useState(''); const [recovery, setRecovery] = useState<string[]>([]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget); setBusy(true); setError('');
    try {
      if (!enroll) onLogin(await api('login', sessionSchema, { username: data.get('username'), password: data.get('password'), code: data.get('code') }));
      else if (!info) { const value = await api('enrollment-info', z.object({ username: z.string(), secret: z.string(), uri: z.string() }), { token: data.get('token') }); setQr(await QRCode.toDataURL(value.uri, { width: 200, margin: 1 })); setInfo(value); }
      else { const value = await api('enroll', z.object({ recoveryCodes: z.array(z.string()) }), { token: data.get('token'), password: data.get('password'), code: data.get('code') }); setRecovery(value.recoveryCodes); setInfo(null); setQr(''); }
    } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-card"><ShieldCheck size={30} aria-hidden="true" /><p className="eyebrow">团播联动台 / 运营管理</p><h1>{recovery.length ? '保存恢复码' : enroll ? '开通管理账号' : '登录运营后台'}</h1>
    {error && <p className="alert" role="alert">{error}</p>}
    {recovery.length ? <><p>每枚只能用一次，离开本页后不再显示。</p><pre className="secret">{recovery.join('\n')}</pre><button onClick={() => { setRecovery([]); setEnroll(false); }}>已保存，返回登录</button></> : <form onSubmit={event => { void submit(event); }}>
      {enroll ? <label>一次性开通凭据<input name="token" type="password" required autoComplete="off" readOnly={Boolean(info)} /></label> : <label>用户名<input name="username" required autoComplete="username" /></label>}
      {info && <div className="enrollment"><strong>{info.username}</strong><img src={qr} width={200} height={200} alt="使用验证器扫描此二维码" /><p>用验证器扫描，或手动输入密钥：</p><code>{info.secret}</code></div>}
      {(!enroll || info) && <><label>{enroll ? '设置密码（至少 12 位）' : '密码'}<input name="password" type="password" required minLength={enroll ? 12 : 1} maxLength={256} autoComplete={enroll ? 'new-password' : 'current-password'} /></label><label>验证器验证码{!enroll && '或恢复码'}<input name="code" required autoComplete="one-time-code" /></label></>}
      <button className="primary" disabled={busy}>{busy ? '处理中…' : enroll ? info ? '完成开通' : '准备绑定验证器' : '登录'}</button>
    </form>}
    {!recovery.length && <button className="text-button" disabled={busy} onClick={() => { setEnroll(!enroll); setInfo(null); setQr(''); setError(''); }}>{enroll ? '返回登录' : '使用开通凭据设置账号'}</button>}
  </section></main>;
}
