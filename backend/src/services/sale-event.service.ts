import { NormalizedSaleEvent } from '../providers/pos-provider.interface';
import { productRepository } from '../repositories/product.repository';
import { allocationRepository } from '../repositories/allocation.repository';
import { transactionRepository } from '../repositories/transaction.repository';
import { InventoryTransaction, IInventoryTransaction } from '../models/InventoryTransaction';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';

export interface SaleProcessingResult {
  status: 'processed' | 'duplicate';
  transaction: IInventoryTransaction;
  productQuantityBefore?: number;
  productQuantityAfter?: number;
  allocationBefore?: number;
  allocationAfter?: number;
}

const MONGO_DUPLICATE_KEY_ERROR = 11000;

// Single code path for turning a POS sale (webhook or simulate) into inventory changes.
// Idempotent via a unique index on idempotencyKey; atomic via conditional decrements (see README).
export async function processSaleEvent(
  event: NormalizedSaleEvent,
  source: 'webhook' | 'simulation',
): Promise<SaleProcessingResult> {
  if (event.quantity <= 0) {
    throw AppError.badRequest('Sale quantity must be positive.', 'VALIDATION_ERROR');
  }

  const idempotencyKey = `${event.provider}:${event.externalTransactionId}`;

  // The unique index on idempotencyKey is the actual concurrency gate — reserving the slot with
  // an insert FIRST, before any decrement, is what makes this atomic. A plain "check then insert"
  // (the previous approach) has a race: concurrent deliveries of the same event can all pass the
  // check before any of them inserts, each going on to decrement inventory independently.
  const reservation = await safeInsertTransaction({
    provider: event.provider,
    externalTransactionId: event.externalTransactionId,
    quantity: event.quantity,
    type: 'SALE',
    source,
    status: 'FAILED', // placeholder, corrected below once the real outcome is known
    processedAt: event.occurredAt,
    idempotencyKey,
    metadata: { raw: event.raw },
  });
  if (reservation.status === 'duplicate') {
    logger.info('Duplicate POS sale event ignored', { idempotencyKey });
    return { status: 'duplicate', transaction: reservation.transaction };
  }
  const transaction = reservation.transaction;

  const allocation = await allocationRepository.findByPosProduct(event.provider, event.posProductId);
  if (!allocation) {
    transaction.errorMessage = `No allocation mapping found for ${event.provider} product ${event.posProductId}.`;
    await transaction.save();
    throw AppError.unprocessable(
      `Received a sale for an unmapped ${event.provider} product (${event.posProductId}). No inventory was changed.`,
      'UNMAPPED_POS_PRODUCT',
    );
  }

  const productId = String(allocation.productId);
  const before = await productRepository.findById(productId);
  if (!before) {
    throw AppError.notFound('Mapped product no longer exists.', 'PRODUCT_NOT_FOUND');
  }

  const updatedProduct = await productRepository.decrementIfAvailable(productId, event.quantity);
  if (!updatedProduct) {
    transaction.productId = before._id;
    transaction.errorMessage = `Insufficient inventory: had ${before.quantity}, sale requested ${event.quantity}.`;
    await transaction.save();
    throw AppError.conflict(
      `Insufficient inventory for "${before.name}": had ${before.quantity}, sale requested ${event.quantity}.`,
      'INSUFFICIENT_INVENTORY',
    );
  }

  const allocationBefore = allocation.allocatedQuantity;
  const updatedAllocation = await allocationRepository.decrementClampedById(String(allocation._id), event.quantity);

  transaction.productId = before._id;
  transaction.status = 'COMPLETED';
  await transaction.save();

  return {
    status: 'processed',
    transaction,
    productQuantityBefore: before.quantity,
    productQuantityAfter: updatedProduct.quantity,
    allocationBefore,
    allocationAfter: updatedAllocation?.allocatedQuantity ?? allocationBefore,
  };
}

async function safeInsertTransaction(
  data: Partial<IInventoryTransaction>,
): Promise<{ status: 'processed' | 'duplicate'; transaction: IInventoryTransaction }> {
  try {
    const transaction = await InventoryTransaction.create(data);
    return { status: 'processed', transaction };
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      const existing = await transactionRepository.findByIdempotencyKey(data.idempotencyKey as string);
      if (existing) return { status: 'duplicate', transaction: existing };
    }
    throw err;
  }
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === MONGO_DUPLICATE_KEY_ERROR;
}
