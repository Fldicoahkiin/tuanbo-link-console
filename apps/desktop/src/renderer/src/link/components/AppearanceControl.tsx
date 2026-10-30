import { useEffect, useState } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import { Card, ChoiceGroup, Notice } from '../ui';

type Appearance = 'system' | 'dark' | 'light';
const key = 'tblink.appearance.v1';
/** 界面外观: dark, light or the system's, saved on this computer and applied at once. */
export function AppearanceControl(): JSX.Element {
  const [appearance, setAppearance] = useState<Appearance>('dark');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem(key);
      if (saved === 'dark' || saved === 'light' || saved === 'system') setAppearance(saved);
      else if (saved !== null) setError('外观设置读不出来，先用深色外观。重新选一次就好。');
    } catch (failure) { setError(`读不到外观设置：${String(failure)}`); }
  }, []);
  const change = (next: Appearance): void => {
    const previous = appearance;
    setAppearance(next);
    try { localStorage.setItem(key, next); window.dispatchEvent(new Event('tblink-appearance-change')); setError(null); }
    catch (failure) { setAppearance(previous); setError(`外观没有保存成功，仍用原来的外观：${String(failure)}`); }
  };
  return <Card>
    <ChoiceGroup label="外观" value={appearance} onChange={change} choices={([
      { value: 'system', title: '跟随系统', icon: Monitor },
      { value: 'light', title: '浅色', icon: Sun },
      { value: 'dark', title: '深色', icon: Moon }
    ] as const).map(choice => ({ ...choice, preview: <span className="settings-theme-sample" data-sample={choice.value}><i /><i /></span> }))} />
    <p>选好立即生效，保存在这台电脑上。</p>
    {error ? <Notice tone="error">{error}</Notice> : null}
  </Card>;
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
