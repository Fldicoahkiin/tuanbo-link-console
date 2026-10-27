import { readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';
import { ma2NetworkAdapterSchema, ma2NetworkSetupPlanSchema, type Ma2NetworkSetupRequest, type Ma2NetworkSetupPlan, type Ma2NetworkSetupState } from '@tb/schema';
import { executePowerShell } from './windows-integration-detector';
import { changeNetworkAddress, NetworkAddressChangeError } from './ma2-network-address';
import { planMa2Network, readyAddress } from './ma2-network-setup-plan';
import { writeFileAtomically } from './atomic-file';

const snapshotSchema = z.object({ bootId: z.string(), adapters: z.array(ma2NetworkAdapterSchema) }).strict();
const recordsSchema = z.array(z.object({ bootId: z.string(), plan: ma2NetworkSetupPlanSchema }).strict());
export const networkAdapterScript = `$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';[Console]::OutputEncoding=[Text.UTF8Encoding]::new()
$allAddresses=@(Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop)
$adapters=@(Get-NetAdapter -ErrorAction Stop | ForEach-Object {
  $adapter=$_
  $addresses=@($allAddresses | Where-Object { $_.InterfaceIndex -eq $adapter.ifIndex } | ForEach-Object { @{address=$_.IPAddress;prefix=[int]$_.PrefixLength;state=$_.AddressState.ToString()} })
  @{id=$adapter.InterfaceGuid.ToString().Trim('{}');index=[int]$adapter.ifIndex;name=$adapter.Name;description=$adapter.InterfaceDescription;connected=($adapter.Status -eq 'Up');physical=([bool]$adapter.HardwareInterface -and $adapter.PnPDeviceID -notmatch '^(ROOT|SWD|VMBUS)');wired=([int]$adapter.NdisMedium -eq 0 -and [int]$adapter.NdisPhysicalMedium -ne 10);addresses=$addresses}
})
@{bootId=(Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime.ToUniversalTime().ToString('o');adapters=$adapters}|ConvertTo-Json -Depth 6 -Compress`;

type Dependencies = {
  snapshot: () => Promise<z.infer<typeof snapshotSchema>>;
  change: typeof changeNetworkAddress;
};
/** One change to a Windows adapter, as the operator is asked to confirm it. */
export type NetworkAddressChange = { action: 'add' | 'remove'; adapterName: string; adapterDescription: string; address: string; prefix: number; host: string };
export class Ma2NetworkSetup {
  private plans = new Map<string, Ma2NetworkSetupPlan>();
  private busy = false;
  /** `confirm`: the main process's own question to the operator; a window cannot answer it. */
  constructor(private readonly path: string, private readonly confirm: (change: NetworkAddressChange) => Promise<boolean>, private readonly dependencies: Dependencies = {
    snapshot: async () => snapshotSchema.parse(JSON.parse(await executePowerShell(networkAdapterScript, 15000))), change: changeNetworkAddress
  }) {}
  private async records(): Promise<z.infer<typeof recordsSchema>> {
    try { return recordsSchema.parse(JSON.parse(await readFile(this.path, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  }
  private async save(records: z.infer<typeof recordsSchema>): Promise<void> {
    await writeFile(`${this.path}.tmp`, JSON.stringify(records), 'utf8'); await rename(`${this.path}.tmp`, this.path);
  }
  private async selections(): Promise<Ma2NetworkSetupPlan[]> {
    try { return z.array(ma2NetworkSetupPlanSchema).parse(JSON.parse(await readFile(`${this.path}.selections`, 'utf8'))); }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; }
  }
  private async select(plan: Ma2NetworkSetupPlan): Promise<void> {
    await writeFileAtomically(`${this.path}.selections`, JSON.stringify([...(await this.selections()).filter(value => value.host !== plan.host), plan]));
  }
  async state(): Promise<Ma2NetworkSetupState> {
    const current = await this.dependencies.snapshot(); const records = await this.records();
    return { adapters: current.adapters, additions: records.filter(record => record.bootId === current.bootId).map(({ plan }) => ({ id: plan.id, adapterId: plan.adapter.id, adapterName: plan.adapter.name, address: plan.address, prefix: plan.prefix })) };
  }
  async plan(request: Ma2NetworkSetupRequest): Promise<Ma2NetworkSetupPlan> {
    const current = await this.dependencies.snapshot();
    const previous = (await this.selections()).find(value => value.host === request.host);
    const adapterId = request.adapterId ?? (request.address ? undefined : previous?.adapter.id);
    const plan = planMa2Network(current.adapters, { ...request, ...(adapterId ? { adapterId } : {}) });
    this.plans.clear(); this.plans.set(plan.id, plan); return plan;
  }
  async connectionAddress(host: string): Promise<string | undefined> {
    const current = await this.dependencies.snapshot();
    if (host.startsWith('127.') || current.adapters.some(adapter => adapter.addresses.some(entry => entry.address === host))) return undefined;
    const selected = (await this.selections()).find(plan => plan.host === host);
    const saved = (await this.records()).filter(record => record.bootId === current.bootId && record.plan.host === host).at(-1)?.plan;
    const plan = selected ?? saved;
    if (!plan) return undefined;
    const adapter = current.adapters.find(entry => entry.id === plan.adapter.id);
    if (!adapter?.connected || !adapter.addresses.some(entry => entry.address === plan.address && readyAddress(entry))) throw new Error(`控台专用地址 ${plan.address} 已不可用，请插好网线后重新点击自动连接`);
    return plan.address;
  }
  async apply(id: string): Promise<Ma2NetworkSetupState> {
    if (this.busy) throw new Error('网卡正在配置，请等待完成');
    const plan = this.plans.get(id); if (!plan) throw new Error('网络方案已过期，请重新检查');
    this.busy = true;
    try {
      const current = await this.dependencies.snapshot();
      const adapter = current.adapters.find(adapter => adapter.id === plan.adapter.id);
      if (JSON.stringify(adapter) !== JSON.stringify(plan.adapter)) throw new Error('网卡状态已变化，请重新检查后配置');
      if (!plan.needsChange) { await this.select(plan); this.plans.delete(id); return this.state(); }
      if (!await this.confirm({ action: 'add', adapterName: plan.adapter.name, adapterDescription: plan.adapter.description, address: plan.address, prefix: plan.prefix, host: plan.host })) {
        throw new Error('已取消修改网卡地址，网卡未改动');
      }
      const records = (await this.records()).filter(record => record.bootId === current.bootId);
      await this.save([...records, { bootId: current.bootId, plan }]);
      try { await this.dependencies.change(plan, false); }
      catch (error) { if (!(error instanceof NetworkAddressChangeError && error.needsRestore)) await this.save(records); throw error; }
      await this.select(plan); this.plans.delete(id); return await this.state();
    } finally { this.busy = false; }
  }
  async restore(id: string): Promise<Ma2NetworkSetupState> {
    if (this.busy) throw new Error('网卡正在配置，请等待完成');
    this.busy = true;
    try {
      const records = await this.records(); const record = records.find(record => record.plan.id === id);
      if (!record) throw new Error('找不到联动台添加的地址');
      const current = await this.dependencies.snapshot();
      if (record.bootId === current.bootId) {
        const adapter = current.adapters.find(adapter => adapter.id === record.plan.adapter.id);
        if (!adapter) throw new Error('原网卡不存在，请接回原网卡后恢复');
        if (!await this.confirm({ action: 'remove', adapterName: adapter.name, adapterDescription: adapter.description, address: record.plan.address, prefix: record.plan.prefix, host: record.plan.host })) {
          throw new Error('已取消移除网卡地址，网卡未改动');
        }
        await this.dependencies.change({ ...record.plan, adapter }, true);
      }
      this.plans.clear();
      await writeFileAtomically(`${this.path}.selections`, JSON.stringify((await this.selections()).filter(value => value.id !== id)));
      await this.save(records.filter(entry => entry.plan.id !== id)); return await this.state();
    } finally { this.busy = false; }
  }
}
