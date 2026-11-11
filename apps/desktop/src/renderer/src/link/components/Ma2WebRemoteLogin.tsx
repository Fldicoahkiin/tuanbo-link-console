import { useState } from 'react';

/**
 * Logging in to the console's web remote with the operator's own console user: the fader view's form, shared with the
 * console page's footer (C1). The password is kept only on this computer (main process, safeStorage).
 */
export function Ma2WebRemoteLogin({ connecting, action = '连接实时推杆', onConnect }: {
  connecting: boolean; action?: string; onConnect: (username: string, password: string) => Promise<void>;
}): JSX.Element {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState('');
  return <>
    <form onSubmit={event => { event.preventDefault(); void onConnect(username, password).then(() => setPassword('')); }}>
      <input aria-label="实时推杆用户" autoComplete="off" placeholder="控台普通用户名" value={username} onChange={event => setUsername(event.target.value)} disabled={connecting}/>
      <input aria-label="实时推杆密码" type="password" autoComplete="off" placeholder="密码（如有）" value={password} onChange={event => setPassword(event.target.value)} disabled={connecting}/>
      <button disabled={connecting || !username.trim()}>{connecting ? '连接中…' : action}</button>
    </form>
    <small>请在控台把 Remotes 设为 Login Enabled，并使用非 Administrator 用户。密码只保存在这台电脑上。</small>
  </>;
}
