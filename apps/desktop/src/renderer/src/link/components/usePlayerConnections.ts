import { useEffect, useState } from 'react';
import { mtcOutputSettings, type MtcSendMode } from '@tb/core/link';
import type { IntegrationProfile } from '@tb/schema';
import { useIntegrationStore } from '../stores/integration-store';
import { linkDesktopViewModel } from '../view-models/link-desktop-view-model';
import { midiOutputInventory, readNativeDevices } from '../view-models/midi-device-inventory';
import { createDefaultIntegrationProfile } from '../view-models/local-integration-profile';

export type PlayerConnectionField = 'audio' | 'rate' | 'remote' | 'mtc' | 'mode';
type Notify = (message: string, tone?: 'info' | 'error') => void;

const MTC_OUTPUT = 'internal-mtc-output';
const CONTROL_INPUT = 'internal-control-input';

/** The player's sound device, sample rate, timecode port and send mode, and remote input, as saved on this computer. */
function playerConnections(profile: IntegrationProfile) {
  const player = profile.internalPlayer;
  return {
    portName: mtcOutputSettings(profile).portName ?? '',
    deviceId: player?.nativeAudioOutputDeviceId ?? 'default',
    controlName: profile.midiPortProfiles.find(entry => entry.id === player?.controlInputPortProfileId)?.portName ?? '',
    audioSampleRate: player?.audioSampleRate ?? 48000
  };
}

/**
 * Reads and saves the internal player's connections (音频与 MIDI and 时间码 pages). Each change is
 * saved on this computer at once; `saved` names the field just saved, for two seconds.
 * `watchDevices` reads the Windows device list now and whenever a device is plugged in or out.
 */
export function usePlayerConnections({ disabled, notify, onBusy, watchDevices = false }: { disabled: boolean; notify: Notify; onBusy: (busy: boolean) => void; watchDevices?: boolean }) {
  const profile = useIntegrationStore(state => state.profile);
  const ports = useIntegrationStore(state => state.midiPorts);
  const nativeDevices = useIntegrationStore(state => state.nativeDevices);
  const nativeError = useIntegrationStore(state => state.nativeDeviceError);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<PlayerConnectionField | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { if (!saved) return; const timer = setTimeout(() => setSaved(null), 2000); return () => clearTimeout(timer); }, [saved]);
  useEffect(() => {
    if (!watchDevices) return;
    let cancelled = false;
    const refresh = (): void => { void readNativeDevices().catch((failure: unknown) => { if (!cancelled) notify(String(failure), 'error'); }); };
    refresh(); navigator.mediaDevices.addEventListener('devicechange', refresh);
    return () => { cancelled = true; navigator.mediaDevices.removeEventListener('devicechange', refresh); };
  }, [notify, watchDevices]);

  const write = async (field: PlayerConnectionField, change: (current: IntegrationProfile) => IntegrationProfile): Promise<void> => {
    if (disabled || saving) return;
    setSaving(true); onBusy(true); setError('');
    try {
      const current = useIntegrationStore.getState().profile ?? createDefaultIntegrationProfile();
      const next = { ...change(current), updatedAt: new Date().toISOString() };
      await linkDesktopViewModel.saveIntegrationProfile({ profile: next });
      useIntegrationStore.getState().setProfile(next);
      setSaved(field);
    } catch (failure) { setError(String(failure)); notify(String(failure), 'error'); }
    finally { setSaving(false); onBusy(false); }
  };
  const route = (field: PlayerConnectionField, patch: Partial<ReturnType<typeof playerConnections>>): Promise<void> => write(field, current => {
    const { portName, deviceId, controlName, audioSampleRate } = { ...playerConnections(current), ...patch };
    return { ...current,
      internalPlayer: { audioOutputDeviceId: 'default', ...current.internalPlayer, audioEngine: 'native' as const, audioSampleRate, doubleClickPlayback: current.internalPlayer?.doubleClickPlayback ?? false,
        controlInputPortProfileId: controlName ? CONTROL_INPUT : null, nativeAudioOutputDeviceId: deviceId, mtcOutputPortProfileId: portName ? MTC_OUTPUT : null },
      midiPortProfiles: [...current.midiPortProfiles.filter(entry => entry.id !== MTC_OUTPUT && entry.id !== CONTROL_INPUT),
        ...(controlName ? [{ id: CONTROL_INPUT, direction: 'input' as const, portName: controlName }] : []),
        ...(portName ? [{ id: MTC_OUTPUT, direction: 'output' as const, portName }] : [])] };
  });

  const current = profile ? playerConnections(profile) : { portName: '', deviceId: 'default', controlName: '', audioSampleRate: 48000 as const };
  const inputs = ports.filter(port => port.direction === 'input' && port.state === 'connected').map(port => port.name);
  return {
    profile, nativeError, saving, saved, error,
    ...current,
    sendMode: profile?.internalPlayer?.mtcSendMode ?? 'standard' as MtcSendMode,
    outputs: midiOutputInventory(nativeDevices, current.portName),
    audioDevices: nativeDevices?.audio.map(device => ({ id: device.id, name: device.name })) ?? [],
    controlInputs: [...new Set([...inputs, ...(current.controlName ? [current.controlName] : [])])].map(name => ({ name, available: inputs.includes(name) })),
    setAudioDevice: (deviceId: string) => route('audio', { deviceId }),
    setSampleRate: (audioSampleRate: 44100 | 48000) => route('rate', { audioSampleRate }),
    setMtcPort: (portName: string) => route('mtc', { portName }),
    setControlInput: (controlName: string) => route('remote', { controlName }),
    setSendMode: (mtcSendMode: MtcSendMode) => write('mode', current => ({ ...current,
      internalPlayer: { audioOutputDeviceId: 'default', mtcOutputPortProfileId: null, ...current.internalPlayer, mtcSendMode } }))
  };
}
