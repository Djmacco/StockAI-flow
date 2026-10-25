import { barcodeCatalog } from "../data/barcode-catalog.generated";

/** Exact offline lookup. Barcode values stay strings so leading zeroes are preserved. */
export function findCatalogProductName(barcode: string): string | undefined {
  const code = barcode.trim();
  return code ? barcodeCatalog.get(code) : undefined;
}
