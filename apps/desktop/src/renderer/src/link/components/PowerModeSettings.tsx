import { useDisplayPreferences } from '../stores/display-preferences-store';
import { Card, ChoiceGroup } from '../ui';

/** 监看与性能: whether this window draws the picture preview and spectrum, saved on this computer. */
export function PowerModeSettings({ notify }: { notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const lowPower = useDisplayPreferences(state => state.lowPower);
  return <Card>
    <ChoiceGroup label="运行模式" value={lowPower ? 'low' : 'normal'} onChange={mode => {
      try { useDisplayPreferences.getState().setLowPower(mode === 'low'); }
      catch (failure) { notify(`运行模式没有保存成功：${String(failure)}`, 'error'); }
    }} choices={[
      { value: 'normal', title: '普通模式', help: '保留软件里的画面预览和频谱。' },
      { value: 'low', title: '低功耗模式', help: '关闭软件里的预览和频谱，用 OBS 监看。' }
    ]} />
    <p>低功耗时，时间线照常控制素材播放、定位和机位切换；随时可以切回普通模式恢复预览。</p>
  </Card>;
}
