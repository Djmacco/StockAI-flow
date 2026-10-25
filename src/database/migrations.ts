import type { Db } from './db';

/**
 * Every syncable business table carries the same bookkeeping columns:
 *   id (UUID v7) · created_at · updated_at · device_id · version ·
 *   sync_status (PENDING | SYNCED | CONFLICT) · deleted_at (soft delete)
 *
 * Money is stored as INTEGER in XAF (no decimals). Quantities are REAL so
 * weighed goods (kg, litres) work. Timestamps are ISO-8601 UTC strings.
 */
const COMMON = `
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  sync_status TEXT NOT NULL DEFAULT 'PENDING',
  deleted_at TEXT`;

const V1 = `
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------------------- access control (local)
CREATE TABLE roles (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  is_system INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE role_permissions (
  role_code TEXT NOT NULL REFERENCES roles(code) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  PRIMARY KEY (role_code, permission)
);
CREATE TABLE users (${COMMON},
  username TEXT NOT NULL,
  full_name TEXT NOT NULL,
  email TEXT,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL,
  role_code TEXT NOT NULL REFERENCES roles(code),
  active INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT
);
CREATE UNIQUE INDEX ux_users_username ON users(lower(username)) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------- catalogue
CREATE TABLE categories (${COMMON},
  name TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_categories_name ON categories(lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE suppliers (${COMMON},
  name TEXT NOT NULL,
  phone TEXT, email TEXT, address TEXT, notes TEXT
);

CREATE TABLE customers (${COMMON},
  name TEXT NOT NULL,
  phone TEXT, email TEXT, address TEXT,
  credit_limit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE products (${COMMON},
  name TEXT NOT NULL,
  sku TEXT,
  barcode TEXT,
  category_id TEXT REFERENCES categories(id),
  description TEXT,
  cost_price INTEGER NOT NULL DEFAULT 0,
  selling_price INTEGER NOT NULL DEFAULT 0,
  quantity REAL NOT NULL DEFAULT 0,
  minimum_stock REAL NOT NULL DEFAULT 0,
  unit TEXT NOT NULL DEFAULT 'pcs',
  supplier_id TEXT REFERENCES suppliers(id),
  expiry_date TEXT,
  image TEXT
);
CREATE INDEX ix_products_name ON products(name);
CREATE UNIQUE INDEX ux_products_sku ON products(lower(sku)) WHERE deleted_at IS NULL AND sku IS NOT NULL AND sku <> '';
CREATE UNIQUE INDEX ux_products_barcode ON products(barcode) WHERE deleted_at IS NULL AND barcode IS NOT NULL AND barcode <> '';
CREATE INDEX ix_products_category ON products(category_id);

-- A batch ("lot") is a received quantity with its own expiry date. Sales consume FIFO/FEFO.
CREATE TABLE product_batches (${COMMON},
  product_id TEXT NOT NULL REFERENCES products(id),
  lot_code TEXT,
  expiry_date TEXT,
  quantity_initial REAL NOT NULL,
  quantity_remaining REAL NOT NULL,
  cost_price INTEGER NOT NULL DEFAULT 0,
  received_at TEXT NOT NULL,
  purchase_id TEXT,
  supplier_id TEXT
);
CREATE INDEX ix_batches_product ON product_batches(product_id, expiry_date);

-- Immutable ledger. products.quantity is always SUM(stock_movements.quantity).
CREATE TABLE stock_movements (${COMMON},
  product_id TEXT NOT NULL REFERENCES products(id),
  batch_id TEXT,
  type TEXT NOT NULL,
  quantity REAL NOT NULL,
  previous_stock REAL NOT NULL,
  new_stock REAL NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  reference_type TEXT,
  reference_id TEXT,
  user_id TEXT,
  user_name TEXT
);
CREATE INDEX ix_movements_product ON stock_movements(product_id, created_at);
CREATE INDEX ix_movements_ref ON stock_movements(reference_type, reference_id);

-- ---------------------------------------------------------------- cash register
CREATE TABLE cash_sessions (${COMMON},
  user_id TEXT NOT NULL,
  user_name TEXT,
  opened_at TEXT NOT NULL,
  opening_float INTEGER NOT NULL DEFAULT 0,
  closed_at TEXT,
  expected_cash INTEGER,
  counted_cash INTEGER,
  difference INTEGER,
  status TEXT NOT NULL DEFAULT 'OPEN',
  notes TEXT
);

-- ---------------------------------------------------------------- sales
CREATE TABLE sales (${COMMON},
  receipt_no TEXT NOT NULL,
  customer_id TEXT REFERENCES customers(id),
  user_id TEXT,
  user_name TEXT,
  cash_session_id TEXT,
  subtotal INTEGER NOT NULL,
  discount_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL,
  change_due INTEGER NOT NULL DEFAULT 0,
  payment_method TEXT NOT NULL,
  cost_total INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'COMPLETED',
  notes TEXT,
  sold_at TEXT NOT NULL,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX ix_sales_sold_at ON sales(sold_at);
CREATE INDEX ix_sales_customer ON sales(customer_id);

CREATE TABLE sale_items (${COMMON},
  sale_id TEXT NOT NULL REFERENCES sales(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL
);
CREATE INDEX ix_sale_items_sale ON sale_items(sale_id);
CREATE INDEX ix_sale_items_product ON sale_items(product_id);

CREATE TABLE customer_payments (${COMMON},
  customer_id TEXT NOT NULL REFERENCES customers(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  note TEXT,
  paid_at TEXT NOT NULL,
  user_id TEXT
);

-- ---------------------------------------------------------------- purchases
CREATE TABLE purchases (${COMMON},
  reference TEXT NOT NULL,
  supplier_id TEXT REFERENCES suppliers(id),
  total INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  purchased_at TEXT NOT NULL,
  user_id TEXT,
  user_name TEXT,
  status TEXT NOT NULL DEFAULT 'CONFIRMED'
);
CREATE INDEX ix_purchases_supplier ON purchases(supplier_id);

CREATE TABLE purchase_items (${COMMON},
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  cost_price INTEGER NOT NULL,
  expiry_date TEXT,
  lot_code TEXT,
  line_total INTEGER NOT NULL
);

CREATE TABLE supplier_payments (${COMMON},
  supplier_id TEXT NOT NULL REFERENCES suppliers(id),
  amount INTEGER NOT NULL,
  method TEXT NOT NULL,
  note TEXT,
  paid_at TEXT NOT NULL,
  user_id TEXT
);

CREATE TABLE expenses (${COMMON},
  category TEXT NOT NULL,
  description TEXT,
  amount INTEGER NOT NULL,
  spent_at TEXT NOT NULL,
  user_id TEXT
);

-- ---------------------------------------------------------------- audit (append-only, synced)
CREATE TABLE audit_log (${COMMON},
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  metadata TEXT
);
CREATE INDEX ix_audit_created ON audit_log(created_at);

-- ---------------------------------------------------------------- synchronisation
CREATE TABLE sync_queue (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  operation TEXT NOT NULL,          -- CREATE | UPDATE | DELETE
  payload TEXT NOT NULL,            -- JSON snapshot of the row
  base_version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  next_attempt_at TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SYNCING | SYNCED | FAILED
  error_message TEXT
);
CREATE INDEX ix_queue_status ON sync_queue(status, created_at);
CREATE INDEX ix_queue_entity ON sync_queue(entity_type, entity_id);

CREATE TABLE sync_conflicts (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  local_payload TEXT NOT NULL,
  remote_payload TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  auto_resolution TEXT NOT NULL,    -- LOCAL_WINS | REMOTE_WINS | MERGED | RESURRECTED | CANCELLATION_WINS
  status TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | REVIEWED
  resolved_at TEXT
);
`;

