/** In-process guard: recovery must not release a reservation while another checkout is still authorizing/committing. */
const inFlight = new Set<string>();

export const markCheckoutInFlight = (saleId: string, active: boolean) => {
  if (active) inFlight.add(saleId);
  else inFlight.delete(saleId);
};

export const checkoutIsInFlight = (saleId: string) => inFlight.has(saleId);
