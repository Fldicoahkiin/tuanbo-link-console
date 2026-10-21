import { expect, it } from 'vitest';
import { toConsoleLabel } from './ma2-console-label';

it('中文逐字转为首字母大写的拼音，多音字按词组判断', () => {
  expect(toConsoleLabel('开场')).toBe('KaiChang');
  expect(toConsoleLabel('重庆')).toBe('ChongQing');
  expect(toConsoleLabel('银行')).toBe('YinHang');
  expect(toConsoleLabel('乐队行进')).toBe('YueDuiXingJin');
  expect(toConsoleLabel('绿灯')).toBe('LvDeng');
});
it('英文、数字和空格原样保留，全角转半角，中文标点转 ASCII', () => {
  expect(toConsoleLabel('Cue 3 开场灯光')).toBe('Cue 3 KaiChangDengGuang');
  expect(toConsoleLabel('第1段 副歌')).toBe('Di1Duan FuGe');
  expect(toConsoleLabel('舞台ＡＢＣ１２３')).toBe('WuTaiABC123');
  expect(toConsoleLabel('《星辰》（慢版）')).toBe('<XingChen>(ManBan)');
  expect(toConsoleLabel('红·蓝，“亮”…')).toBe("Hong.Lan,'Liang'...");
});
it('控台读回的 ASCII 名称转换后不变，重名不加后缀', () => {
  for (const name of ['KaiChang', 'Cue  3', 'TBLINK_PROBE_1', "it's <A>"]) expect(toConsoleLabel(name)).toBe(name);
  expect(toConsoleLabel('衣')).toBe(toConsoleLabel('一'));
});
it('转换后为空或过长时明确报错，不写入空名称', () => {
  expect(() => toConsoleLabel('🎵🎶')).toThrow('没有控台能显示的字符');
  expect(() => toConsoleLabel('灯'.repeat(200))).toThrow('超过 512 个字符');
});
