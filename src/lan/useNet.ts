import { useLive } from '../state/hooks';
import { getNetConfig, lanActive } from './network';

/** The shop-network settings of this PC, live. `lan` = this PC syncs with a main PC (or is the main PC). */
export function useNet() {
  const { data } = useLive((c) => getNetConfig(c.db));
  return { net: data, lan: !!data && lanActive(data) };
}
