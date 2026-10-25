/** Tiny pub/sub: services emit after a committed write, the UI refreshes. */
type Listener = () => void;
const listeners = new Set<Listener>();
let pending = false;
export const dataBus = {
  subscribe(fn: Listener) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Coalesces bursts of writes into one notification. */
  emit() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      listeners.forEach((l) => l());
    });
  },
};
