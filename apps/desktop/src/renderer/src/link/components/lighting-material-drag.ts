import { z } from 'zod';
import type { DragEvent } from 'react';

export const CONSOLE_CUE_DRAG = 'application/x-tblink-console-cue';
export const consoleCueDragSchema = z.object({
  sequence: z.number().int().min(1).max(99999),
  cue: z.string().regex(/^\d{1,4}(?:\.\d{1,3})?$/),
  name: z.string().min(1).max(1024),
  executor: z.string().regex(/^(?:[1-9]\d*\.[1-9]\d*)?$/)
}).strict();
export type ConsoleCueDrag = z.infer<typeof consoleCueDragSchema>;

export function lightingMaterialDropHandlers(options: {
  timeAtClientX: (x: number) => number;
  onConsoleCueDrop?: ((reference: ConsoleCueDrag, ms: number) => void) | undefined;
  onEffectDrop?: ((effectId: string, ms: number) => void) | undefined;
  onError: (message: string) => void;
}) {
  const effectType = 'application/x-tblink-lighting-effect';
  return {
    onDragOver(event: DragEvent<HTMLDivElement>): void {
      if (options.onEffectDrop && event.dataTransfer.types.includes(effectType) || options.onConsoleCueDrop && event.dataTransfer.types.includes(CONSOLE_CUE_DRAG)) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; }
    },
    onDrop(event: DragEvent<HTMLDivElement>): void {
      const consoleCue = event.dataTransfer.getData(CONSOLE_CUE_DRAG), id = event.dataTransfer.getData(effectType);
      if (!(consoleCue && options.onConsoleCueDrop || id && options.onEffectDrop)) return;
      event.preventDefault(); event.stopPropagation();
      try {
        const ms = options.timeAtClientX(event.clientX);
        if (consoleCue && options.onConsoleCueDrop) options.onConsoleCueDrop(consoleCueDragSchema.parse(JSON.parse(consoleCue)), ms);
        else if (id) options.onEffectDrop?.(id, ms);
      } catch (error) { options.onError(error instanceof Error ? error.message : String(error)); }
    }
  };
}
