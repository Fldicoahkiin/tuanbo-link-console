import { ma2NetworkSetupPlanSchema, type Ma2NetworkSetupRequest, type Ma2NetworkSetupPlan, type Ma2NetworkSetupState } from '@tb/schema';

/** Inspect a target without changing Windows settings. */
export async function inspectMa2ComputerNetwork(request: Ma2NetworkSetupRequest, current: Ma2NetworkSetupState): Promise<Ma2NetworkSetupPlan | null> {
  if (request.host.startsWith('127.') || current.adapters.some(adapter => adapter.addresses.some(entry => entry.address === request.host))) return null;
  return ma2NetworkSetupPlanSchema.parse(await window.tbLink.planMa2NetworkSetup(request));
}
