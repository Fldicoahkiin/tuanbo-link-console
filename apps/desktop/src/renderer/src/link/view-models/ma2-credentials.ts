import type { Ma2NetworkSettings } from '@tb/schema';

/** A changed target uses its own saved credential or the explicitly shown MA factory default. */
export function ma2CredentialsForTarget(profiles: Ma2NetworkSettings[], target: Pick<Ma2NetworkSettings, 'host' | 'port' | 'monitorPort' | 'username'>): { password: string; edited: boolean } {
  if (profiles.some(profile => profile.host === target.host && profile.port === target.port && profile.monitorPort === target.monitorPort && profile.username === target.username)) return { password: '', edited: false };
  return { password: target.username === 'administrator' ? 'admin' : '', edited: true };
}
