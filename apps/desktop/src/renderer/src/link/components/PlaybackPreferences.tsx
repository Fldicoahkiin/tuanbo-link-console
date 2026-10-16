import { SettingsGroup, SettingsSwitch } from './SettingsControls';
import { setInternalVideoAudioCommand } from '@tb/core/link';
import { useDocumentStore } from '../stores/document-store';
import { useState } from 'react';
import type { IntegrationProfile } from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { PropertyNumberInput } from './PropertyNumberInput';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';

export function PlaybackPreferences({ disabled, notify }: { disabled: boolean; notify: (message: string, tone?: 'info' | 'error') => void }): JSX.Element {
  const project = useDocumentStore((state) => state.project);
  const profile = useIntegrationStore((state) => state.profile);
  const ready = useIntegrationStore((state) => state.initialized && state.securityAvailable && state.error === null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const save = async (patch: Partial<NonNullable<IntegrationProfile['internalPlayer']>>): Promise<void> => {
    if (!ready) return; setBusy(true); setError('');
    try {
      const current = profile ?? createDefaultIntegrationProfile();
      const next = { ...current, updatedAt: new Date().toISOString(), internalPlayer: { audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, ...current.internalPlayer, ...patch } };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next }); useIntegrationStore.getState().setProfile(next); setFeedback('已保存到本机');
    } catch (error) { setError(`保存失败：${String(error)}。请重试。`); notify(String(error), 'error'); } finally { setBusy(false); }
  };
  return <fieldset disabled={disabled || busy || !ready} className="settings-form">
    <SettingsGroup title="操作方式">
      <SettingsSwitch label="双击歌曲播放" help="开启后，单击只选中歌曲" checked={profile?.internalPlayer?.doubleClickPlayback ?? false} onChange={event => void save({ doubleClickPlayback: event.currentTarget.checked })} />
      <SettingsSwitch label="方向键切歌" aria-label="方向键立即播放上一首 / 下一首" help="按方向键立即播放上一首或下一首" checked={profile?.internalPlayer?.arrowKeyPlayback ?? false} onChange={event => void save({ arrowKeyPlayback: event.currentTarget.checked })} />
    </SettingsGroup>
    <SettingsGroup title="音频准备"><SettingsSwitch label="预加载音频" checked={profile?.internalPlayer?.preload ?? true} onChange={event => void save({ preload: event.currentTarget.checked })} /></SettingsGroup>
    <SettingsGroup title="淡入淡出">
    <label className="settings-row"><span>淡入时长<small>单位：秒，0 表示关闭</small></span><PropertyNumberInput key={String(busy)} label="淡入时长（秒，0 为关闭）" min={0} max={30} step={0.1} value={(profile?.internalPlayer?.fadeInMs ?? 0) / 1000} onCommit={(seconds) => void save({ fadeInMs: Math.round(seconds * 1000) })} /></label>
    <label className="settings-row"><span>淡出时长<small>单位：秒</small></span><PropertyNumberInput key={String(busy)} label="淡出时长（秒）" min={0} max={30} step={0.1} value={(profile?.internalPlayer?.fadeOutMs ?? 500) / 1000} onCommit={(seconds) => void save({ fadeOutMs: Math.round(seconds * 1000) })} /></label>
    </SettingsGroup>
    <SettingsGroup title="视频原声" description="工程设置，随当前工程保存。"><SettingsSwitch label="视频素材原声" aria-label="同时播放视频素材原声" checked={project?.internalVideoAudio === true} onChange={event => { useDocumentStore.getState().execute(setInternalVideoAudioCommand(event.currentTarget.checked)); setFeedback('已应用到工程，请保存工程文件'); }} /></SettingsGroup>
    <p className="settings-note settings-save-feedback" role="status">{busy ? '正在保存…' : feedback}</p>
    {error ? <p role="alert" className="device-error">{error}</p> : null}
  </fieldset>;
}
