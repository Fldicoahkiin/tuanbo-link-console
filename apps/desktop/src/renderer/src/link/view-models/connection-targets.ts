import type { IntegrationProfile, LinkProject } from '@tb/schema';
import { collectCueMidiOutputProfileIds, collectLightingOutputProfileIds } from '@tb/core/link';
import { projectOutputsMtc } from './internal-audio-engine';

export type MidiConnectionTarget = { id: string; name: string; direction: 'input' | 'output'; required: boolean };

/** Native playback owns every output port; inputs still use the Web MIDI monitor. */
export function usesNativeMidiOutput(project: LinkProject | null, direction: 'input' | 'output'): boolean {
  return direction === 'output' && (!project || project.playbackSource === 'internal');
}

/** Every configured port and every port referenced by the show must remain visible. */
export function midiConnectionTargets(profile: IntegrationProfile | null, project: LinkProject | null): MidiConnectionTarget[] {
  const internal = project?.playbackSource === 'internal';
  const targets = new Map<string, MidiConnectionTarget>();
  const add = (id: string, name: string, direction: 'input' | 'output', required: boolean): void => {
    const previous = targets.get(id);
    targets.set(id, { id, name: previous ? `${previous.name} / ${name}` : name, direction, required: required || previous?.required === true });
  };
  add(profile?.p1.mtcInputPortProfileId ?? 'p1-mtc', 'P1 时间码输入', 'input', Boolean(project && !internal));
  add(profile?.p1.controlOutputPortProfileId ?? 'p1-output', 'P1 控制输出', 'output', Boolean(project && !internal));
  add(profile?.internalPlayer?.mtcOutputPortProfileId ?? 'internal-mtc-output', '灯光时间码输出', 'output', projectOutputsMtc(project));
  add(profile?.internalPlayer?.controlInputPortProfileId ?? 'internal-control-input', '播放控制输入', 'input', Boolean(profile?.internalPlayer?.controlInputPortProfileId));
  add('lighting-events-output', '灯光 Cue 输出', 'output', false);
  if (project) {
    const referenced = new Set(collectCueMidiOutputProfileIds(project));
    for (const item of project.rundown.filter(item => item.enabled)) {
      if (!internal && item.p1StartTrigger?.kind === 'p1.midiNotePulse') referenced.add(item.p1StartTrigger.portProfileId);
      if (item.lighting) for (const id of collectLightingOutputProfileIds(item.lighting)) referenced.add(id);
    }
    for (const id of referenced) {
      if (targets.has(id)) targets.set(id, { ...targets.get(id)!, required: true });
      else add(id, `Cue 输出 · ${id}`, 'output', true);
    }
  }
  for (const port of profile?.midiPortProfiles ?? []) {
    if (!targets.has(port.id) && port.portName) add(port.id, `MIDI ${port.direction === 'input' ? '输入' : '输出'} · ${port.portName}`, port.direction, true);
    else if (port.portName && targets.has(port.id)) targets.set(port.id, { ...targets.get(port.id)!, required: true });
  }
  return [...targets.values()];
}
