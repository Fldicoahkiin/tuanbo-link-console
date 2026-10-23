import { useEffect, useState } from 'react';
import type { LightingDocument, RundownItem } from '@tb/schema';
import { LightingCueAudition } from '../../registry/lighting-cue-audition';
import { useIntegrationStore } from '../stores/integration-store';
import { recordRuntimeOperator, reportCoordinatorError } from '../runtime/runtime-action-log';
import { readMa2Method } from '../stores/ma2-mode-store';

export function useLightingCueAudition(document: LightingDocument, projectId: string | undefined, item: RundownItem | null, notify: (message: string, tone?: 'info' | 'error') => void) {
  const [output] = useState(() => new LightingCueAudition());
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState('选中灯光 Cue 即发送到控台');
  useEffect(() => () => output.cancel(), [output, projectId, item?.id, enabled]);
  const select = (eventId: string, template = false): void => {
    // Clicking a library Cue is an explicit audition, independent of timeline-selection preview.
    if (!projectId || !template && !enabled) return;
    const event = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(entry => entry.id === eventId);
    if (!template && event?.kind !== 'ma2') { output.cancel(); setStatus(event?.kind === 'empty-cue' ? '空 Cue · 不发送灯光指令' : '所选事件不是控台 Cue'); return; }
    setStatus('正在发送 Cue…');
    const viaNetwork = readMa2Method() === 'network';
    const operation = template ? output.playTemplate(document, eventId, useIntegrationStore.getState().profile) : output.play(document, eventId, useIntegrationStore.getState().profile, viaNetwork);
    void operation.then(async count => {
      if (!count) return;
      const network = template || document.ma2Bindings?.some(binding => binding.nativeEvents?.length || binding.playback === 'native-timecode') || viaNetwork || document.tracks.some(track => track.clips.some(clip => clip.events.some(entry => entry.kind === 'ma2' && !entry.executor && (entry.id === eventId || entry.effectGroupId === eventId))));
      setStatus(network ? `已发送 ${count} 条网络 Cue 指令` : `已发送 ${count} 条 Cue 指令（MIDI 无回执）`);
      await recordRuntimeOperator(projectId, item ?? undefined, '选中灯光 Cue，已发送调用指令', { eventId, count });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message); notify(message, 'error'); reportCoordinatorError(message, failure => notify(failure, 'error'));
    });
  };
  return { enabled, setEnabled, status, select: (id: string) => select(id), selectTemplate: (id: string) => select(id, true) };
}
