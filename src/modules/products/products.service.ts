import { query, type Queryable } from '../../config/db';
import { withTransaction, type TxClient } from '../../db/transaction';
import { audit, type AuditEntry } from '../../services/audit';
import { randomUUID } from 'node:crypto';
import { applyStockChange } from '../../services/stock';
import { deleteObject, publicUrl, putObject, storageConfigured } from '../../services/storage';
import { AppError } from '../../utils/AppError';
import { offsetOf, type Page } from '../../utils/pagination';
import { internalBarcode, skuFor } from '../../utils/productCodes';
import { escapeLike } from '../../utils/validators';

export interface Product {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  categoryId: string | null;
  categoryName: string | null;
  /** Set when the product is in a sub-category: the top-level category it belongs to. */
  parentCategoryId: string | null;
  parentCategoryName: string | null;
  unit: string;
  allowsFraction: boolean;
  priceCents: number;
  costCents: number;
  reorderLevel: number;
  active: boolean;
  imageUrl: string | null;
  quantity: number;
  lowStock: boolean;
}

/** A product as read from SQL: the photo is a storage key until it is shaped into a URL. */
type ProductRow = Omit<Product, 'imageUrl'> & { imageKey: string | null };

function shape({ imageKey, ...rest }: ProductRow): Product {
  return { ...rest, imageUrl: publicUrl(imageKey) };
}

/** Shared by products, inventory and reports so "low stock" means one thing everywhere. */
export const PRODUCT_SELECT = `
  SELECT p.id, p.sku, p.barcode, p.name, p.category_id, c.name AS category_name, c.parent_id AS parent_category_id, pc.name AS parent_category_name, p.unit,
         p.allows_fraction, p.price_cents, p.cost_cents, p.reorder_level, p.active, p.image_key,
         s.quantity, (p.reorder_level > 0 AND s.quantity <= p.reorder_level) AS low_stock
    FROM products p
    JOIN stock_levels s ON s.product_id = p.id
    LEFT JOIN categories c ON c.id = p.category_id
    LEFT JOIN categories pc ON pc.id = c.parent_id`;

export interface ProductFilter {
  q?: string;
  categoryId?: string;
  status: 'active' | 'inactive' | 'all';
  lowStock?: boolean;
  page: number;
  pageSize: number;
}

