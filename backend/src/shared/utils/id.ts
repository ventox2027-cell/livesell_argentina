import { ulid } from 'ulid';

/**
 * IDs con prefijo por tipo.
 *
 * ULID y no UUID v4: es ordenable por tiempo (los índices B-tree no se
 * fragmentan) y el prefijo hace imposible pasar un `sessionId` donde va un
 * `sampleId` sin que salte a la vista en un log o en un test.
 */
export const ID_PREFIX = {
  spikeSession: 'spk',
  spikeSample: 'smp',
  spikeEvent: 'evt',
  glassToGlass: 'g2g',
  webhookEvent: 'whk',
  // Sprint 0B — pagos
  order: 'ord',
  payment: 'pay',
  paymentEvent: 'pev',
  mpWebhook: 'mpw',
  customer: 'cus',
  customerCard: 'crd',
  // Auth
  user: 'usr',
  identity: 'idn',
  device: 'dev',
  refreshToken: 'rtk',
  session: 'ses',
  authEvent: 'aev',
  // Comercio
  seller: 'sel',
  store: 'sto',
  category: 'cat',
  product: 'prd',
  productOption: 'opt',
  optionValue: 'opv',
  variant: 'var',
  productImage: 'img',
  // Inventario
  inventory: 'inv',
  reservation: 'rsv',
  // Órdenes y pagos
  orderV2: 'ord',
  orderItem: 'oit',
  paymentAttempt: 'pat',
  refund: 'ref',
  address: 'adr',
  sellerPaymentAccount: 'spa',
  auditLog: 'aud',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export function newId(prefix: IdPrefix): string {
  return `${prefix}_${ulid()}`;
}

export function isId(value: string, prefix: IdPrefix): boolean {
  return value.startsWith(`${prefix}_`) && value.length === prefix.length + 27;
}
