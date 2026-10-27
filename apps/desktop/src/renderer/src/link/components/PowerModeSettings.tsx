import { useDisplayPreferences } from '../stores/display-preferences-store';

export function PowerModeSettings({ notify }: {
  notify: (message: string, tone?: 'info' | 'error') => void;
}): JSX.Element {
  const lowPower = useDisplayPreferences((state) => state.lowPower);
  return <><div className="settings-choice-group" role="radiogroup" aria-label="运行模式">{([{ value: false, title: '普通模式', help: '保留软件内画面预览和频谱。' }, { value: true, title: '低功耗模式', help: '关闭软件内预览和频谱，使用 OBS 监看。' }] as const).map(option => <label className="settings-choice" key={option.title}><input type="radio" name="power-mode" checked={lowPower === option.value} onChange={() => { try { useDisplayPreferences.getState().setLowPower(option.value); } catch (error) { notify(`运行模式保存失败：${String(error)}`, 'error'); } }} /><span>{option.title}<small>{option.help}</small></span></label>)}</div><p className="settings-note">低功耗时，时间线照常控制素材播放、定位和机位切换，随时可以切回普通模式恢复预览。</p></>;
}
