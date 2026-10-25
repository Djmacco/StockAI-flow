export const PERMISSIONS = [
  'products.read', 'products.stock.read', 'products.create', 'products.update', 'products.delete',
  'categories.manage',
  'inventory.adjust',
  'sales.read', 'sales.create', 'sales.cancel', 'sales.discount',
  'purchases.read', 'purchases.create',
  'customers.read', 'customers.create', 'customers.update',
  'suppliers.read', 'suppliers.create', 'suppliers.update',
  'expenses.manage',
  'cash.manage',
  'reports.read',
  'users.manage',
  'settings.manage',
  'sync.manage',
  'backup.manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_ADMIN = 'ADMIN';
export const ROLE_MANAGER = 'MANAGER';
export const ROLE_CASHIER = 'CASHIER';

const not = (...excluded: Permission[]) => PERMISSIONS.filter((p) => !excluded.includes(p));

export const DEFAULT_ROLE_PERMISSIONS: Record<string, readonly Permission[]> = {
  ADMIN: PERMISSIONS,
  // Business management, but no critical system configuration.
  MANAGER: not('users.manage', 'settings.manage', 'sync.manage', 'backup.manage'),
  CASHIER: [
    'products.read', 'sales.read', 'sales.create', 'customers.read', 'customers.create',
    'cash.manage',
  ],
};
export const DEFAULT_ROLE_NAMES: Record<string, string> = { ADMIN: 'Administrateur', MANAGER: 'Gérant', CASHIER: 'Caissier' };
