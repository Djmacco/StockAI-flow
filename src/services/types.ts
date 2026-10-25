export interface Base {
  id: string;
  created_at: string;
  updated_at: string;
  device_id: string;
  version: number;
  sync_status: 'PENDING' | 'SYNCED' | 'CONFLICT';
  deleted_at: string | null;
}
export interface Category extends Base { name: string }
export interface Supplier extends Base { name: string; phone: string | null; email: string | null; address: string | null; notes: string | null }
export type PriceTier = 'RETAIL' | 'WHOLESALE';
export interface Customer extends Base { name: string; phone: string | null; email: string | null; address: string | null; credit_limit: number; price_tier: PriceTier; tax_id: string | null }
export interface Product extends Base {
  name: string; sku: string | null; barcode: string | null; category_id: string | null; description: string | null;
  cost_price: number; selling_price: number; quantity: number; minimum_stock: number; unit: string;
  supplier_id: string | null; expiry_date: string | null; image: string | null;
  /** Price for wholesale customers. NULL = no wholesale price (the retail price applies). */
  wholesale_price: number | null;
}
export interface Batch extends Base {
  product_id: string; lot_code: string | null; expiry_date: string | null; quantity_initial: number;
  quantity_remaining: number; cost_price: number; received_at: string; purchase_id: string | null; supplier_id: string | null;
}
export type MovementType =
  | 'INITIAL' | 'PURCHASE' | 'SALE' | 'SALE_CANCEL' | 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT'
  | 'DAMAGED' | 'LOST' | 'RETURN' | 'EXPIRED';
export interface StockMovement extends Base {
  product_id: string; batch_id: string | null; type: MovementType; quantity: number; previous_stock: number;
  new_stock: number; unit_cost: number; reason: string | null; reference_type: string | null; reference_id: string | null;
  user_id: string | null; user_name: string | null;
}
export interface Sale extends Base {
  receipt_no: string; customer_id: string | null; customer_name: string | null; user_id: string | null; user_name: string | null; cash_session_id: string | null;
  subtotal: number; discount_total: number; total: number; amount_paid: number; change_due: number; payment_method: string;
  cost_total: number; status: 'COMPLETED' | 'CANCELLED'; notes: string | null; sold_at: string; cancelled_at: string | null; cancel_reason: string | null;
  /** Price list the sale was made with. */
  price_tier: PriceTier;
}
export interface SaleItem extends Base {
  sale_id: string; product_id: string; product_name: string; quantity: number; unit_price: number; unit_cost: number; discount: number; line_total: number;
}
export interface Purchase extends Base {
  reference: string; supplier_id: string | null; total: number; amount_paid: number; notes: string | null; purchased_at: string;
  user_id: string | null; user_name: string | null; status: string;
}
export interface PurchaseItem extends Base {
  purchase_id: string; product_id: string; quantity: number; cost_price: number; expiry_date: string | null; lot_code: string | null; line_total: number;
}
export interface Expense extends Base { category: string; description: string | null; amount: number; spent_at: string; user_id: string | null }
export interface CashSession extends Base {
  user_id: string; user_name: string | null; opened_at: string; opening_float: number; closed_at: string | null;
  expected_cash: number | null; counted_cash: number | null; difference: number | null; status: 'OPEN' | 'CLOSED'; notes: string | null;
}
export interface User extends Base {
  username: string; full_name: string; email: string | null; password_hash: string; password_salt: string; password_iterations: number;
  role_code: string; active: number; failed_attempts: number; locked_until: string | null; last_login_at: string | null;
}
export interface AuditEntry extends Base {
  user_id: string | null; user_name: string | null; action: string; entity_type: string | null; entity_id: string | null; metadata: string | null;
}

export type CountStatus = 'OPEN' | 'APPLIED' | 'CANCELLED';
export interface StockCount extends Base {
  reference: string; name: string | null; category_id: string | null; blind: number; status: CountStatus; started_at: string; applied_at: string | null;
  user_id: string | null; user_name: string | null; notes: string | null;
  items_counted: number; items_different: number; shortage_value: number; surplus_value: number;
}
export interface StockCountItem extends Base {
  count_id: string; product_id: string; product_name: string; unit: string | null; expected_qty: number; counted_qty: number; difference: number;
  unit_cost: number; reason_code: string | null; note: string | null;
}

export type DocType = 'INVOICE' | 'PROFORMA';
export type DocStatus = 'ISSUED' | 'OPEN' | 'CONVERTED' | 'CANCELLED';
export interface Document extends Base {
  doc_type: DocType; number: string; status: DocStatus; customer_id: string | null; customer_name: string | null; customer_phone: string | null;
  customer_address: string | null; customer_tax_id: string | null; sale_id: string | null; source_document_id: string | null; converted_to: string | null;
  issue_date: string; due_date: string | null; subtotal: number; discount_total: number; total: number; tax_rate: number; tax_total: number;
  amount_paid: number; price_tier: PriceTier; notes: string | null; user_id: string | null; user_name: string | null; cancelled_at: string | null; cancel_reason: string | null;
}
export interface DocumentItem extends Base {
  document_id: string; product_id: string; description: string; unit: string | null; quantity: number; unit_price: number; discount: number; line_total: number;
}
