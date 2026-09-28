import { z } from 'zod';
import { activationCodeSchema } from './license';

const identifier = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const purchaseOfferSchema = z.object({
  id: identifier, revision: identifier, name: z.string().trim().min(1).max(100),
  unitAmountFen: z.number().int().min(1).max(100_000_000),
  kind: z.enum(['perpetual', 'subscription']), useDays: z.number().int().min(1).max(36500).nullable(),
  updatesDays: z.number().int().min(1).max(36500), maxQuantity: z.number().int().min(1).max(100),
  saleUntil: z.string().datetime()
}).strict().refine(offer => (offer.kind === 'perpetual') === (offer.useDays === null), '买断不设使用天数，订阅须明确天数');
export const purchaseCatalogSchema = z.object({
  version: z.literal(1), maxOrderAmountFen: z.number().int().min(1).max(100_000_000),
  offers: z.array(purchaseOfferSchema).max(20)
}).strict().refine(catalog => new Set(catalog.offers.map(offer => offer.id)).size === catalog.offers.length, '商品 ID 不能重复');
export const purchaseRequestSchema = z.object({
  offerId: identifier, revision: identifier,
  quotedUnitAmountFen: z.number().int().min(1).max(100_000_000), quantity: z.number().int().min(1).max(100),
  customer: z.string().trim().min(1).max(160), customerType: z.enum(['personal', 'company']),
  renewalLicenseId: z.string().uuid().optional()
}).strict();
export type PurchaseCatalog = z.infer<typeof purchaseCatalogSchema>;
export type PurchaseRequest = z.infer<typeof purchaseRequestSchema>;
export const purchaseCatalogResponseSchema = z.object({
  available: z.boolean(), currency: z.literal('CNY'), termStart: z.literal('fulfillment'), offers: z.array(purchaseOfferSchema).max(20)
}).strict().refine(value => value.available === (value.offers.length > 0), '商品可售状态不一致');
export type PurchaseCatalogResponse = z.infer<typeof purchaseCatalogResponseSchema>;
export const purchaseOrderSchema = z.object({
  id: z.string().uuid(), state: z.enum(['pending', 'fulfilled']), amountFen: z.number().int().min(1).max(100_000_000),
  quantity: z.number().int().min(1).max(100), offer: purchaseOfferSchema, expiresAt: z.string().datetime(), payable: z.boolean(),
  renewalLicenseId: z.string().uuid().optional()
}).strict();
export const purchaseResponseSchema = purchaseOrderSchema.extend({ paymentUrl: z.string().max(16384).url().nullable() })
  .refine(value => value.amountFen === value.offer.unitAmountFen * value.quantity && value.quantity <= value.offer.maxQuantity, '订单金额或数量不一致')
  .refine(value => value.payable === (value.paymentUrl !== null) && (value.state !== 'fulfilled' || !value.payable), '付款状态不一致');
export const purchaseDeliverySchema = z.object({
  id: z.string().uuid(), state: z.enum(['pending', 'fulfilled']), amountFen: z.number().int().min(1).max(100_000_000),
  quantity: z.number().int().min(1).max(100), kind: z.enum(['perpetual', 'subscription']),
  useUntil: z.string().datetime().nullable(), updatesUntil: z.string().datetime(),
  renewalLicenseId: z.string().uuid().optional(),
  licenses: z.array(z.object({ id: z.string().uuid(), code: activationCodeSchema.nullable(), revoked: z.boolean() }).strict()).max(100)
}).strict().refine(value => value.state === 'pending' ? value.licenses.length === 0 : value.licenses.length === value.quantity, '交付数量不一致')
  .refine(value => (value.kind === 'perpetual') === (value.useUntil === null)
    && value.licenses.every(license => (license.revoked || Boolean(value.renewalLicenseId)) === (license.code === null)), '交付授权状态不一致')
  .refine(value => !value.renewalLicenseId || value.quantity === 1 && value.kind === 'subscription'
    && value.licenses.every(license => license.id === value.renewalLicenseId), '续费必须对应原订阅授权');
export const purchaseReceiptSchema = z.object({
  localId: z.string().uuid(), createdAt: z.string().datetime(), request: purchaseRequestSchema,
  order: purchaseOrderSchema.nullable(), delivery: purchaseDeliverySchema.nullable(), rejected: z.boolean()
}).strict();
export type PurchaseReceipt = z.infer<typeof purchaseReceiptSchema>;