// v2: optional free-text customer name printed on the receipt (walk-in customers without an account).
const V2 = `ALTER TABLE sales ADD COLUMN customer_name TEXT;`;

// v3: shop-level settings become synced rows (one row per key, deterministic id) so a restored PC gets the shop's settings back.
const V3 = `
CREATE TABLE shop_settings (${COMMON},
  key TEXT NOT NULL,
  value TEXT
);
CREATE UNIQUE INDEX ux_shop_settings_key ON shop_settings(key);
`;

// v4: physical stock count. A count header + one line per product that was actually counted (lines are created lazily,
// so starting a count on 5 000 products writes nothing and costs nothing). Lines freeze the system quantity the moment the
// product is counted, so sales made while the owner is still counting never distort the difference.
const V4 = `
CREATE TABLE stock_counts (${COMMON},
  reference TEXT NOT NULL,
  name TEXT,
  category_id TEXT REFERENCES categories(id),
  blind INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'OPEN',          -- OPEN | APPLIED | CANCELLED
  started_at TEXT NOT NULL,
  applied_at TEXT,
  user_id TEXT,
  user_name TEXT,
  notes TEXT,
  items_counted INTEGER NOT NULL DEFAULT 0,     -- summary, written once when the count is applied
  items_different INTEGER NOT NULL DEFAULT 0,
  shortage_value INTEGER NOT NULL DEFAULT 0,
  surplus_value INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_stock_counts_status ON stock_counts(status, started_at);

CREATE TABLE stock_count_items (${COMMON},
  count_id TEXT NOT NULL REFERENCES stock_counts(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  product_name TEXT NOT NULL,
  unit TEXT,
  expected_qty REAL NOT NULL,                   -- system quantity at the moment of counting
  counted_qty REAL NOT NULL,
  difference REAL NOT NULL,                     -- counted - expected (negative = missing)
  unit_cost INTEGER NOT NULL DEFAULT 0,
  reason_code TEXT,
  note TEXT
);
CREATE UNIQUE INDEX ux_count_items ON stock_count_items(count_id, product_id) WHERE deleted_at IS NULL;
CREATE INDEX ix_count_items_product ON stock_count_items(product_id);
`;

