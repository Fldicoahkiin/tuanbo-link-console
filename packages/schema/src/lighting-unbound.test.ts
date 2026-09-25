import { expect, it } from 'vitest';
import { createLightingDocument, lightingDocumentSchema, lightingTemplateTrackSchema, lightingTrackSchema } from './lighting';

it('未绑定执行器的控台素材可以保存为模板，不能当作已绑定的时间线轨道', () => {
  const track = lightingTemplateTrackSchema.parse({
    id: 'library-track', name: '开场 Cue', kind: 'ma2', color: '#68c9ed', group: '', muted: false, solo: false, locked: false,
    channel: 1, portProfileId: '', controller: 7, noteNames: {}, clips: [], cueStamp: { mode: 'fixed', sequence: 168, cue: '1.000', executor: '' }
  });
  const document = lightingDocumentSchema.parse({ ...createLightingDocument(), templates: [{ id: 'library-item', name: '开场 Cue', track, sourceShow: '2hao' }] });
  expect(document.templates[0]?.track.cueStamp).toMatchObject({ sequence: 168, executor: '' });
  expect(lightingTrackSchema.safeParse(track).success).toBe(false);
  expect(lightingDocumentSchema.safeParse({ ...document, tracks: [track] }).success).toBe(false);
});
