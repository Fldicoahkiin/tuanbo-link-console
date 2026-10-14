import { purchaseCatalogResponseSchema } from '../../../packages/schema/src/purchase';

const plans = document.getElementById('catalog-plans');
const reload = document.getElementById('catalog-reload');
async function loadCatalog(): Promise<void> {
  if (!plans) return;
  plans.textContent = '正在读取可售套餐…';
  if (reload) reload.hidden = true;
  try {
    const response = await fetch('/v1/catalog', { credentials: 'omit', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('暂时无法读取套餐。请重新读取，或联系支持。');
    const catalog = purchaseCatalogResponseSchema.parse(await response.json());
    if (!catalog.available || catalog.offers.length === 0) { plans.textContent = '暂未开放购买。已有订单仍可恢复查询。'; return; }
    plans.replaceChildren(...catalog.offers.map(offer => {
      const article = document.createElement('article');
      const label = document.createElement('h3'); label.textContent = offer.useDays === 30 ? '月付授权' : offer.useDays === 365 ? '年付授权' : `${offer.useDays} 天授权`;
      const price = document.createElement('p'); price.className = 'price'; price.textContent = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: catalog.currency, maximumFractionDigits: 2 }).format(offer.unitAmountFen / 100);
      const duration = document.createElement('p'); duration.textContent = `${offer.useDays} 天 / 台 · 含 ${offer.updatesDays} 天更新权益`;
      const link = document.createElement('a'); link.className = 'button secondary'; link.href = '/purchase/'; link.textContent = '查看套餐并购买';
      article.append(label, price, duration, link); return article;
    }));
  } catch (error) {
    plans.textContent = error instanceof Error && error.message.startsWith('暂时') ? error.message : '套餐读取失败。请重新读取，或前往购买页查看。';
    if (reload) reload.hidden = false;
  }
}
reload?.addEventListener('click', () => { void loadCatalog(); });
if (plans) void loadCatalog();

const viewer = document.getElementById('image-viewer');
if (viewer instanceof HTMLDialogElement) {
  const close = viewer.querySelector('button');
  close?.addEventListener('click', () => viewer.close());
  viewer.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });
  document.querySelectorAll<HTMLAnchorElement>('[data-image]').forEach(link => link.addEventListener('click', event => {
    const image = viewer.querySelector('img'); const caption = viewer.querySelector('p');
    if (!image || !caption) return;
    event.preventDefault(); image.src = link.href; image.alt = link.querySelector('img')?.alt ?? '软件界面'; caption.textContent = image.alt; viewer.showModal();
  }));
}
const player = document.getElementById('demo-player');
const status = document.getElementById('video-status');
if (player instanceof HTMLVideoElement) {
  const overview = '/media/20261010-overview.mp4';
  let pendingTime = 0;
  const play = async (): Promise<void> => {
    try { await player.play(); if (status) status.textContent = ''; }
    catch { if (status) status.textContent = '未能开始播放。请点击播放器播放按钮，或下载视频观看。'; }
  };
  player.addEventListener('loadedmetadata', () => { player.currentTime = pendingTime; });
  player.addEventListener('error', () => { if (status) status.textContent = '视频加载失败。请检查网络，或使用下方链接下载观看。'; });
  document.querySelectorAll<HTMLButtonElement>('[data-time]').forEach(button => button.addEventListener('click', () => {
    pendingTime = Number(button.dataset.time);
    player.querySelectorAll('track').forEach(track => { track.track.mode = 'showing'; });
    if (!player.currentSrc.endsWith(overview)) { player.src = overview; player.load(); }
    else if (player.readyState >= 1) player.currentTime = pendingTime;
    void play();
  }));
  document.querySelectorAll<HTMLButtonElement>('[data-clip]').forEach(button => button.addEventListener('click', () => {
    pendingTime = 0; player.src = `/media/20261010-${button.dataset.clip}.mp4`; player.load();
    player.querySelectorAll('track').forEach(track => { track.track.mode = 'disabled'; });
    player.scrollIntoView({ behavior: 'instant', block: 'center' }); void play();
    if (status) status.textContent = `正在播放：${button.dataset.title}`;
  }));
}
