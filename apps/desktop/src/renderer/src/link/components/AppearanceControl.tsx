import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
type Appearance = 'system' | 'dark' | 'light';
const key = 'tblink.appearance.v1';
export function AppearanceControl(): JSX.Element {
  const [appearance, setAppearance] = useState<Appearance>('dark');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === 'dark' || saved === 'light' || saved === 'system') setAppearance(saved);
      else if (saved !== null) setError('外观设置已损坏，已改用深色外观。');
    } catch (failure) { setError(`无法读取外观设置：${String(failure)}`); }
  }, []);
  const change = (value: string): void => {
    const next = value === 'dark' || value === 'light' ? value : 'system';
    const previous = appearance;
    setAppearance(next);
    try { localStorage.setItem(key, next); window.dispatchEvent(new Event('tblink-appearance-change')); setError(null); }
    catch (failure) { setAppearance(previous); setError(`外观没有保存成功，仍使用原来的外观：${String(failure)}`); }
  };
  return <div className="appearance-control"><div className="settings-choice-group" role="radiogroup" aria-label="外观">{([{ value: 'system', name: '跟随系统', icon: Monitor }, { value: 'light', name: '浅色', icon: Sun }, { value: 'dark', name: '深色', icon: Moon }] as const).map(({ value, name, icon: Icon }) => <label className="settings-choice" key={value}><input type="radio" name="appearance" checked={appearance === value} onChange={() => change(value)} /><span><Icon aria-hidden="true" /> {name}<span className={`settings-theme-sample theme-${value}`} aria-hidden="true"><i /><i /></span></span></label>)}</div><p className="settings-note" role="status">选择后立即生效，并保存在本机。</p>{error ? <p className="device-error" role="alert">{error}</p> : null}</div>;

}

export function useAppearanceTheme(): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const saved = localStorage.getItem(key);
      const suppression = document.createElement('style');
      suppression.textContent = '*,*::before,*::after{transition:none !important}';
      document.head.append(suppression);
      document.documentElement.dataset.theme = saved === 'system' ? media.matches ? 'dark' : 'light' : saved === 'light' ? 'light' : 'dark';
      void document.documentElement.offsetHeight;
      requestAnimationFrame(() => suppression.remove());
    };
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('tblink-appearance-change', apply);
    return () => { media.removeEventListener('change', apply); window.removeEventListener('tblink-appearance-change', apply); };
  }, []);
}
