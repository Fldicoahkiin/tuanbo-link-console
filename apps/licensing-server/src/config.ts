import { z } from 'zod';
import { wechatIdentitySchema } from './wechat';
import { paymentEnvironmentSchema } from '../../../packages/schema/src/purchase';

/** 服务进程环境变量；启动时一次校验，失败即拒绝启动。 */
export const serviceConfigSchema = z.object({
  CONSOLE_ORIGIN: z.string().url().optional(), CONSOLE_KEY_FILE: z.string().min(1).optional(),
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
  // Update publishing: this account's request directory, and the root publisher's directory it only reads
  // (results and status). Both unset leaves update publishing off.
  UPDATE_REQUEST_DIRECTORY: z.string().min(1).optional(), UPDATE_PUBLISHER_DIRECTORY: z.string().min(1).optional(),
  // 未设置时沿用生产网关和现有公网回调域名；沙箱联调须显式设为 sandbox。
  PAYMENT_ENVIRONMENT: paymentEnvironmentSchema.default('production'),
  PAYMENT_NOTIFY_ORIGIN: z.string().url().default('https://api.tuanbo-link.jinhefilm.com'),
  LICENSE_PROXY_MODE: z.enum(['none', 'loopback']).default('none'),
  LICENSE_HOST: z.string().default('127.0.0.1'), LICENSE_PORT: z.coerce.number().int().min(1).max(65535).default(8787)
}).refine(value => Boolean(value.CONSOLE_ORIGIN) === Boolean(value.CONSOLE_KEY_FILE), '管理域名和认证密钥必须同时配置')
  .refine(value => Boolean(value.UPDATE_REQUEST_DIRECTORY) === Boolean(value.UPDATE_PUBLISHER_DIRECTORY), '更新请求目录和发布助手目录必须同时配置')
  .refine(value => !value.CONSOLE_ORIGIN || new URL(value.CONSOLE_ORIGIN).protocol === 'https:' && new URL(value.CONSOLE_ORIGIN).origin === value.CONSOLE_ORIGIN, '管理地址必须为独立 HTTPS origin')
  .refine(value => new URL(value.PAYMENT_NOTIFY_ORIGIN).protocol === 'https:' && new URL(value.PAYMENT_NOTIFY_ORIGIN).origin === value.PAYMENT_NOTIFY_ORIGIN, '支付回调地址必须为 HTTPS origin，不含路径')
  .refine(value => value.PAYMENT_ENVIRONMENT === 'production' || value.WECHAT_APP_ID === undefined, '微信支付 APIv3 没有沙箱环境，沙箱联调时不能配置微信参数')
  .refine(value => [value.ALIPAY_APP_ID, value.ALIPAY_SELLER_ID, value.ALIPAY_PUBLIC_KEY_FILE].every(item => item === undefined) || [value.ALIPAY_APP_ID, value.ALIPAY_SELLER_ID, value.ALIPAY_PUBLIC_KEY_FILE].every(Boolean), '支付宝配置必须全部提供或全部省略')
  .refine(value => value.ALIPAY_CHECKOUT_ENABLED === 'false' || Boolean(value.ALIPAY_APP_ID && value.ALIPAY_SELLER_ID && value.ALIPAY_PUBLIC_KEY_FILE && value.ALIPAY_PRIVATE_KEY_FILE), '启用支付宝付款必须提供商户、应用和签名/验签密钥')
  .refine(value => {
    const fields = [value.WECHAT_APP_ID, value.WECHAT_MCH_ID, value.WECHAT_PRIVATE_KEY_FILE, value.WECHAT_CERT_SERIAL, value.WECHAT_PUBLIC_KEY_FILE, value.WECHAT_PUBLIC_KEY_ID, value.WECHAT_API_V3_KEY_FILE];
    return fields.every(Boolean) || value.WECHAT_CHECKOUT_ENABLED === 'false' && fields.every(item => item === undefined);
  }, '微信配置必须全部提供，关闭新销售仍须保留既有订单通知和查单凭据')
  .refine(value => value.LICENSE_PROXY_MODE === 'none' || value.LICENSE_HOST === '127.0.0.1' || value.LICENSE_HOST === '::1', '信任本机代理时只能监听回环地址');
