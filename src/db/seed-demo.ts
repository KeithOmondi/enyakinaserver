/**
 * DEMO DATA for local development: a catalogue, two deliveries and a week of sales for ONE
 * business. It goes through the real HTTP API (so every rule, ledger entry and receipt number
 * is genuine) and is then back-dated so reports have history.
 *
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='...' npm run seed:demo [business-code] [--reset]
 *
 * The API must be running. Never runs in production. Skips a business that already has
 * products; `--reset` first DELETES that business's products, stock, sales, purchases,
 * closings and audit entries (users are kept), then seeds again. The catalogue is placeholder:
 * edit or delete it in the admin app.
 */
import { closePool, pool, query } from '../config/db';
import { env, isProduction } from '../config/env';

const API = process.env.API_URL ?? `http://localhost:${env.PORT}/api`;
const args = process.argv.slice(2);
const CODE = args.find((a) => !a.startsWith('--')) ?? 'enyakin';
const RESET = args.includes('--reset');

type Json = Record<string, unknown>;
let token = '';
let businessId = '';

async function api<T = Json>(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(businessId ? { 'x-business-id': businessId } : {}),
      ...extra,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : {}) as T };
}

async function ok<T = Json>(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<T> {
  const r = await api<T>(method, path, body, extra);
  if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

// Deterministic pseudo-random numbers so a re-seeded database looks the same.
let state = 20260101;
function rand(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const int = (a: number, b: number) => a + Math.floor(rand() * (b - a + 1));
const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

interface Item {
  sku: string; name: string; cat: string; price: number; cost: number; stock: number;
  reorder?: number; unit?: string; loose?: boolean; barcode?: string;
}
interface Demo {
  items: Item[];
  suppliers: { name: string; phone: string; notes: string | null }[];
  deliveries: { supplier: number; ref: string; skus: string[]; qty: number }[];
  /** Cash is rounded up to this many cents when tendered (so there is change to give). */
  cashStep: number;
  mpesaShare: number;
  salesPerDay: [number, number];
}

/** Sizes are separate products (one SKU per size), since the system tracks stock per product. */
const sized = (base: Omit<Item, 'sku' | 'name' | 'stock'> & { sku: string; name: string }, sizes: [string, number][]): Item[] =>
  sizes.map(([size, stock]) => ({ ...base, sku: `${base.sku}-${size}`, name: `${base.name} (${size})`, stock }));

const DEMOS: Record<string, Demo> = {
  enyakin: {
    items: [
      ...sized({ sku: 'MN-POL', name: "Men's Polo Shirt", cat: "Men's Wear", price: 120000, cost: 75000, reorder: 4 }, [['M', 12], ['L', 14], ['XL', 8]]),
      ...sized({ sku: 'MN-TEE', name: "Men's Round-Neck T-Shirt", cat: "Men's Wear", price: 80000, cost: 45000, reorder: 5 }, [['M', 20], ['L', 18]]),
      ...sized({ sku: 'MN-JNS', name: "Men's Jeans", cat: "Men's Wear", price: 250000, cost: 160000, reorder: 3 }, [['32', 6], ['34', 9], ['36', 2]]),
      { sku: 'MN-FRM-L', name: "Men's Formal Shirt (L)", cat: "Men's Wear", price: 180000, cost: 110000, stock: 10, reorder: 3, barcode: '6161100020017' },
      { sku: 'MN-JKT-L', name: "Men's Bomber Jacket (L)", cat: "Men's Wear", price: 380000, cost: 250000, stock: 5, reorder: 2 },
      ...sized({ sku: 'WM-DRS', name: 'Floral Dress', cat: "Women's Wear", price: 220000, cost: 130000, reorder: 3 }, [['S', 7], ['M', 10], ['L', 1]]),
      { sku: 'WM-BLS-M', name: 'Ladies Blouse (M)', cat: "Women's Wear", price: 150000, cost: 90000, stock: 11, reorder: 3 },
      { sku: 'WM-SKT-M', name: 'Ladies Skirt (M)', cat: "Women's Wear", price: 130000, cost: 75000, stock: 9, reorder: 3 },
      { sku: 'WM-LEG-M', name: 'Leggings (M)', cat: "Women's Wear", price: 90000, cost: 50000, stock: 24, reorder: 6, barcode: '6161100020055' },
      { sku: 'WM-BAG', name: 'Ladies Handbag', cat: "Women's Wear", price: 200000, cost: 120000, stock: 6, reorder: 2 },
      { sku: 'KD-TEE-46', name: 'Kids T-Shirt (age 4-6)', cat: 'Kids', price: 60000, cost: 35000, stock: 16, reorder: 5 },
      { sku: 'KD-TEE-79', name: 'Kids T-Shirt (age 7-9)', cat: 'Kids', price: 65000, cost: 38000, stock: 14, reorder: 5 },
      { sku: 'KD-SCH-SHT', name: 'School Uniform Shirt', cat: 'Kids', price: 90000, cost: 55000, stock: 30, reorder: 10 },
      { sku: 'KD-SHRT', name: 'Kids Shorts', cat: 'Kids', price: 70000, cost: 40000, stock: 0, reorder: 6 },
      { sku: 'KD-DRS', name: 'Kids Party Dress', cat: 'Kids', price: 140000, cost: 80000, stock: 7, reorder: 2 },
      { sku: 'FW-SNK-42', name: 'Sneakers (size 42)', cat: 'Footwear', price: 350000, cost: 230000, stock: 8, reorder: 2, barcode: '6161100020123' },
      { sku: 'FW-SNK-44', name: 'Sneakers (size 44)', cat: 'Footwear', price: 350000, cost: 230000, stock: 5, reorder: 2 },
      { sku: 'FW-SND-40', name: 'Leather Sandals (size 40)', cat: 'Footwear', price: 180000, cost: 100000, stock: 9, reorder: 3 },
      { sku: 'FW-HLS-38', name: 'Ladies Heels (size 38)', cat: 'Footwear', price: 280000, cost: 170000, stock: 6, reorder: 2 },
      { sku: 'FW-SCH-35', name: 'School Shoes (size 35)', cat: 'Footwear', price: 220000, cost: 140000, stock: 12, reorder: 4 },
      { sku: 'AC-BLT', name: 'Leather Belt', cat: 'Accessories', price: 90000, cost: 50000, stock: 22, reorder: 6 },
      { sku: 'AC-SOX', name: 'Socks (3-pack)', cat: 'Accessories', price: 50000, cost: 28000, stock: 40, reorder: 12 },
      { sku: 'AC-CAP', name: 'Baseball Cap', cat: 'Accessories', price: 70000, cost: 38000, stock: 15, reorder: 5 },
      { sku: 'AC-SCF', name: 'Scarf', cat: 'Accessories', price: 80000, cost: 45000, stock: 3, reorder: 6 },
      { sku: 'AC-SUN', name: 'Sunglasses', cat: 'Accessories', price: 60000, cost: 30000, stock: 18, reorder: 5 },
    ],
    suppliers: [
      { name: 'Gikomba Traders', phone: '+254 700 000 001', notes: 'Second-hand and new men\'s and kids\' wear. Pay on delivery.' },
      { name: 'Eastleigh Fashion Wholesale', phone: '+254 700 000 002', notes: "Women's wear and accessories." },
      { name: 'Nairobi Footwear Depot', phone: '+254 700 000 003', notes: null },
    ],
    deliveries: [
      { supplier: 0, ref: 'INV-2214', skus: ['MN-POL-M', 'MN-POL-L', 'MN-TEE-M', 'MN-TEE-L', 'KD-SCH-SHT'], qty: 10 },
      { supplier: 2, ref: 'INV-0391', skus: ['FW-SNK-42', 'FW-SCH-35', 'FW-SND-40'], qty: 6 },
    ],
    cashStep: 10000, // KES 100
    mpesaShare: 0.5,
    salesPerDay: [3, 8],
  },

  'go-fish': {
    items: [
      // Fresh lake fish, sold loose by weight (kg).
      { sku: 'FR-TIL', name: 'Tilapia (whole)', cat: 'Fresh Fish', price: 50000, cost: 35000, stock: 45, reorder: 15, unit: 'kg', loose: true },
      { sku: 'FR-NPW', name: 'Nile Perch (whole)', cat: 'Fresh Fish', price: 60000, cost: 42000, stock: 30, reorder: 10, unit: 'kg', loose: true },
      { sku: 'FR-NPF', name: 'Nile Perch Fillet', cat: 'Fresh Fish', price: 95000, cost: 70000, stock: 20, reorder: 8, unit: 'kg', loose: true },
      { sku: 'FR-CAT', name: 'Catfish (mumi)', cat: 'Fresh Fish', price: 55000, cost: 38000, stock: 4, reorder: 10, unit: 'kg', loose: true },
      { sku: 'FR-OMN', name: 'Omena (fresh)', cat: 'Fresh Fish', price: 30000, cost: 20000, stock: 18, reorder: 8, unit: 'kg', loose: true },
      // Ocean fish and shellfish.
      { sku: 'SF-TUN', name: 'Tuna Steaks', cat: 'Sea Fish & Shellfish', price: 120000, cost: 90000, stock: 10, reorder: 4, unit: 'kg', loose: true },
      { sku: 'SF-SNP', name: 'Red Snapper', cat: 'Sea Fish & Shellfish', price: 110000, cost: 80000, stock: 8, reorder: 4, unit: 'kg', loose: true },
      { sku: 'SF-PRW', name: 'Prawns (large)', cat: 'Sea Fish & Shellfish', price: 180000, cost: 140000, stock: 6, reorder: 5, unit: 'kg', loose: true },
      { sku: 'SF-SQD', name: 'Squid', cat: 'Sea Fish & Shellfish', price: 90000, cost: 65000, stock: 0, reorder: 4, unit: 'kg', loose: true },
      { sku: 'SF-CRB', name: 'Crab', cat: 'Sea Fish & Shellfish', price: 70000, cost: 50000, stock: 7, reorder: 3, unit: 'kg', loose: true },
      // Smoked and dried.
      { sku: 'SD-OMN', name: 'Omena (dried)', cat: 'Smoked & Dried', price: 40000, cost: 28000, stock: 25, reorder: 10, unit: 'kg', loose: true },
      { sku: 'SD-STL', name: 'Smoked Tilapia', cat: 'Smoked & Dried', price: 70000, cost: 50000, stock: 14, reorder: 6, unit: 'kg', loose: true },
      { sku: 'SD-DNP', name: 'Dried Nile Perch', cat: 'Smoked & Dried', price: 85000, cost: 60000, stock: 9, reorder: 4, unit: 'kg', loose: true },
      // Frozen and packaged (counted in pieces).
      { sku: 'FZ-TLF', name: 'Frozen Tilapia Fillet 1kg', cat: 'Frozen & Packaged', price: 75000, cost: 55000, stock: 20, reorder: 6, barcode: '6161100030014' },
      { sku: 'FZ-FNG', name: 'Fish Fingers 500g', cat: 'Frozen & Packaged', price: 45000, cost: 32000, stock: 18, reorder: 6, barcode: '6161100030021' },
      { sku: 'FZ-SPC', name: 'Fish Seasoning 100g', cat: 'Frozen & Packaged', price: 8000, cost: 5000, stock: 40, reorder: 12 },
      // Extras customers buy with their fish.
      { sku: 'EX-OIL', name: 'Cooking Oil 1L', cat: 'Extras', price: 32000, cost: 27500, stock: 24, reorder: 8, barcode: '6161100030045' },
      { sku: 'EX-LMN', name: 'Lemon', cat: 'Extras', price: 1000, cost: 600, stock: 80, reorder: 20 },
      { sku: 'EX-CHR', name: 'Charcoal 2kg Bag', cat: 'Extras', price: 15000, cost: 10000, stock: 15, reorder: 6 },
      { sku: 'EX-ICE', name: 'Ice Block 5kg', cat: 'Extras', price: 20000, cost: 12000, stock: 30, reorder: 10 },
    ],
    suppliers: [
      { name: "Lake Victoria Fishermen's Cooperative", phone: '+254 700 000 011', notes: 'Fresh tilapia, Nile perch and catfish. Daily landings, pay on collection.' },
      { name: 'Kisumu Landing Beach Traders', phone: '+254 700 000 012', notes: 'Omena and smoked fish.' },
      { name: 'Mombasa Coastal Seafood', phone: '+254 700 000 013', notes: 'Tuna, snapper, prawns, squid and crab. Delivered chilled twice a week.' },
    ],
    deliveries: [
      { supplier: 0, ref: 'LND-3308', skus: ['FR-TIL', 'FR-NPW', 'FR-CAT'], qty: 20 },
      { supplier: 2, ref: 'MSA-1175', skus: ['SF-TUN', 'SF-SNP', 'SF-PRW'], qty: 8 },
    ],
    cashStep: 5000, // KES 50
    mpesaShare: 0.55,
    salesPerDay: [10, 20],
  },
};

function dayOffset(todayStr: string, days: number): string {
  const d = new Date(`${todayStr}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Deletes everything a business has except its users and the business row itself. */
async function resetBusiness(id: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const sql of [
      'DELETE FROM sales WHERE business_id = $1', // sale_items and payments cascade
      'DELETE FROM mpesa_requests WHERE business_id = $1',
      'DELETE FROM purchases WHERE business_id = $1', // purchase_items cascade
      'DELETE FROM stock_movements WHERE business_id = $1',
      'DELETE FROM stock_levels WHERE business_id = $1',
      'DELETE FROM products WHERE business_id = $1',
      'DELETE FROM categories WHERE business_id = $1',
      'DELETE FROM suppliers WHERE business_id = $1',
      'DELETE FROM daily_closings WHERE business_id = $1',
      'DELETE FROM receipt_counters WHERE business_id = $1',
      'DELETE FROM audit_log WHERE business_id = $1',
    ]) await client.query(sql, [id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function main(): Promise<void> {
  if (isProduction) throw new Error('Demo data is for development only');
  const demo = DEMOS[CODE];
  if (!demo) throw new Error(`No demo catalogue for "${CODE}". Available: ${Object.keys(DEMOS).join(', ')}`);
  const email = process.env.SEED_ADMIN_EMAIL;
  const password = process.env.SEED_ADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD (an admin of the business)');

  const login = await ok<{ accessToken: string; businesses: { id: string; code: string; name: string }[] }>('POST', '/auth/login', { email, password });
  token = login.accessToken;
  const biz = login.businesses.find((b) => b.code === CODE);
  if (!biz) throw new Error(`No business with code "${CODE}" for this user`);
  businessId = biz.id;

  if (RESET) {
    await resetBusiness(biz.id);
    console.log(`Cleared ${biz.name}'s catalogue, stock, sales, purchases and closings.`);
  }
  const existing = await ok<{ total: number }>('GET', '/products?pageSize=1&status=all');
  if (existing.total > 0) {
    console.log(`${biz.name} already has ${existing.total} products: skipping. Use --reset to replace them.`);
    return;
  }
  console.log(`Adding demo data to ${biz.name}...`);

  const catIds = new Map<string, string>();
  for (const name of [...new Set(demo.items.map((p) => p.cat))]) {
    catIds.set(name, (await ok<{ id: string }>('POST', '/categories', { name })).id);
  }
  const supplierIds: string[] = [];
  for (const s of demo.suppliers) supplierIds.push((await ok<{ id: string }>('POST', '/suppliers', s)).id);

  const products: { id: string; item: Item }[] = [];
  for (const item of demo.items) {
    const p = await ok<{ id: string }>('POST', '/products', {
      sku: item.sku, name: item.name, categoryId: catIds.get(item.cat), unit: item.unit ?? 'pcs',
      allowsFraction: item.loose ?? false, priceCents: item.price, costCents: item.cost,
      reorderLevel: item.reorder ?? 0, openingStock: item.stock, barcode: item.barcode ?? null,
    });
    products.push({ id: p.id, item });
  }
  const bySku = (sku: string) => {
    const p = products.find((x) => x.item.sku === sku);
    if (!p) throw new Error(`Demo delivery references unknown SKU ${sku}`);
    return p;
  };
  console.log(`  ${catIds.size} categories, ${supplierIds.length} suppliers, ${products.length} products`);

  for (const d of demo.deliveries) {
    await ok('POST', '/purchases', {
      supplierId: supplierIds[d.supplier], reference: d.ref,
      items: d.skus.map((sku) => ({ productId: bySku(sku).id, quantity: d.qty, unitCostCents: bySku(sku).item.cost })),
    }, { 'idempotency-key': `demo-${CODE}-${d.ref}` });
  }
  console.log(`  ${demo.deliveries.length} deliveries received`);

  // A week of sales, oldest first so receipt numbers follow the calendar.
  const [{ today }] = (await query(`SELECT (now() AT TIME ZONE $1)::date::text AS today`, [env.BUSINESS_TIMEZONE])) as [{ today: string }];
  const saleDays: { id: string; daysAgo: number }[] = [];
  const sellable = products.filter((p) => p.item.stock > 0);
  for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
    const count = daysAgo === 0 ? int(2, 4) : int(demo.salesPerDay[0], demo.salesPerDay[1]);
    for (let i = 0; i < count; i++) {
      const lines = new Map<string, number>();
      for (let n = int(1, 3); n > 0; n--) {
        const p = pick(sellable);
        lines.set(p.id, p.item.loose ? int(1, 6) / 2 : rand() < 0.8 ? 1 : 2);
      }
      const items = [...lines].map(([productId, quantity]) => ({ productId, quantity }));
      const total = items.reduce((s, it) => s + Math.round(products.find((p) => p.id === it.productId)!.item.price * it.quantity), 0);
      const mpesa = rand() < demo.mpesaShare;
      const tendered = mpesa ? total : Math.ceil(total / demo.cashStep) * demo.cashStep;
      const payments = [{ method: mpesa ? 'mpesa' : 'cash', amountCents: tendered, ...(mpesa ? { reference: `S${int(10, 99)}${pick(['QK', 'LM', 'TR', 'WX'])}${int(1000, 9999)}` } : {}) }];
      const r = await api<{ id: string }>('POST', '/sales', { items, payments, discountCents: 0 }, { 'idempotency-key': `demo-${CODE}-${daysAgo}-${i}` });
      if (r.status === 201) saleDays.push({ id: r.data.id, daysAgo });
    }
  }

  // Back-date: deliveries and opening stock a week ago, each sale to a plausible time on its day.
  await query(`UPDATE stock_movements SET created_at = now() - interval '8 days' WHERE business_id = $1 AND type IN ('opening', 'purchase')`, [businessId]);
  await query(`UPDATE purchases SET created_at = now() - interval '8 days' WHERE business_id = $1`, [businessId]);
  for (const s of saleDays) {
    if (s.daysAgo === 0) continue;
    const stamp = `${dayOffset(today, -s.daysAgo)} ${String(int(8, 19)).padStart(2, '0')}:${String(int(0, 59)).padStart(2, '0')}:00`;
    const when = '($2::timestamp AT TIME ZONE $3)';
    await query(`UPDATE sales SET created_at = ${when} WHERE id = $1`, [s.id, stamp, env.BUSINESS_TIMEZONE]);
    await query(`UPDATE payments SET created_at = ${when} WHERE sale_id = $1`, [s.id, stamp, env.BUSINESS_TIMEZONE]);
    await query(`UPDATE stock_movements SET created_at = ${when} WHERE reference_id = $1 AND type = 'sale'`, [s.id, stamp, env.BUSINESS_TIMEZONE]);
  }
  console.log(`  ${saleDays.length} sales over the last 7 days`);

  // One void (shows the void flow and its audit entry) and yesterday closed with a small shortage.
  const toVoid = saleDays.find((s) => s.daysAgo === 2);
  if (toVoid) await ok('POST', `/sales/${toVoid.id}/void`, { reason: 'Customer returned the items' });
  const yesterday = dayOffset(today, -1);
  const preview = await ok<{ expectedCashCents: number }>('GET', `/closings/preview?date=${yesterday}`);
  await ok('POST', '/closings', { date: yesterday, countedCashCents: Math.max(0, preview.expectedCashCents - 10000), note: 'Demo day close' });
  console.log('  1 voided sale, yesterday closed');
  console.log('Done.');
}

main()
  .catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
