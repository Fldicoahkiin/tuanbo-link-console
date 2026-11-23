import { create } from 'zustand';
import { ma2ConsoleChangesSchema, ma2ExecutorChannelKindSchema, ma2WriteModeSchema, type Ma2ConsoleChanges, type Ma2ExecutorChannelKind, type Ma2WriteMode } from '@tb/schema';

const key = 'tblink.ma2-realtime-enabled.v1';
const writeKey = 'tblink.ma2-write-mode.v1';
const changesKey = 'tblink.ma2-console-changes.v1';
const stored = (name: string): string | null => typeof localStorage === 'undefined' ? null : localStorage.getItem(name);

/**
 * The workbench starts idle on every launch, including upgrades from automatic sync.
 * The saved write and read-back policies apply to the next requested sync.
 * A one-time request records its start and the selected song until confirmation or cancellation.
 */
export const useMa2RealtimePreference = create<{ enabled: boolean; once: number | null; onceItemId: string | null; writeMode: Ma2WriteMode; consoleChanges: Ma2ConsoleChanges }>(() => ({
  enabled: false,
  once: null, onceItemId: null,
  writeMode: ma2WriteModeSchema.catch('merge').parse(stored(writeKey)),
  consoleChanges: ma2ConsoleChangesSchema.catch('read-back').parse(stored(changesKey))
}));
export function setMa2RealtimeEnabled(enabled: boolean): void {
  localStorage.setItem(key, String(enabled));
  useMa2RealtimePreference.setState({ enabled, once: null, onceItemId: null });
}
export function setMa2WriteMode(writeMode: Ma2WriteMode): void {
  localStorage.setItem(writeKey, writeMode);
  useMa2RealtimePreference.setState({ writeMode });
}
export function setMa2ConsoleChanges(consoleChanges: Ma2ConsoleChanges): void {
  localStorage.setItem(changesKey, consoleChanges);
  useMa2RealtimePreference.setState({ consoleChanges });
}
const cueTrackingKey = 'tblink.ma2-copy-tracking.v1';
export const useCueTrackingPreference = create<{ includeTracking: boolean | undefined }>(() => ({
  includeTracking: stored(cueTrackingKey) === null ? undefined : stored(cueTrackingKey) === 'true'
}));
export function setCueTrackingPreference(includeTracking: boolean): void {
  localStorage.setItem(cueTrackingKey, String(includeTracking));
  useCueTrackingPreference.setState({ includeTracking });
}
const keyChannelKey = 'tblink.ma2-key-channel.v1';
/**
 * The line this computer's operator chose for executor Button area keys (M7), kept like the sync choices above. First
 * use is the console plugin, as in 0.5.8; the web remote is opt-in until it is checked on the site's console.
 */
export const useMa2KeyChannelPreference = create<{ choice: Ma2ExecutorChannelKind }>(() => ({
  choice: ma2ExecutorChannelKindSchema.catch('plugin').parse(stored(keyChannelKey))
}));
export function setMa2KeyChannelChoice(choice: Ma2ExecutorChannelKind): void {
  localStorage.setItem(keyChannelKey, choice);
  useMa2KeyChannelPreference.setState({ choice });
}
/** Real-time sync is on, or a one-time pass is running. */
export function ma2SyncActive(): boolean {
  const preference = useMa2RealtimePreference.getState();
  return preference.enabled || preference.once !== null;
}

/** A manual request stays on the selected song, including from the sidebar. */
export function ma2SongSyncActive(itemId: string): boolean {
  const preference = useMa2RealtimePreference.getState();
  return preference.enabled || preference.once !== null && (!preference.onceItemId || preference.onceItemId === itemId);
}
