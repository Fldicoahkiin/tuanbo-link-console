import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { z } from 'zod';
import { sessionSchema } from '../src/console-contract';
import { api, ApiError, errorMessage } from './api';
import { AuthView } from './auth-view';
import { ConsoleApp } from './console-app';
import { Providers } from './components/providers';
import { Alert, AlertDescription } from './components/ui/alert';
import { Spinner } from './components/ui/spinner';

type Session = z.infer<typeof sessionSchema>;

/** 入口：先查登录状态，已登录进后台，没登录显示登录页。 */
function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const signedOut = useCallback(() => setSession(null), []);
  useEffect(() => {
    let live = true;
    void api('session', sessionSchema)
      .then(
        value => { if (live) setSession(value); },
        (cause: unknown) => { if (live && !(cause instanceof ApiError && cause.code === 'SESSION_EXPIRED')) setError(errorMessage(cause)); }
      )
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);
  if (loading) {
    return <main className="bg-background text-muted-foreground flex min-h-svh items-center justify-center gap-2 text-sm">
      <p role="status" className="flex items-center gap-2"><Spinner role="presentation" aria-hidden="true" />正在检查登录状态…</p>
    </main>;
  }
  if (session) return <ConsoleApp initial={session} signedOut={signedOut} />;
  return <>
    {/* 连不上服务器（不是没登录）时，报错放在登录卡片上方。 */}
    {error && <div className="fixed inset-x-0 top-4 z-10 flex justify-center px-4">
      <Alert variant="destructive" className="max-w-sm"><AlertDescription>{error}</AlertDescription></Alert>
    </div>}
    <AuthView onLogin={value => { setSession(value); setError(''); }} />
  </>;
}

const root = document.getElementById('root');
if (!root) throw new Error('缺少管理界面根节点');
createRoot(root).render(<StrictMode><Providers><App /></Providers></StrictMode>);
