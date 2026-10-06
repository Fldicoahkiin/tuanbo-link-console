import { neutralBeautyValues, type BeautyParameter, type BeautyPreset } from '@tb/schema';
export type BeautyCategory = 'skin' | 'face' | 'body' | 'makeup' | 'color';
export type BeautyControl = { key: BeautyParameter; name: string; group: string; category: BeautyCategory; hint: string; signed?: boolean; prototype?: boolean };
export const beautyCategories: { id: BeautyCategory; name: string; description: string }[] = [
  { id: 'skin', name: '美肤', description: '先均匀肤质，再保留皮肤细节。' },
  { id: 'face', name: '美型', description: '小幅调整五官与轮廓，保留个人特征。' },
  { id: 'body', name: '美体', description: '调整身形比例，适合全身机位。' },
  { id: 'makeup', name: '美妆', description: '叠加轻量妆感，统一舞台气色。' },
  { id: 'color', name: '调色', description: '根据现场灯光微调画面。' }
];
export const beautyControls: BeautyControl[] = [
  { key: 'smooth', name: '磨皮', group: '基础肤质', category: 'skin', hint: '柔化皮肤，减少细小纹理。', prototype: true },
  { key: 'white', name: '美白', group: '基础肤质', category: 'skin', hint: '局部提亮面部肤色。', prototype: true },
  { key: 'texture', name: '质感保留', group: '基础肤质', category: 'skin', hint: '配合磨皮，减少原有纹理损失。', prototype: true },
  { key: 'evenSkin', name: '肤色均匀', group: '精细修饰', category: 'skin', hint: '柔化面部局部色差，保留明暗。', prototype: true },
  { key: 'blemish', prototype: true, name: '祛瑕疵', group: '精细修饰', category: 'skin', hint: '减弱细小暗斑，保留连续纹理。' },
  { key: 'darkCircles', prototype: true, name: '淡化黑眼圈', group: '精细修饰', category: 'skin', hint: '提亮眼下区域。' },
  { key: 'nasolabial', prototype: true, name: '淡化法令纹', group: '精细修饰', category: 'skin', hint: '减轻鼻翼至嘴角的阴影。' },
  { key: 'shine', name: '去油光', group: '精细修饰', category: 'skin', hint: '轻压面部肤色区域的高光。', prototype: true },
  { key: 'slim', name: '瘦脸', group: '脸部轮廓', category: 'face', hint: '轻收两侧面部轮廓。', prototype: true },
  { key: 'jaw', prototype: true, name: '下颌收窄', group: '脸部轮廓', category: 'face', hint: '调整下颌宽度。' },
  { key: 'cheek', prototype: true, name: '颧骨收窄', group: '脸部轮廓', category: 'face', hint: '调整颧骨外侧轮廓。' },
  { key: 'chin', prototype: true, name: '下巴', group: '脸部轮廓', category: 'face', hint: '负值缩短，正值拉长。', signed: true },
  { key: 'forehead', prototype: true, name: '额头', group: '脸部轮廓', category: 'face', hint: '微调额头比例。', signed: true },
  { key: 'eye', name: '大眼', group: '五官微调', category: 'face', hint: '围绕眼睛中心放大。', prototype: true },
  { key: 'eyeDistance', name: '眼距', group: '五官微调', category: 'face', hint: '负值靠近，正值拉远。', signed: true, prototype: true },
  { key: 'nose', name: '瘦鼻', group: '五官微调', category: 'face', hint: '沿鼻翼方向局部收窄。', prototype: true },
  { key: 'noseLength', name: '鼻长', group: '五官微调', category: 'face', hint: '负值缩短，正值拉长鼻部。', signed: true, prototype: true },
  { key: 'mouth', name: '嘴型大小', group: '五官微调', category: 'face', hint: '负值缩小，正值放大。', signed: true, prototype: true },
  { key: 'bodySlim', prototype: true, name: '瘦身', group: '身形比例', category: 'body', hint: '收窄躯干轮廓。' },
  { key: 'waist', prototype: true, name: '瘦腰', group: '身形比例', category: 'body', hint: '局部收窄腰部。' },
  { key: 'shoulder', prototype: true, name: '肩宽', group: '身形比例', category: 'body', hint: '负值收肩，正值展肩。', signed: true },
  { key: 'neck', prototype: true, name: '天鹅颈', group: '身形比例', category: 'body', hint: '微调颈部长度。' },
  { key: 'legLength', prototype: true, name: '长腿', group: '腿部修饰', category: 'body', hint: '调整下肢比例。' },
  { key: 'legSlim', prototype: true, name: '瘦腿', group: '腿部修饰', category: 'body', hint: '收窄腿部轮廓。' },
  { key: 'lipstick', name: '口红', group: '自然妆感', category: 'makeup', hint: '沿唇部轮廓叠加唇色，保留明暗。', prototype: true },
  { key: 'lipstickTone', name: '口红色调', group: '自然妆感', category: 'makeup', hint: '负值偏莓紫，正值偏暖橘；需配合口红浓度。', signed: true, prototype: true },
  { key: 'blush', name: '腮红', group: '自然妆感', category: 'makeup', hint: '在面颊肤色区域增加气色。', prototype: true },
  { key: 'blushTone', name: '腮红色调', group: '自然妆感', category: 'makeup', hint: '负值偏冷粉，正值偏蜜桃；需配合腮红浓度。', signed: true, prototype: true },
  { key: 'brow', name: '眉妆', group: '自然妆感', category: 'makeup', hint: '沿眉部轮廓加深，保留明暗。', prototype: true },
  { key: 'eyeliner', name: '眼线', group: '自然妆感', category: 'makeup', hint: '沿上眼睑外侧强调轮廓。', prototype: true },
  { key: 'teeth', name: '牙齿美白', group: '口腔修饰', category: 'makeup', hint: '减弱牙齿泛黄，保留明暗；闭嘴时不处理。', prototype: true },
  { key: 'exposure', name: '曝光', group: '画面调整', category: 'color', hint: '调整整体明暗。', signed: true, prototype: true },
  { key: 'contrast', name: '对比度', group: '画面调整', category: 'color', hint: '调整亮部与暗部反差。', signed: true, prototype: true },
  { key: 'saturation', name: '饱和度', group: '画面调整', category: 'color', hint: '调整色彩浓淡。', signed: true, prototype: true },
  { key: 'temperature', name: '色温', group: '画面调整', category: 'color', hint: '负值偏冷，正值偏暖。', signed: true, prototype: true },
  { key: 'sharpen', name: '锐化', group: '画面调整', category: 'color', hint: '增强边缘细节。', prototype: true }
];
export const beautyPresets: BeautyPreset[] = [
  { id: 'original', name: '原始参数', values: { ...neutralBeautyValues } },
  { id: 'natural', name: '自然通透', values: { ...neutralBeautyValues, smooth: 25, white: 15, slim: 12, eye: 8 } },
  { id: 'soft', name: '柔和上镜', values: { ...neutralBeautyValues, smooth: 45, white: 25, slim: 20, eye: 15 } },
  { id: 'stage', name: '舞台精致', values: { ...neutralBeautyValues, smooth: 55, white: 30, slim: 30, eye: 22 } }
];
