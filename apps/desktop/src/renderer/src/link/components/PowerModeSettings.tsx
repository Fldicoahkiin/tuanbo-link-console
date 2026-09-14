import { useDisplayPreferences } from '../stores/display-preferences-store';

export function PowerModeSettings({ notify }: {
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  const lowPower = useDisplayPreferences((state) => state.lowPower);
  return <><label className="settings-row"><span>运行模式</span>
    <select aria-label="运行模式" value={lowPower ? 'low-power' : 'normal'} onChange={(event) => {
      try { useDisplayPreferences.getState().setLowPower(event.currentTarget.value === 'low-power'); }
      catch (error) { notify(`运行模式保存失败：${String(error)}`, 'error'); }
    }}><option value="normal">普通模式</option><option value="low-power">低功耗模式</option></select>
  </label><p className="settings-note">低功耗模式关闭软件内画面预览和频谱，使用 OBS 监看；时间线仍控制素材播放、定位和机位切换。</p></>;
}
