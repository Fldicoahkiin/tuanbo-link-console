import { z } from 'zod';
import { mtcFrameRateSchema } from './link-project';

const executableProfileSchema = z.object({
  executablePath: z.string().min(1),
  arguments: z.array(z.string()).default([]),
  workingDirectory: z.string().min(1),
  startupTimeoutMs: z.number().int().min(1_000).max(120_000),
  shutdownTimeoutMs: z.number().int().min(1_000).max(120_000)
});

export const integrationProfileSchema = z.object({
  schemaVersion: z.literal(1),
  profileId: z.string().min(1),
  name: z.string().min(1),
  loopMidi: z.object({ autoStart: z.boolean() }).optional(),
  updatedAt: z.string().datetime({ offset: true }),
  obs: executableProfileSchema.extend({
    webSocketUrl: z.string().url().refine((value) => value.startsWith('ws://') || value.startsWith('wss://'), {
      message: 'OBS 地址必须使用 ws:// 或 wss://'
    }),
    credentialId: z.string().min(1)
  }),
  p1: executableProfileSchema.extend({
    mtcInputPortProfileId: z.string().min(1),
    controlOutputPortProfileId: z.string().min(1),
    expectedFrameRate: mtcFrameRateSchema,
    obsAudioInputName: z.string().max(256).optional()
  }),
  midiPortProfiles: z.array(z.object({
    id: z.string().min(1),
    direction: z.enum(['input', 'output']),
    portName: z.string().max(256)
  })).min(2),
  internalPlayer: z.object({
    controlInputPortProfileId: z.string().min(1).nullable().optional(),
    doubleClickPlayback: z.boolean().optional(),
    arrowKeyPlayback: z.boolean().optional(),
    preload: z.boolean().optional(),
    fadeInMs: z.number().int().min(0).max(30_000).optional(),
    fadeOutMs: z.number().int().min(0).max(30_000).optional(),
    mtcOutputPortProfileId: z.string().min(1).nullable().default(null),
    audioOutputDeviceId: z.string().default('default'),
    audioSampleRate: z.union([z.literal(44100), z.literal(48000)]).optional()
  }).optional(),
  lighting: z.object({ mscDeviceId: z.number().int().min(0).max(127) }).optional(),
  acceptedVersions: z.object({
    obs: z.string().min(1),
    p1: z.string().min(1)
  }),
  lastSuccessfulPreflight: z.object({
    checkedAt: z.string().datetime({ offset: true }),
    applicationVersion: z.string().min(1),
    mode: z.enum(['rehearsal', 'live']),
    checks: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      status: z.enum(['passed', 'warning']),
      detail: z.string()
    }))
  }).optional()
}).superRefine((profile, ctx) => {
  const ids = new Set<string>();
  for (const [index, port] of profile.midiPortProfiles.entries()) {
    if (ids.has(port.id)) {
      ctx.addIssue({ code: 'custom', message: `MIDI 端口档案 ID 重复：${port.id}`, path: ['midiPortProfiles', index, 'id'] });
    }
    ids.add(port.id);
  }
  const input = profile.midiPortProfiles.find((port) => port.id === profile.p1.mtcInputPortProfileId);
  if (input?.direction !== 'input') {
    ctx.addIssue({ code: 'custom', message: 'P1 MTC 输入端口档案不存在或方向错误', path: ['p1', 'mtcInputPortProfileId'] });
  }
  const output = profile.midiPortProfiles.find((port) => port.id === profile.p1.controlOutputPortProfileId);
  const internalOutputId = profile.internalPlayer?.mtcOutputPortProfileId;
  const controlInputId = profile.internalPlayer?.controlInputPortProfileId;
  if (controlInputId && profile.midiPortProfiles.find((port) => port.id === controlInputId)?.direction !== 'input') {
    ctx.addIssue({ code: 'custom', message: '播放控制 MIDI 输入端口不存在或方向错误', path: ['internalPlayer', 'controlInputPortProfileId'] });
  }
  if (internalOutputId && profile.midiPortProfiles.find((port) => port.id === internalOutputId)?.direction !== 'output') {
    ctx.addIssue({ code: 'custom', message: '内部主控时间码输出端口档案不存在或方向错误', path: ['internalPlayer', 'mtcOutputPortProfileId'] });
  }
  if (output?.direction !== 'output') {
    ctx.addIssue({ code: 'custom', message: 'P1 控制输出端口档案不存在或方向错误', path: ['p1', 'controlOutputPortProfileId'] });
  }
});

export type IntegrationProfile = z.infer<typeof integrationProfileSchema>;

export function parseIntegrationProfile(value: unknown): IntegrationProfile {
  return integrationProfileSchema.parse(value);
}
