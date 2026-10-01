import { useState } from 'react';
import { ma2NetworkSetupPlanSchema, ma2NetworkSetupStateSchema, type Ma2NetworkSetupPlan, type Ma2NetworkSetupState } from '@tb/schema';
import { Button } from './Button';
import { ma2AddressInput } from '../view-models/ma2-address-input';

export function useMa2ComputerNetwork() {
  const [state, setState] = useState<Ma2NetworkSetupState | null>(null);
  const [adapterId, setAdapterId] = useState('');
  const [address, setAddress] = useState('');
  const [prefix, setPrefix] = useState(24);
  const [plan, setPlan] = useState<Ma2NetworkSetupPlan | null>(null);
  const refresh = async (): Promise<Ma2NetworkSetupState> => {
    const next = ma2NetworkSetupStateSchema.parse(await window.tbLink.getMa2NetworkSetup()); setState(next); return next;
  };
  const prepare = async (host: string, progress: (text: string) => void): Promise<void> => {
    progress('正在检查电脑网卡与控台 IP…');
    const current = await refresh();
    // Local onPC shares the computer address and needs no interface changes.
    if (host.startsWith('127.') || current.adapters.some(adapter => adapter.addresses.some(entry => entry.address === host))) return;
    const proposal = ma2NetworkSetupPlanSchema.parse(await window.tbLink.planMa2NetworkSetup({ host, ...(adapterId ? { adapterId } : {}), ...(address.trim() ? { address: ma2AddressInput(address, '电脑 IP') } : {}), prefix }));
    setPlan(proposal); progress(proposal.message);
    if (proposal.needsChange) {
      progress(`${proposal.message} 请在 Windows 授权窗口中允许配置。`);
      try { setState(ma2NetworkSetupStateSchema.parse(await window.tbLink.applyMa2NetworkSetup(proposal.id))); }
      catch (error) { await refresh(); throw error; }
    }
  };
  const restore = async (id: string): Promise<void> => {
    setState(ma2NetworkSetupStateSchema.parse(await window.tbLink.restoreMa2NetworkSetup(id))); setPlan(null);
  };
  return { state, adapterId, setAdapterId, address, setAddress, prefix, setPrefix, plan, refresh, prepare, restore };
}

export function Ma2ComputerNetwork({ network, disabled, run }: {
  network: ReturnType<typeof useMa2ComputerNetwork>; disabled: boolean; run: (operation: () => Promise<unknown>) => void;
}): JSX.Element {
  return <section aria-label="电脑网卡配置">
    <div className="device-section-heading"><h3>电脑网卡</h3><Button className="secondary-button" disabled={disabled} onClick={() => run(network.refresh)}>刷新网卡</Button></div>
    <p className="settings-note">自动连接会选择网卡并增加控台专用 IP，保留上网配置。多个网口时在这里指定；管理员授权由 Windows 弹出。重启电脑后再次点自动连接即可。</p>
    <div className="ma2-network-fields">
      <label><span>插控台网线的网卡</span><select aria-label="控台网卡" disabled={disabled} value={network.adapterId} onChange={event => network.setAdapterId(event.target.value)}><option value="">自动选择</option>{network.state?.adapters.map(adapter => <option key={adapter.id} value={adapter.id} disabled={!adapter.connected}>{adapter.name} · {adapter.connected ? '已接通' : '未接通'} · {adapter.addresses.map(entry => entry.address).join('、') || '尚无 IP'}</option>)}</select></label>
      <label><span>电脑 IP（可留空）</span><input aria-label="控台专用电脑 IP" placeholder="自动生成，不用填写" disabled={disabled} value={network.address} onChange={event => network.setAddress(event.target.value)} /></label>
      <label><span>控台子网掩码</span><select aria-label="控台子网掩码" disabled={disabled} value={network.prefix} onChange={event => network.setPrefix(Number(event.target.value))}>{[[24, '255.255.255.0（常用）'], [16, '255.255.0.0'], [8, '255.0.0.0']].map(([value, text]) => <option key={value} value={value}>{text}</option>)}</select></label>
    </div>
    {network.plan ? <p className="settings-note" role="status">{network.plan.message}</p> : null}
    {network.state?.additions.map(entry => <div className="device-actions" key={entry.id}><span>{entry.adapterName} · 已添加 {entry.address}/{entry.prefix}</span><Button className="secondary-button" disabled={disabled} onClick={() => run(() => network.restore(entry.id))}>恢复原配置</Button></div>)}
  </section>;
}
