import { z } from 'zod';

/** Beats per effect cycle a step can follow the song with: the beat divisions of the material library. */
export const lightingEffectBeats = [0.25, 0.5, 1, 2, 4, 8, 16, 32] as const;
/** Effect speeds the app writes to a console step, in BPM (effect cycles per minute). */
export const LIGHTING_EFFECT_BPM = { min: 0.1, max: 999 } as const;
export const lightingEffectBpmSchema = z.number().finite().min(LIGHTING_EFFECT_BPM.min, `效果速度不能低于 ${LIGHTING_EFFECT_BPM.min} BPM`).max(LIGHTING_EFFECT_BPM.max, `效果速度不能高于 ${LIGHTING_EFFECT_BPM.max} BPM`);
/**
 * The effect speed a Cue step runs at on the console: a fixed BPM, or the song's tempo at the step
 * with one effect cycle every `beats` beats. Without one, the step keeps the speed its material has.
 */
export const lightingEffectSpeedSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('fixed'), bpm: lightingEffectBpmSchema }).strict(),
  z.object({ mode: z.literal('song'), beats: z.literal(lightingEffectBeats) }).strict()
]);
export type LightingEffectSpeed = z.infer<typeof lightingEffectSpeedSchema>;
