import { expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, lightingTemplateTrackSchema, lightingTrackSchema, lightingEventSchema } from './lighting';

it('未绑定执行器的控台素材可以保存为模板，也可以保存到时间线', () => {
  const track = lightingTemplateTrackSchema.parse({
    id: 'library-track', name: '开场 Cue', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false,
    channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: 168, cue: '1.000', executor: '' }
  });
  const document = lightingDocumentSchema.parse({ ...createLightingDocument(), templates: [{ id: 'library-item', name: '开场 Cue', track, sourceShow: '2hao' }] });
  expect(document.templates[0]?.track.cueStamp).toMatchObject({ sequence: 168, executor: '' });
  expect(lightingTrackSchema.safeParse(track).success).toBe(true);
  expect(lightingDocumentSchema.safeParse({ ...document, tracks: [track] }).success).toBe(true);
});

it('空执行器只能保存明确的序列池 Cue，不能保存无目标的下一步或关闭', () => {
  const event = { id: 'pool', kind: 'ma2', at: 0, label: '开场', sequence: 168, cue: '1.250', executor: '', action: 'goto' };
  expect(lightingEventSchema.safeParse(event).success).toBe(true);
  expect(lightingEventSchema.safeParse({ ...event, sequence: undefined }).success).toBe(false);
  for (const action of ['go', 'off']) expect(lightingEventSchema.safeParse({ ...event, action }).success).toBe(false);
});
