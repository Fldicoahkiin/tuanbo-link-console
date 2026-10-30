import { useState } from 'react';
import type { IntegrationProfile } from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';
import { Card, Field, Switch } from '../ui';
import { PropertyNumberInput } from './PropertyNumberInput';

/** 播放习惯: how songs are started and faded on this computer. The project's own choices are on 播放主控. */
export function PlaybackPreferences({ disabled, notify }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const profile = useIntegrationStore(state => state.profile);
  const ready = useIntegrationStore(state => state.initialized && state.securityAvailable && state.error === null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  const locked = disabled || busy || !ready;
  const player = profile?.internalPlayer;
  const save = async (patch: Partial<NonNullable<IntegrationProfile['internalPlayer']>>): Promise<void> => {
    if (locked) return;
    setBusy(true); setError(''); setSaved(false);
    try {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const next = { ...current, updatedAt: new Date().toISOString(), internalPlayer: { audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, ...current.internalPlayer, ...patch } };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setSaved(true);
    } catch (failure) { setError(`没有保存成功：${String(failure)}。请再试一次。`); notify(String(failure), 'error'); }
    finally { setBusy(false); }
  };
  return <>
    <Card title="操作方式">
      <Switch label="双击歌曲播放" help="打开后，单击只选中歌曲" disabled={locked} checked={player?.doubleClickPlayback ?? false} onChange={event => void save({ doubleClickPlayback: event.currentTarget.checked })} />
      <Switch label="方向键切歌" aria-label="方向键立即播放上一首 / 下一首" help="按方向键立即播放上一首或下一首" disabled={locked} checked={player?.arrowKeyPlayback ?? false} onChange={event => void save({ arrowKeyPlayback: event.currentTarget.checked })} />
      <Switch label="预加载音频" help="播放时提前准备下一首，切歌更快" disabled={locked} checked={player?.preload ?? true} onChange={event => void save({ preload: event.currentTarget.checked })} />
    </Card>
    <Card title="淡入淡出" description="点“淡入”“淡出”按钮时用的时长。">
      <Field label="淡入时长" help="单位秒，0 表示不淡入">{props => <PropertyNumberInput {...props} key={String(busy)} className="ui-input" label="淡入时长（秒，0 为关闭）" min={0} max={30} step={0.1} disabled={locked} value={(player?.fadeInMs ?? 0) / 1000} onCommit={seconds => void save({ fadeInMs: Math.round(seconds * 1000) })} />}</Field>
      <Field label="淡出时长" help="单位秒">{props => <PropertyNumberInput {...props} key={String(busy)} className="ui-input" label="淡出时长（秒）" min={0} max={30} step={0.1} disabled={locked} value={(player?.fadeOutMs ?? 500) / 1000} onCommit={seconds => void save({ fadeOutMs: Math.round(seconds * 1000) })} />}</Field>
    </Card>
    <p className="settings-saved" role="status">{busy ? '正在保存…' : saved ? '已保存到本机' : ''}</p>
    {error ? <p className="settings-error" role="alert">{error}</p> : null}
  </>;
}
