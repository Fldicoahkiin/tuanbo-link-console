import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CircleAlert, ShieldCheck } from 'lucide-react';
import { z } from 'zod';
import QRCode from 'qrcode';
import { consolePolicy, sessionSchema } from '../src/console-contract';
import { api, errorMessage } from './api';
import { OneTimeCode } from './step-up';
import { EnrollSteps, PasswordInput, PasswordLength, RecoveryCodes } from './components/auth-parts';
import { CopyButton } from './components/copy-button';
import { Alert, AlertDescription } from './components/ui/alert';
import { Button } from './components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from './components/ui/field';
import { Input } from './components/ui/input';
import { Spinner } from './components/ui/spinner';

const passwordMinimum = 12;
const idleDays = consolePolicy.sessionIdleMs / 86400000;
const maxDays = consolePolicy.sessionMaxMs / 86400000;
type Enrollment = { username: string; secret: string; uri: string };

/** 登录和开通（填开通凭据 → 绑定验证器设密码 → 保存恢复码）。自己铺满整个视口。 */
export function AuthView({ onLogin }: { onLogin: (session: z.infer<typeof sessionSchema>) => void }) {
  const [enroll, setEnroll] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failures, setFailures] = useState(0);
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<Enrollment | null>(null);
  const [qr, setQr] = useState('');
  const [password, setPassword] = useState('');
  const [recovery, setRecovery] = useState<{ username: string; codes: string[] } | null>(null);
  const form = useRef<HTMLFormElement>(null);
  const ids = useId();
  const step = recovery ? 3 : info ? 2 : 1;
  // 验证码输满 6 位时，其余必填项也已填好才自动提交。
  const complete = () => {
    if (enroll && password.length < passwordMinimum) return;
    if (form.current?.checkValidity()) form.current.requestSubmit();
  };
  function switchTo(next: boolean) {
    setEnroll(next);
    setToken('');
    setInfo(null);
    setQr('');
    setPassword('');
    setRecovery(null);
    setError('');
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (!enroll) onLogin(await api('login', sessionSchema, { username: data.get('username'), password: data.get('password'), code: data.get('code') }));
      else if (!info) {
        const entered = data.get('token');
        const value = await api('enrollment-info', z.object({ username: z.string(), secret: z.string(), uri: z.string() }), { token: entered });
        setQr(await QRCode.toDataURL(value.uri, { width: 200, margin: 1 }));
        setToken(typeof entered === 'string' ? entered : '');
        setInfo(value);
      } else {
        const value = await api('enroll', z.object({ recoveryCodes: z.array(z.string()) }), { token, password, code: data.get('code') });
        setRecovery({ username: info.username, codes: value.recoveryCodes });
        setInfo(null);
        setQr('');
        setPassword('');
      }
    } catch (cause) {
      setError(errorMessage(cause));
      setFailures(count => count + 1);
    } finally {
      setBusy(false);
    }
  }
  const title = !enroll ? '登录运营后台' : step === 1 ? '开通管理账号' : step === 2 ? '绑定验证器' : '保存恢复码';
  const submitText = !enroll ? '登录' : info ? '完成开通' : '准备绑定验证器';
  return <main className="flex min-h-dvh items-center justify-center bg-muted px-4 py-8">
    <section className="flex w-full max-w-sm flex-col gap-6 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10">
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary"><ShieldCheck className="size-4" aria-hidden="true" /></span>
          <div className="flex flex-col">
            <span className="font-medium">团播联动台</span>
            <span className="text-xs text-muted-foreground">运营管理</span>
          </div>
        </div>
        {enroll && <EnrollSteps current={step} />}
        <h1 className="text-lg font-medium">{title}</h1>
      </header>
      {error && <Alert variant="destructive" role="alert">
        <CircleAlert aria-hidden="true" />
        <AlertDescription>{error}</AlertDescription>
      </Alert>}
      {recovery
        ? <div className="flex flex-col gap-4">
          <p className="text-muted-foreground">每枚只能用一次，离开本页后不再显示。验证器丢了的时候，用它代替验证码登录。</p>
          <RecoveryCodes codes={recovery.codes} username={recovery.username} />
          <Button size="lg" className="w-full max-sm:h-10" onClick={() => switchTo(false)}>已保存，返回登录</Button>
        </div>
        : <form ref={form} className="flex flex-col gap-6" onSubmit={event => { void submit(event); }}>
          <FieldGroup className="gap-4">
            {!enroll && <>
              <Field>
                <FieldLabel htmlFor={`${ids}-username`}>用户名</FieldLabel>
                <Input id={`${ids}-username`} name="username" className="h-9" required autoComplete="username" autoFocus />
              </Field>
              <Field>
                <FieldLabel htmlFor={`${ids}-password`}>密码</FieldLabel>
                <PasswordInput id={`${ids}-password`} name="password" required maxLength={256} autoComplete="current-password" />
              </Field>
            </>}
            {enroll && !info && <Field>
              <FieldLabel htmlFor={`${ids}-token`}>一次性开通凭据</FieldLabel>
              <Input id={`${ids}-token`} name="token" type="password" className="h-9" required autoComplete="off" autoFocus aria-describedby={`${ids}-token-hint`} />
              <FieldDescription id={`${ids}-token-hint`} className="text-xs">管理员在“人员管理”里生成，24 小时内有效，只能用一次。</FieldDescription>
            </Field>}
            {info && <>
              <Bind info={info} qr={qr} />
              <Field>
                <FieldLabel htmlFor={`${ids}-new-password`}>设置密码（至少 {passwordMinimum} 位）</FieldLabel>
                <PasswordInput id={`${ids}-new-password`} name="password" required minLength={passwordMinimum} maxLength={256} autoComplete="new-password"
                  value={password} onChange={event => setPassword(event.target.value)} aria-describedby={`${ids}-length`} />
                <PasswordLength id={`${ids}-length`} length={password.length} minimum={passwordMinimum} />
              </Field>
            </>}
            {(!enroll || info) && <OneTimeCode allowRecovery={!enroll} onComplete={complete} failures={failures} disabled={busy} />}
          </FieldGroup>
          <Button type="submit" size="lg" className="w-full max-sm:h-10" disabled={busy}>
            {busy ? <><Spinner aria-hidden="true" />处理中…</> : submitText}
          </Button>
        </form>}
      {!recovery && <Footer>
        {!enroll && <p className="text-xs text-muted-foreground">保持登录：{idleDays} 天不用会自动退出，最长 {maxDays} 天。</p>}
        <Button type="button" variant="link" size="sm" className="h-auto px-0" disabled={busy} onClick={() => switchTo(!enroll)}>
          {enroll ? '返回登录' : '使用开通凭据设置账号'}
        </Button>
      </Footer>}
    </section>
  </main>;
}

/** 卡片底部：分隔线下面的小字和文字按钮。 */
function Footer({ children }: { children: ReactNode }) {
  return <footer className="-mx-4 -mb-4 flex flex-col items-start gap-2 rounded-b-xl border-t bg-muted/50 p-4">{children}</footer>;
}

/** 第 2 步：账号名、二维码、手动输入的密钥。 */
function Bind({ info, qr }: { info: Enrollment; qr: string }) {
  return <div className="flex flex-col gap-3">
    <p>账号：<span className="font-medium">{info.username}</span></p>
    <img src={qr} width={200} height={200} alt="使用验证器扫描此二维码" className="size-50 self-center rounded-lg ring-1 ring-foreground/10" />
    <p className="text-muted-foreground">用手机上的验证器 App（如 Microsoft Authenticator、Google Authenticator）扫描二维码；扫不了就手动输入下面的密钥。</p>
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 rounded-lg bg-muted px-3 py-2 font-mono text-sm break-all">{info.secret}</code>
      <CopyButton value={info.secret} label="复制密钥" size="icon-sm" className="size-9" />
    </div>
  </div>;
}
