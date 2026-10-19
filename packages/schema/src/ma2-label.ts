import { z } from 'zod';
export const ma2LabelSchema = z.string().trim().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f"\\]/u.test(value), '控台名称不能包含双引号、反斜杠或控制字符');
