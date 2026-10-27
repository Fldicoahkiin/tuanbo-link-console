import { useState } from 'react';
import type { Ma2Discovery } from '@tb/schema';
import { Button } from './Button';

export function Ma2DiscoveryResults({ result, disabled, selectedHost, onChoose }: {
  result: Ma2Discovery; disabled: boolean; selectedHost: string;
  onChoose: (address: Ma2Discovery['hosts'][number]) => void;
}): JSX.Element {
  const [query, setQuery] = useState('');
  const [includeUnknown, setIncludeUnknown] = useState(true);
  const identified = result.hosts.filter(address => address.identity === 'ma2');
  const rows = result.hosts.filter(address => (includeUnknown || address.identity === 'ma2') && `${address.host}:${address.port}`.includes(query.trim()))
    .sort((a, b) => Number(b.identity === 'ma2') - Number(a.identity === 'ma2') || a.host.localeCompare(b.host, undefined, { numeric: true }));
  return <section className="ma2-discovery-results" aria-label="MA2 搜索结果">
    <header><strong>搜索结果</strong><span>{identified.length} 个 MA2 远程入口 · {result.hosts.length - identified.length} 个待确认地址</span></header>
    <div className="ma2-discovery-tools"><input aria-label="筛选控台地址" placeholder="筛选 IP 或端口" value={query} onChange={event => setQuery(event.target.value)} /><label><input type="checkbox" checked={includeUnknown} onChange={event => setIncludeUnknown(event.target.checked)} />显示待确认地址</label></div>
    {rows.length ? <div className="ma2-discovery-list"><table><thead><tr><th>地址</th><th>识别结果</th><th>操作</th></tr></thead><tbody>{rows.map(address => <tr key={`${address.host}:${address.port}`} data-selected={address.host === selectedHost}><td>{address.host}:{address.port}</td><td>{address.identity === 'ma2' ? 'MA2 远程入口' : '待确认设备'}</td><td><Button className="secondary-button" disabled={disabled} onClick={() => onChoose(address)} aria-label={`选择控台 ${address.host}:${address.port}`}>{address.host === selectedHost ? '已选用' : '选用'}</Button></td></tr>)}</tbody></table></div>
      : <p className="settings-note">{query ? '没有匹配的地址。' : result.hosts.length ? '未识别到 MA2 远程入口，可展开待确认地址或手动填写 IP。' : '未发现开放的远程端口，请检查网络和控台 Telnet 设置，或手动填写 IP。'}</p>}
    <p className="settings-note">找到远程入口不代表已经登录控台。选用后，在下面填写登录信息再连接。</p>
    <details><summary>本机网卡与搜索范围</summary><ul>{result.ranges.map(range => <li key={range}>{range}</li>)}</ul><p className="settings-note">网线接通不代表 IP 一定能连上。如果广播被拦截或控台不响应广播，仍然可以按 IP 直连，不需要关闭整个防火墙。</p></details>
    {result.warnings.length ? <p className="device-error" role="alert">{result.warnings.join('；')}</p> : null}
  </section>;
}
