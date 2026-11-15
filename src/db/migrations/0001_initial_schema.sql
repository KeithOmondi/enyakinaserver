-- 0001_initial_schema
-- Money: BIGINT cents. Quantities: NUMERIC(12,3). Every tenant table carries business_id.

CREATE TABLE businesses (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code           text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9-]+$'),
  name           text NOT NULL,
  phone          text,
  address        text,
  receipt_footer text,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_super_admin boolean NOT NULL DEFAULT false,
  active         boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_key ON users (lower(email));

CREATE TABLE user_businesses (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  business_id uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  role        text NOT NULL CHECK (role IN ('admin', 'shop_manager')),
  PRIMARY KEY (user_id, business_id)
);
CREATE INDEX user_businesses_business_idx ON user_businesses (business_id);

-- Refresh tokens are stored hashed and rotated on every use.
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  char(64) NOT NULL UNIQUE,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);

CREATE TABLE categories (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name        text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX categories_business_name_key ON categories (business_id, lower(name));

CREATE TABLE suppliers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id uuid NOT NULL REFERENCES businesses(id),
  name        text NOT NULL,
  phone       text,
  email       text,
  notes       text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX suppliers_business_name_key ON suppliers (business_id, lower(name));

CREATE TABLE products (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  category_id     uuid REFERENCES categories(id),
  sku             text NOT NULL,
  barcode         text,
  name            text NOT NULL,
  unit            text NOT NULL DEFAULT 'pcs',
  allows_fraction boolean NOT NULL DEFAULT false,
  price_cents     bigint NOT NULL CHECK (price_cents >= 0),
  cost_cents      bigint NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),
  reorder_level   numeric(12,3) NOT NULL DEFAULT 0 CHECK (reorder_level >= 0),
  active          boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX products_business_sku_key ON products (business_id, lower(sku));
CREATE UNIQUE INDEX products_business_barcode_key ON products (business_id, barcode) WHERE barcode IS NOT NULL;
CREATE INDEX products_business_name_idx ON products (business_id, lower(name));
CREATE INDEX products_category_idx ON products (category_id);

-- Current stock. Only changed together with a stock_movements row (see services/stock.ts).
CREATE TABLE stock_levels (
  product_id  uuid PRIMARY KEY REFERENCES products(id),
  business_id uuid NOT NULL REFERENCES businesses(id),
  quantity    numeric(12,3) NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_levels_business_idx ON stock_levels (business_id);

-- Append-only ledger of every stock change.
CREATE TABLE stock_movements (
  id            bigserial PRIMARY KEY,
  business_id   uuid NOT NULL REFERENCES businesses(id),
  product_id    uuid NOT NULL REFERENCES products(id),
  type          text NOT NULL CHECK (type IN ('opening', 'purchase', 'sale', 'void', 'adjustment')),
  quantity      numeric(12,3) NOT NULL CHECK (quantity <> 0),
  balance_after numeric(12,3) NOT NULL,
  reference_id  uuid,
  note          text,
  user_id       uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stock_movements_product_idx ON stock_movements (business_id, product_id, created_at DESC);
CREATE INDEX stock_movements_created_idx ON stock_movements (business_id, created_at DESC);

CREATE TABLE purchases (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  supplier_id     uuid REFERENCES suppliers(id),
  reference       text,
  note            text,
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  idempotency_key text,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX purchases_idem_key ON purchases (business_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX purchases_business_created_idx ON purchases (business_id, created_at DESC);

CREATE TABLE purchase_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id     uuid NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id      uuid NOT NULL REFERENCES products(id),
  quantity        numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_cost_cents bigint NOT NULL CHECK (unit_cost_cents >= 0)
);
CREATE INDEX purchase_items_purchase_idx ON purchase_items (purchase_id);

CREATE TABLE receipt_counters (
  business_id uuid PRIMARY KEY REFERENCES businesses(id),
  last_no     bigint NOT NULL DEFAULT 0
);

CREATE TABLE sales (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     uuid NOT NULL REFERENCES businesses(id),
  receipt_no      bigint NOT NULL,
  status          text NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'voided')),
  subtotal_cents  bigint NOT NULL CHECK (subtotal_cents >= 0),
  discount_cents  bigint NOT NULL DEFAULT 0 CHECK (discount_cents >= 0),
  total_cents     bigint NOT NULL CHECK (total_cents >= 0),
  paid_cents      bigint NOT NULL CHECK (paid_cents >= 0),
  change_cents    bigint NOT NULL DEFAULT 0 CHECK (change_cents >= 0),
  note            text,
  idempotency_key text NOT NULL,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  voided_at       timestamptz,
  voided_by       uuid REFERENCES users(id),
  void_reason     text,
  CHECK (discount_cents <= subtotal_cents)
);
CREATE UNIQUE INDEX sales_business_receipt_key ON sales (business_id, receipt_no);
CREATE UNIQUE INDEX sales_business_idem_key ON sales (business_id, idempotency_key);
CREATE INDEX sales_business_created_idx ON sales (business_id, created_at DESC);

CREATE TABLE sale_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id          uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id       uuid NOT NULL REFERENCES products(id),
  name             text NOT NULL,
  quantity         numeric(12,3) NOT NULL CHECK (quantity > 0),
  unit_price_cents bigint NOT NULL CHECK (unit_price_cents >= 0),
  unit_cost_cents  bigint NOT NULL CHECK (unit_cost_cents >= 0),
  line_total_cents bigint NOT NULL CHECK (line_total_cents >= 0)
);
CREATE INDEX sale_items_sale_idx ON sale_items (sale_id);
CREATE INDEX sale_items_product_idx ON sale_items (product_id);

CREATE TABLE payments (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id      uuid NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  business_id  uuid NOT NULL REFERENCES businesses(id),
  method       text NOT NULL CHECK (method IN ('cash', 'mpesa', 'card')),
  amount_cents bigint NOT NULL CHECK (amount_cents > 0),
  reference    text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX payments_sale_idx ON payments (sale_id);
CREATE INDEX payments_business_created_idx ON payments (business_id, created_at DESC);

CREATE TABLE daily_closings (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id         uuid NOT NULL REFERENCES businesses(id),
  business_date       date NOT NULL,
  sales_count         integer NOT NULL,
  total_cents         bigint NOT NULL,
  cash_cents          bigint NOT NULL,
  mpesa_cents         bigint NOT NULL,
  card_cents          bigint NOT NULL,
  counted_cash_cents  bigint NOT NULL CHECK (counted_cash_cents >= 0),
  variance_cents      bigint NOT NULL,
  note                text,
  closed_by           uuid NOT NULL REFERENCES users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (business_id, business_date)
);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  business_id uuid REFERENCES businesses(id),
  user_id     uuid REFERENCES users(id),
  action      text NOT NULL,
  entity      text NOT NULL,
  entity_id   text,
  details     jsonb,
  ip          text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_business_created_idx ON audit_log (business_id, created_at DESC);
