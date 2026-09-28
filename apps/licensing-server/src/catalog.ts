import { z } from 'zod';

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
  customer: z.string().trim().min(1).max(160), customerType: z.enum(['personal', 'company'])
}).strict();
export type PurchaseCatalog = z.infer<typeof purchaseCatalogSchema>;
