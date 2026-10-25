import { fail } from '../lib/errors';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { getById, insertRow, softDelete, updateRow } from './repo';
import type { Category } from './types';

export interface CategoryWithCount extends Category { product_count: number }

export async function listCategories(ctx: AppContext): Promise<CategoryWithCount[]> {
  return ctx.db.select<CategoryWithCount>(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.deleted_at IS NULL) AS product_count
     FROM categories c WHERE c.deleted_at IS NULL ORDER BY c.name COLLATE NOCASE`,
  );
}

async function assertUnique(ctx: AppContext, name: string, exceptId?: string) {
  const dup = await ctx.db.selectOne('SELECT 1 x FROM categories WHERE lower(name) = lower(?) AND deleted_at IS NULL AND id <> ?', [name.trim(), exceptId ?? '']);
  if (dup) fail('errors.categoryExists', { name });
}

export async function createCategory(ctx: AppContext, name: string): Promise<Category> {
  requirePermission(ctx, 'categories.manage');
  if (!name.trim()) fail('errors.requiredFields');
  await assertUnique(ctx, name);
  return runTx(ctx, async (tx) => {
    const c = await insertRow<Category>(tx, ctx, 'categories', { name: name.trim() });
    await audit(tx, ctx, 'category.created', 'category', c.id, { name: c.name });
    return c;
  });
}

export async function renameCategory(ctx: AppContext, id: string, name: string) {
  requirePermission(ctx, 'categories.manage');
  if (!name.trim()) fail('errors.requiredFields');
  await assertUnique(ctx, name, id);
  await runTx(ctx, async (tx) => {
    await updateRow(tx, ctx, 'categories', id, { name: name.trim() });
    await audit(tx, ctx, 'category.renamed', 'category', id, { name });
  });
}

/**
 * Deleting a category that still has products is refused unless the caller picks a
 * replacement category (or explicitly `null` = "uncategorised"). Nothing is orphaned.
 */
export async function deleteCategory(ctx: AppContext, id: string, replacement?: string | null) {
  requirePermission(ctx, 'categories.manage');
  const cat = await getById<Category>(ctx.db, 'categories', id);
  if (!cat) return fail('errors.notFound');
  const n = (await ctx.db.selectOne<{ n: number }>('SELECT COUNT(*) n FROM products WHERE category_id = ? AND deleted_at IS NULL', [id]))!.n;
  if (n > 0 && replacement === undefined) fail('errors.categoryInUse', { count: n });
  if (replacement === id) fail('errors.invalidReplacement');
  await runTx(ctx, async (tx) => {
    if (n > 0) {
      const ids = await tx.select<{ id: string }>('SELECT id FROM products WHERE category_id = ? AND deleted_at IS NULL', [id]);
      for (const p of ids) await updateRow(tx, ctx, 'products', p.id, { category_id: replacement ?? null });
    }
    await softDelete(tx, ctx, 'categories', id);
    await audit(tx, ctx, 'category.deleted', 'category', id, { name: cat.name, movedProducts: n, replacement: replacement ?? null });
  });
}
