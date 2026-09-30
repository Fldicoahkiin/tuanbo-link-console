import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { LicensingService } from './service';
import { createLicensingServer } from './http';
import { WechatPay, wechatIdentitySchema } from './wechat';
import { AlipayCheckout, AlipayNotifications } from './alipay';
import { purchaseCatalogSchema } from '../../../packages/schema/src/purchase';

const config = z.object({
  LICENSE_DATABASE: z.string().min(1), LICENSE_PRIVATE_KEY_FILE: z.string().min(1), LICENSE_KEY_ID: z.string().min(1),
  LICENSE_DATA_KEY_FILE: z.string().min(1), LICENSE_ADMIN_TOKEN_FILE: z.string().min(1),
  ALIPAY_APP_ID: z.string().regex(/^\d{16}$/).optional(), ALIPAY_SELLER_ID: z.string().regex(/^\d{16}$/).optional(),
  ALIPAY_PUBLIC_KEY_FILE: z.string().min(1).optional(),
  ALIPAY_PRIVATE_KEY_FILE: z.string().min(1).optional(), ALIPAY_CHECKOUT_ENABLED: z.enum(['true', 'false']).default('false'),
  WECHAT_APP_ID: wechatIdentitySchema.shape.appId.optional(), WECHAT_MCH_ID: wechatIdentitySchema.shape.sellerId.optional(),
  WECHAT_PRIVATE_KEY_FILE: z.string().min(1).optional(), WECHAT_CERT_SERIAL: z.string().regex(/^[A-Fa-f0-9]{16,64}$/).optional(),
  WECHAT_PUBLIC_KEY_FILE: z.string().min(1).optional(), WECHAT_PUBLIC_KEY_ID: z.string().regex(/^PUB_KEY_ID_\d{10,64}$/).optional(),
  WECHAT_API_V3_KEY_FILE: z.string().min(1).optional(), WECHAT_CHECKOUT_ENABLED: z.enum(['true', 'false']).default('false'),
  LICENSE_CATALOG_FILE: z.string().min(1).optional(),
  LICENSE_PROXY_MODE: z.enum(['none', 'loopback']).default('none'),
  LICENSE_HOST: z.string().default('127.0.0.1'), LICENSE_PORT: z.coerce.number().int().min(1).max(65535).default(8787)
}).refine(value => [value.ALIPAY_APP_ID, value.ALIPAY_SELLER_ID, value.ALIPAY_PUBLIC_KEY_FILE].every(item => item === undefined) || [value.ALIPAY_APP_ID, value.ALIPAY_SELLER_ID, value.ALIPAY_PUBLIC_KEY_FILE].every(Boolean), '支付宝配置必须全部提供或全部省略')
  .refine(value => value.ALIPAY_CHECKOUT_ENABLED === 'false' || Boolean(value.ALIPAY_APP_ID && value.ALIPAY_SELLER_ID && value.ALIPAY_PUBLIC_KEY_FILE && value.ALIPAY_PRIVATE_KEY_FILE), '启用支付宝付款必须提供商户、应用和签名/验签密钥')
  .refine(value => {
    const fields = [value.WECHAT_APP_ID, value.WECHAT_MCH_ID, value.WECHAT_PRIVATE_KEY_FILE, value.WECHAT_CERT_SERIAL, value.WECHAT_PUBLIC_KEY_FILE, value.WECHAT_PUBLIC_KEY_ID, value.WECHAT_API_V3_KEY_FILE];
    return fields.every(Boolean) || value.WECHAT_CHECKOUT_ENABLED === 'false' && fields.every(item => item === undefined);
  }, '微信配置必须全部提供，关闭新销售仍须保留既有订单通知和查单凭据')
  .refine(value => value.LICENSE_PROXY_MODE === 'none' || value.LICENSE_HOST === '127.0.0.1' || value.LICENSE_HOST === '::1', '信任本机代理时只能监听回环地址').parse(process.env);
process.umask(0o077);
const service = new LicensingService(config.LICENSE_DATABASE, readFileSync(config.LICENSE_PRIVATE_KEY_FILE, 'utf8'), config.LICENSE_KEY_ID,
  Buffer.from(readFileSync(config.LICENSE_DATA_KEY_FILE, 'utf8').trim(), 'base64'));
const alipay = config.ALIPAY_APP_ID && config.ALIPAY_SELLER_ID && config.ALIPAY_PUBLIC_KEY_FILE
  ? new AlipayNotifications(config.ALIPAY_APP_ID, config.ALIPAY_SELLER_ID, readFileSync(config.ALIPAY_PUBLIC_KEY_FILE, 'utf8')) : undefined;
const checkout = config.ALIPAY_CHECKOUT_ENABLED === 'true' && config.ALIPAY_APP_ID && config.ALIPAY_SELLER_ID && config.ALIPAY_PRIVATE_KEY_FILE
  ? new AlipayCheckout(config.ALIPAY_APP_ID, config.ALIPAY_SELLER_ID, readFileSync(config.ALIPAY_PRIVATE_KEY_FILE, 'utf8')) : undefined;
const wechat = config.WECHAT_APP_ID && config.WECHAT_MCH_ID && config.WECHAT_PRIVATE_KEY_FILE && config.WECHAT_CERT_SERIAL && config.WECHAT_PUBLIC_KEY_FILE && config.WECHAT_PUBLIC_KEY_ID && config.WECHAT_API_V3_KEY_FILE
  ? new WechatPay(config.WECHAT_APP_ID, config.WECHAT_MCH_ID, readFileSync(config.WECHAT_PRIVATE_KEY_FILE, 'utf8'), config.WECHAT_CERT_SERIAL,
    readFileSync(config.WECHAT_PUBLIC_KEY_FILE, 'utf8'), config.WECHAT_PUBLIC_KEY_ID, Buffer.from(readFileSync(config.WECHAT_API_V3_KEY_FILE, 'utf8').trim())) : undefined;
const catalog = config.LICENSE_CATALOG_FILE ? purchaseCatalogSchema.parse(JSON.parse(readFileSync(config.LICENSE_CATALOG_FILE, 'utf8'))) : undefined;
const server = createLicensingServer(service, readFileSync(config.LICENSE_ADMIN_TOKEN_FILE, 'utf8').trim(), alipay, checkout, catalog, config.LICENSE_PROXY_MODE === 'loopback', wechat, config.WECHAT_CHECKOUT_ENABLED === 'true');
server.on('error', error => { console.error(`授权服务启动失败：${error.message}`); service.close(); process.exitCode = 1; });
server.listen(config.LICENSE_PORT, config.LICENSE_HOST, () => console.log(`授权服务已启动；支付宝通知${alipay ? '已配置' : '未启用'}，后台仍仅供运营访问。`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  const deadline = setTimeout(() => { console.error('授权服务停止超时'); process.exit(1); }, 10000);
  deadline.unref();
  server.close(() => { service.close(); clearTimeout(deadline); });
});
