import { describe, expect, it } from 'vitest';
import { isProductWebsiteUrl } from './product-website';

describe('product website navigation', () => {
  it.each(['', '#purchase', '/purchase/', 'javascript:alert(1)', 'file:///C:/Windows/notepad.exe',
    'https://tuanbo-link.jinhefilm.com.evil.test/', 'https://tuanbo-link.jinhefilm.com@evil.test/',
    'http://tuanbo-link.jinhefilm.com/', 'https://tuanbo-link.jinhefilm.com/?redirect=https://evil.test',
    'https://admin.tuanbo-link.jinhefilm.com/'])('rejects unapproved destination %s', url => {
    expect(isProductWebsiteUrl(url)).toBe(false);
  });
  it.each(['', '#purchase', '#contact'])('allows the fixed official page %s', anchor => {
    expect(isProductWebsiteUrl(`https://tuanbo-link.jinhefilm.com/${anchor}`)).toBe(true);
  });
});
