import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';

/**
 * Printable content (receipts, Z-report, recovery key) is rendered in `#print-root`, a sibling of the app root.
 * On screen it is hidden. When printing, the stylesheet hides the whole app (`#root`) and shows ONLY `#print-root`.
 * (If the printable markup lived INSIDE `#root`, hiding the app would hide the receipt too: blank page.)
 */
export function PrintPortal({ children }: { children: ReactNode }) {
  const [el] = useState(() => {
    let e = document.getElementById('print-root');
    if (!e) { e = document.createElement('div'); e.id = 'print-root'; document.body.appendChild(e); }
    return e;
  });
  return createPortal(children, el);
}
