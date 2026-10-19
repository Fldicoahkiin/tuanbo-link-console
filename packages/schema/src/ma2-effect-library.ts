import { z } from 'zod';
import { ma2ObjectDirectorySchema } from './ma2-catalog';
import { lightingMa2CueCatalogSchema } from './lighting';
import { ma2CueAttributesSchema } from './ma2-cue-attributes';

export const ma2EffectLibrarySchema = z.object({
  directory: ma2ObjectDirectorySchema,
  readAt: z.string().datetime(),
  incomplete: z.string().optional(),
  sourceUnverified: z.boolean().optional(),
  fixtureDetails: z.enum(['included', 'unavailable']).optional(),
  cueAttributes: z.array(ma2CueAttributesSchema).max(100000).optional(),
  sequences: lightingMa2CueCatalogSchema,
  fixtureUsage: z.array(z.object({ sequence: z.number().int().positive(), cueIndex: z.number().int().nonnegative(), fixtureIds: z.array(z.number().int().positive()).max(10000) }).strict()),
  errors: z.array(z.object({ sequence: z.number().int().positive(), message: z.string() }).strict())
}).strict();
export type Ma2EffectLibrary = z.infer<typeof ma2EffectLibrarySchema>;
