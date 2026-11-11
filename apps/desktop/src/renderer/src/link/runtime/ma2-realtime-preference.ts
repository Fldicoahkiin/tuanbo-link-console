import { create } from 'zustand';
import { ma2ConsoleChangesSchema, ma2ExecutorChannelKindSchema, ma2WriteModeSchema, type Ma2ConsoleChanges, type Ma2ExecutorChannelKind, type Ma2WriteMode } from '@tb/schema';

const key = 'tblink.ma2-realtime-enabled.v1';
const writeKey = 'tblink.ma2-write-mode.v1';
const changesKey = 'tblink.ma2-console-changes.v1';
const stored = (name: string): string | null => typeof localStorage === 'undefined' ? null : localStorage.getItem(name);

/**
 * How this computer syncs with the console. A deliberate pause survives restart; first use is
 * enabled. The write mode and what happens to console edits (2026-11-04) are the operator's choice
 * too, kept the same way; first use merges and reads console edits back, as before. `once`: when the
 * one pass asked for while real-time sync is off began, until every song was synced once.
 */
export const useMa2RealtimePreference = create<{ enabled: boolean; once: number | null; writeMode: Ma2WriteMode; consoleChanges: Ma2ConsoleChanges }>(() => ({
  enabled: stored(key) !== 'false',
  once: null,
  writeMode: ma2WriteModeSchema.catch('merge').parse(stored(writeKey)),
  consoleChanges: ma2ConsoleChangesSchema.catch('read-back').parse(stored(changesKey))
}));
export function setMa2RealtimeEnabled(enabled: boolean): void {
  localStorage.setItem(key, String(enabled));
  useMa2RealtimePreference.setState({ enabled, once: null });
}
export function setMa2WriteMode(writeMode: Ma2WriteMode): void {
  localStorage.setItem(writeKey, writeMode);
  useMa2RealtimePreference.setState({ writeMode });
}
export function setMa2ConsoleChanges(consoleChanges: Ma2ConsoleChanges): void {
  localStorage.setItem(changesKey, consoleChanges);
  useMa2RealtimePreference.setState({ consoleChanges });
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
