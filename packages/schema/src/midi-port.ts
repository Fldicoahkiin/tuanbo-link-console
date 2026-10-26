import { z } from 'zod';

/** MIDI for the interface goes through the main process: it opens exactly the port in use, one
 * owner per port, and closes it again. Chromium Web MIDI is never used, because it opens every
 * port of the computer as long as the window lives and so blocks the playback engine and P1. */
const portName = z.string().min(1).max(256).refine(value => !value.includes('\0'), '端口名称无效');
const handle = z.number().int().min(1).max(0xffffffff);
const port = z.object({ id: z.number().int().min(0).max(65535), name: portName }).strict();
const bytes = z.array(z.number().int().min(0).max(255)).min(1).max(65536);

export const midiPortListSchema = z.object({ version: z.literal(1), inputs: z.array(port).max(1024), outputs: z.array(port).max(1024) }).strict();
export type MidiPortList = z.infer<typeof midiPortListSchema>;
export const midiPortListRequestSchema = z.object({ version: z.literal(1), recheck: z.boolean() }).strict();
export type MidiPortListRequest = z.infer<typeof midiPortListRequestSchema>;
export const midiPortOpenSchema = z.object({ version: z.literal(1), direction: z.enum(['input', 'output']), portName }).strict();
export type MidiPortOpen = z.infer<typeof midiPortOpenSchema>;
export const midiPortHandleSchema = z.object({ version: z.literal(1), handle }).strict();
export type MidiPortHandle = z.infer<typeof midiPortHandleSchema>;
export const midiPortSendSchema = z.object({ version: z.literal(1), handle, bytes }).strict();
export type MidiPortSend = z.infer<typeof midiPortSendSchema>;
export const midiPortEventSchema = z.discriminatedUnion('kind', [
  /** `ageMs`: how long before it was forwarded the interface delivered the message. */
  z.object({ version: z.literal(1), kind: z.literal('message'), handle, bytes, ageMs: z.number().finite().min(0).max(600_000) }).strict(),
  /** The port was closed without the window asking: unplugged, failed, or taken over by formal playback. */
  z.object({ version: z.literal(1), kind: z.literal('closed'), handle, reason: z.string().min(1).max(4096) }).strict(),
  z.object({ version: z.literal(1), kind: z.literal('ports'), ports: midiPortListSchema }).strict(),
  /** Reading the port list failed; the list is read again only after an explicit recheck. */
  z.object({ version: z.literal(1), kind: z.literal('ports-failed'), reason: z.string().min(1).max(4096) }).strict()
]);
export type MidiPortEvent = z.infer<typeof midiPortEventSchema>;
