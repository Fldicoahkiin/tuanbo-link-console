import { readFileSync } from 'node:fs';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { WechatPay } from './wechat';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { purchaseCatalogSchema } from '../../../packages/schema/src/purchase';
import { serviceConfigSchema } from './config';

const config = serviceConfigSchema.parse(process.env);
process.umask(0o077);
const service = new LicensingService(config.LICENSE_DATABASE, readFileSync(config.LICENSE_PRIVATE_KEY_FILE, 'utf8'), config.LICENSE_KEY_ID,
  Buffer.from(readFileSync(config.LICENSE_DATA_KEY_FILE, 'utf8').trim(), 'base64'));
const alipay = config.ALIPAY_APP_ID && config.ALIPAY_SELLER_ID && config.ALIPAY_PUBLIC_KEY_FILE
  ? new AlipayNotifications(config.ALIPAY_APP_ID, config.ALIPAY_SELLER_ID, readFileSync(config.ALIPAY_PUBLIC_KEY_FILE, 'utf8')) : undefined;
const checkout = config.ALIPAY_CHECKOUT_ENABLED === 'true' && config.ALIPAY_APP_ID && config.ALIPAY_SELLER_ID && config.ALIPAY_PRIVATE_KEY_FILE
  ? new AlipayCheckout(config.ALIPAY_APP_ID, config.ALIPAY_SELLER_ID, readFileSync(config.ALIPAY_PRIVATE_KEY_FILE, 'utf8'), config.PAYMENT_ENVIRONMENT, config.PAYMENT_NOTIFY_ORIGIN) : undefined;
const wechat = config.WECHAT_APP_ID && config.WECHAT_MCH_ID && config.WECHAT_PRIVATE_KEY_FILE && config.WECHAT_CERT_SERIAL && config.WECHAT_PUBLIC_KEY_FILE && config.WECHAT_PUBLIC_KEY_ID && config.WECHAT_API_V3_KEY_FILE
  ? new WechatPay(config.WECHAT_APP_ID, config.WECHAT_MCH_ID, readFileSync(config.WECHAT_PRIVATE_KEY_FILE, 'utf8'), config.WECHAT_CERT_SERIAL,
    readFileSync(config.WECHAT_PUBLIC_KEY_FILE, 'utf8'), config.WECHAT_PUBLIC_KEY_ID, Buffer.from(readFileSync(config.WECHAT_API_V3_KEY_FILE, 'utf8').trim()), config.PAYMENT_NOTIFY_ORIGIN) : undefined;
const catalog = config.LICENSE_CATALOG_FILE ? purchaseCatalogSchema.parse(JSON.parse(readFileSync(config.LICENSE_CATALOG_FILE, 'utf8'))) : undefined;
const consoleOptions = config.CONSOLE_ORIGIN && config.CONSOLE_KEY_FILE ? { origin: config.CONSOLE_ORIGIN, service: service.console(Buffer.from(readFileSync(config.CONSOLE_KEY_FILE, 'utf8').trim(), 'base64')) } : undefined;
const server = createLicensingServer(service, readFileSync(config.LICENSE_ADMIN_TOKEN_FILE, 'utf8').trim(), alipay, checkout, catalog, config.LICENSE_PROXY_MODE === 'loopback', wechat, config.WECHAT_CHECKOUT_ENABLED === 'true', consoleOptions);
server.on('error', error => { console.error(`授权服务启动失败：${error.message}`); service.close(); process.exitCode = 1; });
server.listen(config.LICENSE_PORT, config.LICENSE_HOST, () => console.log(`授权服务已启动；支付环境 ${config.PAYMENT_ENVIRONMENT}，支付宝通知${alipay ? '已配置' : '未启用'}，后台仍仅供运营访问。`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  const deadline = setTimeout(() => { console.error('授权服务停止超时'); process.exit(1); }, 10000);
  deadline.unref();
  server.close(() => { service.close(); clearTimeout(deadline); });
});
