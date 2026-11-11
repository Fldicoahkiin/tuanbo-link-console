import { z } from 'zod';

/** Version 2 (E10): the worker also returns the finest waveform level, the rhythm band and the spectrum. */
export const waveformWorkerRequestSchema = z.object({ version: z.literal(2),
  executable: z.string().min(1).max(32767).refine(value => !value.includes('\0')),
  sourcePath: z.string().min(1).max(32767).refine(value => !value.includes('\0')),
  durationMs: z.number().finite().positive().max(86_400_000) }).strict();
const baseSchema = z.object({
  samplesPerBucket: z.number().int().positive(), sampleCount: z.number().int().positive(),
  wave: z.instanceof(Int16Array), rhythm: z.instanceof(Int16Array),
  spectrum: z.object({ hopSamples: z.number().int().positive(), windowSamples: z.number().int().positive(), frames: z.number().int().positive(), bands: z.number().int().positive(),
    minHz: z.number().positive(), maxHz: z.number().positive(), floorDb: z.number().finite(), rangeDb: z.number().positive(), data: z.instanceof(Uint8Array) }).strict()
}).strict().refine(base => base.wave.length === base.rhythm.length && base.wave.length === Math.ceil(base.sampleCount / base.samplesPerBucket) * 2
  && base.spectrum.data.length === base.spectrum.frames * base.spectrum.bands, '波形后台任务返回的数据长度不一致');
export const waveformWorkerResultSchema = z.discriminatedUnion('ok', [
  /** `peaks`: the 0.5.8 cache (`<sha>.json`), kept so the rollback installer still shows waveforms. */
  z.object({ version: z.literal(2), ok: z.literal(true), peaks: z.array(z.number().finite().min(0).max(1)).min(1).max(500_000), base: baseSchema }).strict(),
  z.object({ version: z.literal(2), ok: z.literal(false), error: z.string().min(1).max(8192) }).strict()
]);
