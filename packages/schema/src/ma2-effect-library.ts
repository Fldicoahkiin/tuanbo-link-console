import { z } from 'zod';
import { ma2ObjectDirectorySchema } from './ma2-catalog';
import { lightingMa2CueCatalogSchema } from './lighting';

export const ma2EffectLibrarySchema = z.object({
  directory: ma2ObjectDirectorySchema,
  readAt: z.string().datetime(),
  fixtureDetails: z.enum(['included', 'unavailable']).optional(),
  sequences: lightingMa2CueCatalogSchema,
  fixtureUsage: z.array(z.object({ sequence: z.number().int().positive(), cueIndex: z.number().int().nonnegative(), fixtureIds: z.array(z.number().int().positive()).max(10000) }).strict()),
  errors: z.array(z.object({ sequence: z.number().int().positive(), message: z.string() }).strict())
}).strict();
export type Ma2EffectLibrary = z.infer<typeof ma2EffectLibrarySchema>;
