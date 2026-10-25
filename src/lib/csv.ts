/** Build an Excel-friendly UTF-8 CSV with correct quoting and formula-safe text cells. */
export function toCsv(rows: readonly (readonly (string | number)[])[]): string {
  const cell = (value: string | number) => {
    if (typeof value === 'number') return String(value);
    const safe = /^[=+@\-]/.test(value) ? `'${value}` : value;
    return `"${safe.replace(/"/g, '""')}"`;
  };
  return `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}`;
}