export async function listProducts(businessId: string, f: ProductFilter): Promise<Page<Product>> {
  const where: string[] = ['p.business_id = $1'];
  const params: unknown[] = [businessId];
  const add = (sql: string, value: unknown) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (f.q) {
    params.push(`%${escapeLike(f.q)}%`, f.q);
    where.push(
      `(p.name ILIKE $${params.length - 1} OR p.sku ILIKE $${params.length - 1} OR p.barcode = $${params.length})`,
    );
  }
  if (f.categoryId) {
    // A top-level category includes everything in its sub-categories.
    params.push(f.categoryId);
    where.push(`p.category_id IN (SELECT id FROM categories WHERE id = $${params.length} OR parent_id = $${params.length})`);
  }
  if (f.status !== 'all') add('p.active = ?', f.status === 'active');
  if (f.lowStock) where.push('p.reorder_level > 0 AND s.quantity <= p.reorder_level');

  const clause = where.join(' AND ');
  const [count] = await query<{ total: number }>(
    `SELECT count(*) AS total FROM products p JOIN stock_levels s ON s.product_id = p.id WHERE ${clause}`,
    params,
  );
  const rows = await query<ProductRow>(
    `${PRODUCT_SELECT} WHERE ${clause} ORDER BY lower(p.name), p.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
  );
  return { items: rows.map(shape), total: count?.total ?? 0, page: f.page, pageSize: f.pageSize };
}

export async function getProduct(businessId: string, id: string, db?: Queryable): Promise<Product> {
  const [p] = await query<ProductRow>(`${PRODUCT_SELECT} WHERE p.business_id = $1 AND p.id = $2`, [businessId, id], db);
  if (!p) throw AppError.notFound('Product');
  return shape(p);
}

async function assertCategory(db: Queryable, businessId: string, categoryId: string | null | undefined) {
  if (!categoryId) return;
  const rows = await query('SELECT 1 FROM categories WHERE id = $1 AND business_id = $2', [categoryId, businessId], db);
  if (rows.length === 0) throw AppError.validation([{ path: 'categoryId', message: 'Category not found' }]);
}

export interface ProductInput {
  /** Normally omitted: the system generates the SKU. */
  sku?: string | undefined;
  barcode?: string | null;
  name: string;
  categoryId?: string | null;
  unit: string;
  allowsFraction: boolean;
  priceCents: number;
  costCents: number;
  reorderLevel: number;
}

/**
 * Takes the next product number for a business and builds its SKU and barcode from it. Skips a
 * number whose SKU or barcode is already used (for example a hand-picked SKU from an import).
 */
async function nextCodes(tx: TxClient, businessId: string): Promise<{ sku: string; barcode: string }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const [b] = await query<{ code: string; productSeq: number }>(
      'UPDATE businesses SET product_seq = product_seq + 1 WHERE id = $1 RETURNING code, product_seq',
      [businessId],
      tx,
    );
    const seq = Number(b!.productSeq);
    const sku = skuFor(b!.code, seq);
    const barcode = internalBarcode(seq);
    const clash = await query(
      'SELECT 1 FROM products WHERE business_id = $1 AND (lower(sku) = lower($2) OR barcode = $3)',
      [businessId, sku, barcode],
      tx,
    );
    if (clash.length === 0) return { sku, barcode };
  }
  throw AppError.conflict('Could not generate a product code. Try again.');
}

export async function createProduct(
  businessId: string,
  userId: string,
  input: ProductInput & { openingStock: number },
  entry: AuditEntry,
): Promise<Product> {
  return withTransaction(async (tx) => {
    await assertCategory(tx, businessId, input.categoryId);
    const codes = await nextCodes(tx, businessId);
    const sku = input.sku ?? codes.sku;
    const barcode = input.barcode ?? codes.barcode;
    const [row] = await query<{ id: string }>(
      `INSERT INTO products (business_id, category_id, sku, barcode, name, unit, allows_fraction,
                             price_cents, cost_cents, reorder_level)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [
        businessId, input.categoryId ?? null, sku, barcode, input.name,
        input.unit, input.allowsFraction, input.priceCents, input.costCents, input.reorderLevel,
      ],
      tx,
    );
    const id = row!.id;
    await query('INSERT INTO stock_levels (product_id, business_id, quantity) VALUES ($1, $2, 0)', [id, businessId], tx);
    if (input.openingStock > 0) {
      await applyStockChange(tx, {
        businessId, productId: id, quantity: input.openingStock, type: 'opening', userId, note: 'Opening stock',
      });
    }
    await audit({ ...entry, entityId: id, details: { sku, name: input.name } }, tx);
    return getProduct(businessId, id, tx);
  });
}

export async function updateProduct(
  businessId: string,
  id: string,
  patch: Partial<ProductInput> & { active?: boolean },
  entry: AuditEntry,
): Promise<Product> {
  return withTransaction(async (tx) => {
    const before = await getProduct(businessId, id, tx);
    await assertCategory(tx, businessId, patch.categoryId);
    const has = (k: keyof typeof patch) => k in patch;
    await query(
      `UPDATE products SET
         name = COALESCE($3, name),
         category_id = CASE WHEN $4::boolean THEN $5::uuid ELSE category_id END,
         unit = COALESCE($6, unit),
         allows_fraction = COALESCE($7, allows_fraction),
         price_cents = COALESCE($8, price_cents),
         cost_cents = COALESCE($9, cost_cents),
         reorder_level = COALESCE($10, reorder_level),
         active = COALESCE($11, active),
         updated_at = now()
       WHERE id = $1 AND business_id = $2`,
      [
        id, businessId,
        patch.name ?? null,
        has('categoryId'), patch.categoryId ?? null,
        patch.unit ?? null, patch.allowsFraction ?? null, patch.priceCents ?? null,
        patch.costCents ?? null, patch.reorderLevel ?? null, patch.active ?? null,
      ],
      tx,
    );
    const priceChanged = patch.priceCents !== undefined && patch.priceCents !== before.priceCents;
    await audit(
      {
        ...entry,
        entityId: id,
        action: priceChanged ? 'product_price_changed' : entry.action,
        details: { patch, ...(priceChanged ? { oldPriceCents: before.priceCents } : {}) },
      },
      tx,
    );
    return getProduct(businessId, id, tx);
  });
}

