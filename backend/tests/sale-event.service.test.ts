import { setupTestDatabase, teardownTestDatabase, clearTestDatabase } from './setup';
import { Product } from '../src/models/Product';
import { InventoryAllocation } from '../src/models/InventoryAllocation';
import { InventoryTransaction } from '../src/models/InventoryTransaction';
import { processSaleEvent } from '../src/services/sale-event.service';
import { NormalizedSaleEvent } from '../src/providers/pos-provider.interface';
import { AppError } from '../src/utils/AppError';

beforeAll(setupTestDatabase);
afterAll(teardownTestDatabase);
afterEach(clearTestDatabase);

async function seedCokeWithAllocation(quantity: number, allocatedQuantity: number) {
  const product = await Product.create({ name: 'Coca Cola', sku: 'COKE-001', quantity, price: 250 });
  await InventoryAllocation.create({
    productId: product._id,
    posProvider: 'square',
    posProductId: 'sq-coke-variation',
    allocatedQuantity,
  });
  return product;
}

function saleEvent(overrides: Partial<NormalizedSaleEvent> = {}): NormalizedSaleEvent {
  return {
    provider: 'square',
    externalTransactionId: 'sale_123',
    posProductId: 'sq-coke-variation',
    quantity: 2,
    occurredAt: new Date(),
    ...overrides,
  };
}

describe('processSaleEvent — successful sale', () => {
  it('decrements product quantity and the matching allocation together', async () => {
    await seedCokeWithAllocation(100, 50);

    const result = await processSaleEvent(saleEvent(), 'webhook');

    expect(result.status).toBe('processed');
    expect(result.productQuantityBefore).toBe(100);
    expect(result.productQuantityAfter).toBe(98);
    expect(result.allocationBefore).toBe(50);
    expect(result.allocationAfter).toBe(48);

    const transaction = await InventoryTransaction.findOne({ idempotencyKey: 'square:sale_123' });
    expect(transaction?.status).toBe('COMPLETED');
    expect(transaction?.type).toBe('SALE');
  });
});

describe('processSaleEvent — insufficient inventory', () => {
  it('rejects the sale and never lets quantity go negative', async () => {
    const product = await seedCokeWithAllocation(1, 1);

    await expect(processSaleEvent(saleEvent({ quantity: 2 }), 'webhook')).rejects.toMatchObject<Partial<AppError>>({
      statusCode: 409,
      code: 'INSUFFICIENT_INVENTORY',
    });

    const reloaded = await Product.findById(product._id);
    expect(reloaded?.quantity).toBe(1); // unchanged

    const transaction = await InventoryTransaction.findOne({ idempotencyKey: 'square:sale_123' });
    expect(transaction?.status).toBe('FAILED');
  });
});

describe('processSaleEvent — idempotency / duplicate webhook', () => {
  it('does not double-deduct when the same external transaction id is processed twice', async () => {
    await seedCokeWithAllocation(100, 50);

    const first = await processSaleEvent(saleEvent(), 'webhook');
    const second = await processSaleEvent(saleEvent(), 'webhook');

    expect(first.status).toBe('processed');
    expect(second.status).toBe('duplicate');

    const product = await Product.findOne({ sku: 'COKE-001' });
    expect(product?.quantity).toBe(98); // only decremented once

    const count = await InventoryTransaction.countDocuments({ idempotencyKey: 'square:sale_123' });
    expect(count).toBe(1);
  });
});

describe('processSaleEvent — unmapped POS product', () => {
  it('records a failed transaction instead of throwing an unhandled crash', async () => {
    await seedCokeWithAllocation(100, 50);

    await expect(
      processSaleEvent(saleEvent({ posProductId: 'unknown-product-id', externalTransactionId: 'sale_999' }), 'webhook'),
    ).rejects.toMatchObject<Partial<AppError>>({ statusCode: 422, code: 'UNMAPPED_POS_PRODUCT' });

    const transaction = await InventoryTransaction.findOne({ idempotencyKey: 'square:sale_999' });
    expect(transaction?.status).toBe('FAILED');
  });
});

describe('processSaleEvent — concurrent delivery of the same event', () => {
  it('decrements only once even if the same idempotency key arrives concurrently (e.g. Square delivering the same order webhook more than once)', async () => {
    await seedCokeWithAllocation(100, 50);

    const results = await Promise.allSettled([
      processSaleEvent(saleEvent(), 'webhook'),
      processSaleEvent(saleEvent(), 'webhook'),
      processSaleEvent(saleEvent(), 'webhook'),
    ]);

    const statuses = results.map((r) => (r.status === 'fulfilled' ? r.value.status : 'rejected'));
    expect(statuses.filter((s) => s === 'processed')).toHaveLength(1);
    expect(statuses.filter((s) => s === 'duplicate')).toHaveLength(2);

    const product = await Product.findOne({ sku: 'COKE-001' });
    expect(product?.quantity).toBe(98); // decremented exactly once, not 3x

    const count = await InventoryTransaction.countDocuments({ idempotencyKey: 'square:sale_123' });
    expect(count).toBe(1);
  });
});

describe('processSaleEvent — concurrent sales on low stock', () => {
  it('allows only as many concurrent sales as stock permits, never going negative', async () => {
    await seedCokeWithAllocation(2, 2);

    const [a, b] = await Promise.allSettled([
      processSaleEvent(saleEvent({ externalTransactionId: 'sale_a', quantity: 2 }), 'webhook'),
      processSaleEvent(saleEvent({ externalTransactionId: 'sale_b', quantity: 2 }), 'webhook'),
    ]);

    const outcomes = [a, b];
    const succeeded = outcomes.filter((o) => o.status === 'fulfilled');
    const failed = outcomes.filter((o) => o.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const product = await Product.findOne({ sku: 'COKE-001' });
    expect(product?.quantity).toBe(0); // never negative
  });
});
