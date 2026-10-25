import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useDisplayPreferences } from './display-preferences-store';

let entries: Map<string, string>;
beforeEach(() => {
  entries = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, value: string) => entries.set(key, value) });
  useDisplayPreferences.setState({ lowPower: false, preciseSeeking: true, loaded: false });
});
afterEach(() => vi.unstubAllGlobals());

it('默认普通模式；旧版保存的低功耗选择升级后不沿用', () => {
  entries.set('tblink.low-power', 'true');
  useDisplayPreferences.getState().load();
  expect(useDisplayPreferences.getState().lowPower).toBe(false);
});

it('选择低功耗后保存在本机，重启后仍为低功耗；切回普通模式同样保存', () => {
  useDisplayPreferences.getState().setLowPower(true);
  useDisplayPreferences.setState({ lowPower: false, loaded: false }); useDisplayPreferences.getState().load();
  expect(useDisplayPreferences.getState().lowPower).toBe(true);
  useDisplayPreferences.getState().setLowPower(false);
  useDisplayPreferences.setState({ lowPower: true, loaded: false }); useDisplayPreferences.getState().load();
  expect(useDisplayPreferences.getState().lowPower).toBe(false);
});