const IMAGE_TYPES: Record<string, { ext: string; matches: (b: Buffer) => boolean }> = {
  'image/jpeg': { ext: 'jpg', matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': {
    ext: 'png',
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  'image/webp': {
    ext: 'webp',
    matches: (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  },
};

/**
 * Stores a product photo. The file's real bytes must match its declared type (the header
 * alone proves nothing), it goes under this business's folder with a random name, and the
 * previous photo is deleted afterwards. A failure never leaves the product pointing at nothing.
 */
export async function setProductImage(
  businessId: string,
  id: string,
  body: Buffer,
  contentType: string,
  entry: AuditEntry,
): Promise<Product> {
  if (!storageConfigured()) {
    throw new AppError(503, 'INTERNAL_ERROR', 'Image storage is not configured on this server');
  }
  const type = IMAGE_TYPES[contentType];
  if (!type) throw new AppError(415, 'BAD_REQUEST', 'Upload a JPEG, PNG or WebP image');
  if (body.length === 0 || !type.matches(body)) {
    throw new AppError(415, 'BAD_REQUEST', 'That file is not a valid image');
  }

  const [old] = await query<{ imageKey: string | null }>(
    'SELECT image_key FROM products WHERE id = $1 AND business_id = $2',
    [id, businessId],
  );
  if (!old) throw AppError.notFound('Product');

  const key = `businesses/${businessId}/products/${id}/${randomUUID()}.${type.ext}`;
  await putObject(key, body, contentType).catch((err: Error) => {
    // Log the real cause for the operator; the user gets a clear, safe message.
    console.error('[storage] upload failed:', err.name, err.message);
    throw new AppError(502, 'INTERNAL_ERROR', 'The photo could not be saved to storage. Check the R2 settings on the server.');
  });
  try {
    await query('UPDATE products SET image_key = $3, updated_at = now() WHERE id = $1 AND business_id = $2', [
      id,
      businessId,
      key,
    ]);
    await audit({ ...entry, entityId: id, details: { image: 'set', bytes: body.length } });
  } catch (err) {
    await deleteObject(key).catch(() => undefined);
    throw err;
  }
  if (old.imageKey) {
    await deleteObject(old.imageKey).catch((e: Error) =>
      console.error('[storage] could not delete the old image:', e.message),
    );
  }
  return getProduct(businessId, id);
}

export async function removeProductImage(businessId: string, id: string, entry: AuditEntry): Promise<Product> {
  const [old] = await query<{ imageKey: string | null }>(
    'SELECT image_key FROM products WHERE id = $1 AND business_id = $2',
    [id, businessId],
  );
  if (!old) throw AppError.notFound('Product');
  if (old.imageKey) {
    await query('UPDATE products SET image_key = NULL, updated_at = now() WHERE id = $1 AND business_id = $2', [
      id,
      businessId,
    ]);
    await audit({ ...entry, entityId: id, details: { image: 'removed' } });
    if (storageConfigured()) {
      await deleteObject(old.imageKey).catch((e: Error) =>
        console.error('[storage] could not delete the image:', e.message),
      );
    }
  }
  return getProduct(businessId, id);
}
