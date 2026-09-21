import { useEffect, useState } from 'react';
import type { LightingDocument, RundownItem } from '@tb/schema';
import { LightingCueAudition } from '../../registry/lighting-cue-audition';
import { useIntegrationStore } from '../stores/integration-store';
import { recordRuntimeOperator, reportCoordinatorError } from '../runtime/runtime-action-log';

export function useLightingCueAudition(document: LightingDocument, projectId: string | undefined, item: RundownItem | null, notify: (message: string, tone?: 'info' | 'error') => void) {
  const [output] = useState(() => new LightingCueAudition());
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState('选中灯光 Cue 即发送到控台');
  useEffect(() => () => output.cancel(), [output, projectId, item?.id, enabled]);
  const select = (eventId: string): void => {
    if (!enabled || !projectId) return;
    const event = document.tracks.flatMap(track => track.clips.flatMap(clip => clip.events)).find(entry => entry.id === eventId);
    if (event?.kind !== 'ma2') { output.cancel(); setStatus('所选事件不是控台 Cue'); return; }
    setStatus('正在发送 Cue…');
    void output.play(document, eventId, useIntegrationStore.getState().profile).then(async count => {
      if (!count) return;
      setStatus(`已发送 ${count} 条 Cue 指令（MIDI 无回执）`);
      await recordRuntimeOperator(projectId, item ?? undefined, '选中灯光 Cue，已发送 MIDI', { eventId, count });
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message); notify(message, 'error'); reportCoordinatorError(message, failure => notify(failure, 'error'));
    });
  };
  return { enabled, setEnabled, status, select };
}
