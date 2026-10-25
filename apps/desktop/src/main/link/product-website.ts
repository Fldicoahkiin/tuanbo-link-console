/** Only these product pages may leave the sandbox for the system browser. */
export function isProductWebsiteUrl(url: string): boolean {
  return [
    'https://tuanbo-link.jinhefilm.com/',
    'https://tuanbo-link.jinhefilm.com/#purchase',
    'https://tuanbo-link.jinhefilm.com/#contact',
    'https://tuanbo-link.jinhefilm.com/download/#changelog'
  ].includes(url);
}
