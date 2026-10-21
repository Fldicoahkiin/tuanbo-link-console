import { pinyin } from 'pinyin-pro';

// CJK punctuation that has no ASCII compatibility form under NFKC.
const punctuation: Readonly<Record<string, string>> = {
  '。': '.', '、': ',', '《': '<', '》': '>', '〈': '<', '〉': '>', '「': "'", '」': "'", '『': "'", '』': "'",
  '“': "'", '”': "'", '‘': "'", '’': "'", '【': '[', '】': ']', '〔': '(', '〕': ')', '·': '.', '・': '.', '—': '-', '–': '-', '〜': '~'
};

/**
 * The text MA2 shows for a name. Console fonts show only ASCII, so each Chinese character becomes
 * one capitalised pinyin syllable; ASCII is kept as is, so a name read back from the console
 * converts to itself. May be empty; comparisons use this, writes use toConsoleLabel().
 */
export function consoleLabelText(name: string): string {
  return pinyin(name, { toneType: 'none', type: 'all', nonZh: 'consecutive', v: true }).map(part => part.isZh
    ? `${part.pinyin.charAt(0).toUpperCase()}${part.pinyin.slice(1)}`
    : [...part.origin.normalize('NFKC')].map(char => punctuation[char] ?? char).join('').replace(/"/g, "'").replace(/\\/g, '/').replace(/[^\x20-\x7e]/g, '')).join('').trim();
}

/** The name written to MA2; refuses a name with nothing the console can show. */
export function toConsoleLabel(name: string): string {
  const text = consoleLabelText(name);
  if (!text) throw new Error(`名称“${name}”转换后没有控台能显示的字符，请加入中文、英文或数字`);
  if (text.length > 512) throw new Error(`名称“${name}”转换为拼音后超过 512 个字符，请缩短`);
  return text;
}
