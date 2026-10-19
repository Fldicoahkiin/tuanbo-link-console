import { ma2NetworkSetupPlanSchema, ma2NetworkSetupStateSchema, type Ma2NetworkSetupPlan, type Ma2NetworkSetupRequest, type Ma2NetworkSetupState } from '@tb/schema';

type Observer = { progress?: (text: string) => void; state?: (state: Ma2NetworkSetupState) => void; plan?: (plan: Ma2NetworkSetupPlan | null) => void };

/** Shared by the top connect button and device settings. Only explicit connect applies a plan. */
export async function prepareMa2ComputerNetwork(host: string, options: Partial<Omit<Ma2NetworkSetupRequest, 'host'>> = {}, observer: Observer = {}): Promise<void> {
  observer.progress?.('正在检查电脑网卡与控台 IP…');
  const current = ma2NetworkSetupStateSchema.parse(await window.tbLink.getMa2NetworkSetup());
  observer.state?.(current); observer.plan?.(null);
  if (host.startsWith('127.') || current.adapters.some(adapter => adapter.addresses.some(entry => entry.address === host))) {
    observer.progress?.(`使用本机 onPC ${host}，无需修改网卡`); return;
  }
  const proposal = ma2NetworkSetupPlanSchema.parse(await window.tbLink.planMa2NetworkSetup({ host, prefix: options.prefix ?? 24, ...options }));
  observer.plan?.(proposal); observer.progress?.(proposal.needsChange ? `${proposal.message} 请允许 Windows 管理员授权。` : proposal.message);
  try {
    // Also persist a reused address, so reconnect uses the same interface after app restart.
    const applied = ma2NetworkSetupStateSchema.parse(await window.tbLink.applyMa2NetworkSetup(proposal.id));
    observer.state?.(applied);
  } catch (error) {
    observer.plan?.(null);
    throw error;
  }
}
