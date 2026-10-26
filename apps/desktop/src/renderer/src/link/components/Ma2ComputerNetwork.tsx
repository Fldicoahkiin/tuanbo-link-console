import { useEffect, useState } from 'react';
import { ma2NetworkSetupPlanSchema, ma2NetworkSetupStateSchema, type Ma2NetworkSetupPlan, type Ma2NetworkSetupState } from '@tb/schema';
import { Button } from './Button';
import { ma2AddressInput } from '../view-models/ma2-address-input';
import { prepareMa2ComputerNetwork } from '../view-models/ma2-computer-network';

export function useMa2ComputerNetwork() {
  const [state, setState] = useState<Ma2NetworkSetupState | null>(null);
  const [adapterId, setAdapterId] = useState('');
  const [address, setAddress] = useState('');
  const [prefix, setPrefix] = useState(24);
  const [manual, setManual] = useState(false);
  const [error, setError] = useState('');
  const [plan, setPlan] = useState<Ma2NetworkSetupPlan | null>(null);
  const refresh = async (): Promise<Ma2NetworkSetupState> => {
    const next = ma2NetworkSetupStateSchema.parse(await window.tbLink.getMa2NetworkSetup()); setState(next); setError(''); return next;
  };
  useEffect(() => {
    let alive = true;
    void window.tbLink.getMa2NetworkSetup().then(value => { if(alive)setState(ma2NetworkSetupStateSchema.parse(value)); }).catch((cause:unknown)=>{if(alive)setError(String(cause));});
    return ()=>{alive=false;};
  }, []);
  const options = () => ({ ...(adapterId ? { adapterId } : {}), ...(manual && address.trim() ? { address: ma2AddressInput(address, '电脑 IP') } : {}), prefix });
  const inspect = async (host: string): Promise<void> => {
    setPlan(null); const current = await refresh(); const target = ma2AddressInput(host);
    if (target.startsWith('127.') || current.adapters.some(adapter => adapter.addresses.some(entry => entry.address === target))) { setError('这是本机 onPC 地址，无需更改网卡。连接外部控台时请填写控台屏幕上的 IP。'); return; }
    setPlan(ma2NetworkSetupPlanSchema.parse(await window.tbLink.planMa2NetworkSetup({ host: target, ...options() })));
  };
  const prepare = async (host: string, progress: (text: string) => void): Promise<void> => {
    setError('');
    await prepareMa2ComputerNetwork(host, options(), { progress, state: setState, plan: setPlan });
  };
  const restore = async (id: string): Promise<void> => {
    setState(ma2NetworkSetupStateSchema.parse(await window.tbLink.restoreMa2NetworkSetup(id))); setPlan(null);
  };
  return { state, adapterId, setAdapterId, address, setAddress, prefix, setPrefix, manual, setManual, error, plan, setPlan, inspect, refresh, prepare, restore };
}

export function Ma2ComputerNetwork({ network, host, disabled, run }: {
  network: ReturnType<typeof useMa2ComputerNetwork>; host: string; disabled: boolean; run: (operation: () => Promise<unknown>) => void;
}): JSX.Element {
  return <section aria-label="电脑网卡配置">
    <div className="device-section-heading"><h3>电脑网卡</h3><Button className="secondary-button" disabled={disabled} onClick={() => run(network.refresh)}>刷新网卡</Button></div>
    <p className="settings-note">只需要填控台屏幕上显示的 IP。电脑 IP 默认自动选择：已有能用的地址就直接用；需要新增地址时会先给出方案，连接时再由 Windows 确认授权。电脑上网用的 IP 不一定能直连控台。</p>
    <div className="ma2-network-fields">
      <label><span>插控台网线的网卡</span><select aria-label="控台网卡" disabled={disabled} value={network.adapterId} onChange={event => {network.setAdapterId(event.target.value);network.setPlan(null);}}><option value="">自动选择（记住上次成功选择）</option>{network.state?.adapters.map(adapter => <option key={adapter.id} value={adapter.id} disabled={!adapter.connected}>{adapter.name} · {adapter.connected ? '已接通' : '未接通'} · {adapter.addresses.map(entry => entry.address).join('、') || '尚无 IP'}</option>)}</select></label>
      <label><span>电脑 IP</span><select aria-label="电脑 IP 选择方式" disabled={disabled} value={network.manual?'manual':'auto'} onChange={event=>{network.setManual(event.target.value==='manual');network.setPlan(null);}}><option value="auto">自动选择电脑 IP（推荐）</option><option value="manual">手动指定电脑 IP</option></select></label>
      {network.manual?<label><span>指定电脑 IP</span><input aria-label="控台专用电脑 IP" placeholder="与控台同段、不同地址" disabled={disabled} value={network.address} onChange={event => {network.setAddress(event.target.value);network.setPlan(null);}} /></label>:null}
    </div>
    <details><summary>新增地址的子网掩码</summary><div className="ma2-network-fields"><label><span>子网掩码</span><select aria-label="控台子网掩码" disabled={disabled} value={network.prefix} onChange={event=>{network.setPrefix(Number(event.target.value));network.setPlan(null);}}>{[[24,'255.255.255.0'],[16,'255.255.0.0'],[8,'255.0.0.0']].map(([value,text])=><option key={value} value={value}>{text}</option>)}</select></label></div><p className="settings-note">只在新增地址时使用；用电脑已有的地址时，保留它原来的掩码。</p></details>
    {network.state?<ul className="ma2-adapter-inventory" aria-label="当前电脑网卡地址">{network.state.adapters.filter(adapter=>adapter.connected).map(adapter=><li key={adapter.id}><strong>{adapter.name}</strong><span>{adapter.physical?adapter.wired?'有线网卡':'无线网卡':'虚拟网卡'} · {adapter.addresses.map(entry=>`${entry.address}/${entry.prefix}${entry.state&&entry.state!=='Preferred'?`（${entry.state==='Duplicate'?'地址冲突':entry.state==='Tentative'?'检测中':'不可用'}）`:''}`).join('、')||'暂无 IPv4 地址'}</span></li>)}</ul>:null}
    <Button className="secondary-button" disabled={disabled||!host.trim()} onClick={()=>run(()=>network.inspect(host))}>检查电脑与控台网络</Button>
    {network.error?<p role="status" className="settings-note">{network.error}</p>:null}
    {network.state?.additions.map(entry => <div className="device-actions" key={entry.id}><span>{entry.adapterName} · 已添加 {entry.address}/{entry.prefix}</span><Button className="secondary-button" disabled={disabled} onClick={() => run(() => network.restore(entry.id))}>恢复原配置</Button></div>)}
  </section>;
}
