import { z } from 'zod';
const finite = z.number().finite();
export const obsLiveTransformSchema = z.object({
  positionX: finite, positionY: finite, scaleX: finite, scaleY: finite, rotation: finite,
  cropTop: z.number().int().nonnegative(), cropRight: z.number().int().nonnegative(), cropBottom: z.number().int().nonnegative(), cropLeft: z.number().int().nonnegative(),
  alignment: z.number().int(), sourceWidth: finite.nonnegative(), sourceHeight: finite.nonnegative(), width: finite, height: finite,
  boundsType: z.string(), boundsWidth: finite, boundsHeight: finite
});
export const obsLiveItemSchema = z.object({ sceneItemId: z.number().int().nonnegative(), sourceName: z.string(), sceneItemEnabled: z.boolean(), sceneItemLocked: z.boolean(), sceneItemIndex: z.number().int(), sceneItemTransform: obsLiveTransformSchema });
export const obsLiveSceneSchema = z.object({ sceneName: z.string(), width: finite.positive(), height: finite.positive(), items: z.array(obsLiveItemSchema) });
export const obsLiveEditSchema = z.object({ sceneName: z.string().min(1), sceneItemId: z.number().int().nonnegative(), transform: obsLiveTransformSchema.pick({positionX:true,positionY:true,scaleX:true,scaleY:true,rotation:true,cropTop:true,cropRight:true,cropBottom:true,cropLeft:true,boundsWidth:true,boundsHeight:true}).partial().optional(), enabled: z.boolean().optional(), locked: z.boolean().optional() });
export type ObsLiveScene = z.infer<typeof obsLiveSceneSchema>;
export type ObsLiveItem = z.infer<typeof obsLiveItemSchema>;
export type ObsLiveEdit = z.infer<typeof obsLiveEditSchema>;
