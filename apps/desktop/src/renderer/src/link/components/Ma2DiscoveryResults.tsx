import { useState } from 'react';
import type { Ma2Discovery } from '@tb/schema';
import { Button, Disclosure, Notice, Switch, TextInput } from '../ui';

export function Ma2DiscoveryResults({ result, disabled, selectedHost, onChoose }: {
  result: Ma2Discovery; disabled: boolean; selectedHost: string;
  onChoose: (address: Ma2Discovery['hosts'][number]) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const identified = result.hosts.filter(address => address.identity === 'ma2');
  const rows = result.hosts.filter(address => (includeUnknown || address.identity === 'ma2') && `${address.host}:${address.port}`.includes(query.trim()))
    .sort((a, b) => Number(b.identity === 'ma2') - Number(a.identity === 'ma2') || a.host.localeCompare(b.host, undefined, { numeric: true }));
  return <section className="settings-subsection" aria-label="MA2 搜索结果">
    <header className="settings-subsection-header"><h3>搜索结果</h3><span>{identified.length} 个 MA2 远程入口 · {result.hosts.length - identified.length} 个待确认地址</span></header>
    <div className="settings-actions-row">
      <TextInput aria-label="筛选控台地址" placeholder="筛选 IP 或端口" width="auto" value={query} onChange={event => setQuery(event.target.value)} />
      <Switch label="显示待确认地址" checked={includeUnknown} onChange={event => setIncludeUnknown(event.target.checked)} />
    </div>
    {rows.length ? <table className="settings-table settings-discovery-table">
      <thead><tr><th scope="col">地址</th><th scope="col">识别结果</th><th scope="col"><span className="ui-visually-hidden">操作</span></th></tr></thead>
      <tbody>{rows.map(address => <tr key={`${address.host}:${address.port}`} data-selected={address.host === selectedHost}>
        <td>{address.host}:{address.port}</td>
        <td>{address.identity === 'ma2' ? 'MA2 远程入口' : '待确认设备'}</td>
        <td><Button variant={address.host === selectedHost ? 'ghost' : 'secondary'} size="sm" disabled={disabled} onClick={() => onChoose(address)} aria-label={`选择控台 ${address.host}:${address.port}`}>{address.host === selectedHost ? '已选用' : '选用'}</Button></td>
      </tr>)}</tbody>
    </table> : <p>{query ? '没有匹配的地址。' : result.hosts.length ? '没认出 MA2 远程入口，可以显示待确认地址，或手动填写 IP。' : '没找到开放的远程端口。检查网络和控台 Telnet 设置，或手动填写 IP。'}</p>}
    <p>找到远程入口不代表已经登录控台。选用后，在下面填登录信息再连接。</p>
    <Disclosure title="本机网卡与搜索范围">
      <ul className="settings-list">{result.ranges.map(range => <li key={range}>{range}</li>)}</ul>
      <p>网线接通不代表 IP 一定能连上。广播被拦截或控台不响应广播时，仍然可以按 IP 直连，不需要关掉整个防火墙。</p>
    </Disclosure>
    {result.warnings.length ? <Notice tone="warning">{result.warnings.join('；')}</Notice> : null}
  </section>;
}
