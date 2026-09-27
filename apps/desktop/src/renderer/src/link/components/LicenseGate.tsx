import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { LicenseSettings } from './LicenseSettings';

/** Do not mount device adapters or restore a project before main-process authorization. */
export function LicenseGate({ children }: { children: ReactNode }): JSX.Element {
  const [state, setState] = useState<'checking' | 'locked' | 'authorized'>('checking');
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    void window.tbLink.requireOutputLicense().then(() => {
      if (alive) setState('authorized');
    }, (failure: unknown) => {
      if (alive) { setError(failure instanceof Error ? failure.message : String(failure)); setState('locked'); }
    });
    return () => { alive = false; };
  }, []);
  if (state === 'authorized') return <>{children}</>;
  return <main className="device-console settings-content-page license-gate">
    <div className="device-detail"><div className="device-panel">
      <header className="license-gate-heading"><h1>激活团播联动台</h1>
        <Button className="secondary-button" aria-label="关闭软件" onClick={() => {
          void window.tbLink.controlWindow('close').catch((failure: unknown) => {
            setError(failure instanceof Error ? failure.message : String(failure));
          });
        }}><X /></Button>
      </header>
      <p className="settings-note">无需注册账户。购买授权后输入激活码，绑定这台电脑，即可使用全部产品功能。</p>
      {state === 'checking' ? <p role="status">正在验证本机授权…</p> : <>
        <p className="settings-note" role="alert">{error}</p>
        <LicenseSettings runtimeActive={false} onAuthorized={async () => {
          await window.tbLink.requireOutputLicense();
          setState('authorized');
        }} />
      </>}
    </div></div>
  </main>;
}