// v5: wholesale / retail prices. A customer has a price tier; a product may have a wholesale price (NULL = same as retail).
// The tier used is recorded on the sale so reports can tell wholesale from retail later.
const V5 = `
ALTER TABLE products ADD COLUMN wholesale_price INTEGER;
ALTER TABLE customers ADD COLUMN price_tier TEXT NOT NULL DEFAULT 'RETAIL';
ALTER TABLE sales ADD COLUMN price_tier TEXT NOT NULL DEFAULT 'RETAIL';
`;

// v6: invoices and proformas (quotes). Header + lines are snapshots: the document keeps printing the same even if the
// product is renamed or the customer is edited later. Numbers are NOT unique-indexed on purpose: two PCs that were
// offline can never block each other's sync (numbers carry a device tag when several PCs share data, see numbering.ts).
const V6 = `
ALTER TABLE customers ADD COLUMN tax_id TEXT;

CREATE TABLE documents (${COMMON},
  doc_type TEXT NOT NULL,                       -- INVOICE | PROFORMA
  number TEXT NOT NULL,
  status TEXT NOT NULL,                         -- INVOICE: ISSUED | CANCELLED   PROFORMA: OPEN | CONVERTED | CANCELLED
  customer_id TEXT REFERENCES customers(id),
  customer_name TEXT,
  customer_phone TEXT,
  customer_address TEXT,
  customer_tax_id TEXT,
  sale_id TEXT REFERENCES sales(id),            -- the sale an invoice was built from
  source_document_id TEXT,                      -- invoice created from this proforma
  converted_to TEXT,                            -- proforma: id of the invoice it became
  issue_date TEXT NOT NULL,
  due_date TEXT,                                -- invoice: payment due / proforma: valid until
  subtotal INTEGER NOT NULL,
  discount_total INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,       -- paid at the time of the sale
  price_tier TEXT NOT NULL DEFAULT 'RETAIL',
  notes TEXT,
  user_id TEXT,
  user_name TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT
);
CREATE INDEX ix_documents_type_date ON documents(doc_type, issue_date);
CREATE INDEX ix_documents_number ON documents(number);
CREATE INDEX ix_documents_sale ON documents(sale_id);
CREATE INDEX ix_documents_customer ON documents(customer_id);

CREATE TABLE document_items (${COMMON},
  document_id TEXT NOT NULL REFERENCES documents(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  description TEXT NOT NULL,
  unit TEXT,
  quantity REAL NOT NULL,
  unit_price INTEGER NOT NULL,
  discount INTEGER NOT NULL DEFAULT 0,
  line_total INTEGER NOT NULL
);
CREATE INDEX ix_document_items_doc ON document_items(document_id);
`;

// v7 grants managers the new stock-visibility capability. Cashier defaults omit it.
const V7 = `INSERT OR IGNORE INTO role_permissions (role_code, permission) SELECT 'MANAGER', 'products.stock.read' WHERE EXISTS (SELECT 1 FROM roles WHERE code = 'MANAGER');`;

// Local recovery journal: a crash can happen after the main PC reserves stock but before the sale transaction commits.
const V8 = `CREATE TABLE local_sale_intents (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);`;

export const MIGRATIONS: { version: number; sql: string }[] = [
  { version: 1, sql: V1 }, { version: 2, sql: V2 }, { version: 3, sql: V3 }, { version: 4, sql: V4 }, { version: 5, sql: V5 }, { version: 6, sql: V6 }, { version: 7, sql: V7 }, { version: 8, sql: V8 },
];

export async function migrate(db: Db): Promise<void> {
  await db.execBatch('PRAGMA foreign_keys = ON;');
  const row = await db.selectOne<{ user_version: number }>('PRAGMA user_version');
  const current = row?.user_version ?? 0;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    await db.transaction(async (tx) => {
      await tx.execBatch(m.sql);
      await tx.execBatch(`PRAGMA user_version = ${m.version};`);
    });
  }
}
