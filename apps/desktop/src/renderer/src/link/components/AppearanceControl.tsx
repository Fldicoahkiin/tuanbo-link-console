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
      else if (saved !== null) setError('外观设置无效，已使用深色外观。');
    } catch (failure) { setError(`无法读取外观设置：${String(failure)}`); }
  }, []);
  const change = (value: string): void => {
    const next = value === 'dark' || value === 'light' ? value : 'system';
    setAppearance(next);
    try { localStorage.setItem(key, next); window.dispatchEvent(new Event('tblink-appearance-change')); setError(null); }
    catch (failure) { setError(`外观已切换，但无法保存：${String(failure)}`); }
  };
  return <div className="appearance-control"><label>{appearance === 'light' ? <Sun /> : appearance === 'dark' ? <Moon /> : <Monitor />}<span>外观</span><select aria-label="外观" value={appearance} onChange={(event) => change(event.currentTarget.value)}><option value="system">跟随系统</option><option value="light">浅色 · 白</option><option value="dark">深色 · 黑</option></select></label>{error ? <small role="alert">{error}</small> : null}</div>;
}

export function useAppearanceTheme(): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = (): void => {
      const saved = localStorage.getItem(key);
      document.documentElement.dataset.theme = saved === 'system' ? media.matches ? 'dark' : 'light' : saved === 'light' ? 'light' : 'dark';
    };
    apply();
    media.addEventListener('change', apply);
    window.addEventListener('tblink-appearance-change', apply);
    return () => { media.removeEventListener('change', apply); window.removeEventListener('tblink-appearance-change', apply); };
  }, []);
}
