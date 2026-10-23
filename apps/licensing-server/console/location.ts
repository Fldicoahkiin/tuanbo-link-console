/** 网址中保存的视图：页面、详情对象、筛选和页码。刷新或分享链接后还原同一视图。 */
export type Filter = { q: string; state: string; channel: string; from: string; to: string };
export const emptyFilter: Filter = { q: '', state: '', channel: '', from: '', to: '' };
export type ConsoleLocation = { route: string; id: string | null; filter: Filter; page: number };
const routes = new Set(['overview', 'orders', 'licenses', 'exceptions', 'tickets', 'finance', 'audit', 'users', 'updates', 'security']);
export const detailRoutes = new Set(['orders', 'licenses', 'tickets']);
/** 授权页默认打开「生效中」。 */
export const defaultFilter = (route: string): Filter => route === 'licenses' ? { ...emptyFilter, state: 'active' } : emptyFilter;

export function readLocation(hash: string): ConsoleLocation {
  const [path = '', search = ''] = hash.replace(/^#\/?/, '').split('?');
  const [head = '', id] = path.split('/');
  const route = routes.has(head) ? head : 'overview';
  const params = new URLSearchParams(search); const fallback = defaultFilter(route);
  const state = params.get('state') ?? fallback.state;
  return {
    route, id: detailRoutes.has(route) && id && /^[a-f0-9-]{36}$/.test(id) ? id : null,
    filter: { q: params.get('q') ?? '', state: state === 'all' ? '' : state, channel: params.get('channel') ?? '', from: params.get('from') ?? '', to: params.get('to') ?? '' },
    page: Math.max(1, Math.floor(Number(params.get('page'))) || 1)
  };
}
export function writeLocation({ route, id, filter, page }: ConsoleLocation): string {
  const params = new URLSearchParams();
  if (filter.q) params.set('q', filter.q);
  // 授权页的「全部」要显式写出，否则刷新后会回到默认的「生效中」。
  if (filter.state || route === 'licenses') params.set('state', filter.state || 'all');
  for (const key of ['channel', 'from', 'to'] as const) if (filter[key]) params.set(key, filter[key]);
  if (page > 1) params.set('page', String(page));
  const search = params.toString();
  return `#/${route}${id ? `/${id}` : ''}${search ? `?${search}` : ''}`;
}
