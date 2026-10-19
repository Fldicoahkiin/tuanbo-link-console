import { z } from 'zod';

export const ma2AttributeRoleSchema = z.enum(['intensity', 'position', 'gobo', 'color', 'beam', 'focus', 'control', 'shapers', 'video', 'shutter', 'effect', 'other', 'unresolved', 'unwritten']);
export type Ma2AttributeRole = z.infer<typeof ma2AttributeRoleSchema>;
export const ma2AttributeGroupSchema = z.object({
  attribute: z.string().min(1).max(128), attributeName: z.string().min(1).max(128),
  presetType: z.string().min(1).max(128), presetName: z.string().min(1).max(128),
  feature: z.string().min(1).max(128), featureName: z.string().min(1).max(128)
}).strict();
export type Ma2AttributeGroup = z.infer<typeof ma2AttributeGroupSchema>;
export const ma2CueContentSchema = z.object({
  state: z.enum(['complete', 'partial']),
  issues: z.array(z.string().min(1).max(512)).max(100),
  parts: z.array(z.number().int().min(0).max(199)).max(200),
  hasCommands: z.boolean(),
  hasPlaybackSettings: z.boolean().optional(),
  tracking: z.enum(['none', 'possible', 'unverified']),
  rows: z.array(z.object({
    attribute: z.string().max(128),
    fixtureId: z.number().int().positive().optional(),
    channelId: z.number().int().positive().optional(),
    subfixture: z.string().max(128).optional(),
    valuePart: z.number().int().min(0).max(199).optional(),
    effectPart: z.number().int().min(0).max(199).optional(),
    layers: z.array(z.object({
      path: z.string().max(512), value: z.string().max(4096),
      properties: z.record(z.string(), z.string().max(4096))
    }).strict()).max(4096)
  }).strict()).max(100000)
}).strict();
export type Ma2CueContent = z.infer<typeof ma2CueContentSchema>;
export const ma2CueAttributesSchema = z.object({
  sequence: z.number().int().min(1).max(99999),
  cueIndex: z.number().int().nonnegative(),
  attributes: z.array(z.string().min(1).max(128)).max(4096),
  groups: z.array(ma2AttributeGroupSchema).max(4096).optional(),
  fixtureIds: z.array(z.number().int().positive()).max(10000),
  hasEffects: z.boolean(),
  unknownChannels: z.number().int().nonnegative(),
  content: ma2CueContentSchema.optional(),
  readAt: z.string().datetime()
}).strict();
export type Ma2CueAttributes = z.infer<typeof ma2CueAttributesSchema>;
