import { describe, it, expect } from 'vitest';
import { createEmptyLinkProject, parseLinkProject } from '@tb/schema';
import { internalSeekState } from './internal-timeline';

describe('完整场景定位', () => {
  it('只恢复最后有效场景，不补发历史 MIDI，不切到未来或停用的场景', () => {
    const project = parseLinkProject({ ...createEmptyLinkProject('场景定位'), obsOutputMode: 'scenes', rundown: [{ id: 'song', title: '歌', cues: [0, 3, 5, 9].map((second) => ({
      id: `cue-${second}`, name: `场景${second}`, enabled: second !== 5, timecode: { hours: 0, minutes: 0, seconds: second, frames: 0 },
      actions: [{ id: `scene-${second}`, label: '场景', kind: 'obs.setProgramScene', sceneName: `Scene ${second}` }, { id: `midi-${second}`, label: '灯光', kind: 'midi.noteOn', portProfileId: 'lights', channel: 1, note: 60, velocity: 127 }]
    })) }] });
    const result = internalSeekState(project, 'song', 7000);
    expect(result.media).toEqual([]); expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.cue.actions).toEqual([{ id: 'scene-3', label: '场景', kind: 'obs.setProgramScene', sceneName: 'Scene 3' }]);
  });
});
