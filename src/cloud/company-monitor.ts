const API_URL = ((import.meta as any).env?.VITE_CLOUD_API_URL as string | undefined)?.replace(/\/+$/, '') || '';
const DEVICE_KEY = 'stockflow.company-monitor.device';
const ACCESS_KEY = 'stockflow.company-monitor.access';
const REFRESH_KEY = 'stockflow.company-monitor.refresh';

export interface MonitorItem { productName: string; quantity: number; unitPrice: number; lineTotal: number }
export interface MonitorSale {
  id: string; receiptNumber: string; soldAt: string; cashier: string; customer: string;
  paymentMethod: string; status: string; total: number; profit: number; items: MonitorItem[];
}
export interface MonitorResponse {
  transactions: MonitorSale[];
  summary: { count: number; completed: number; profit: number; cancelled: number };
  paymentBreakdown: { paymentMethod: string; count: number; total: number }[];
  nextCursor: string | null;
}
export interface MonitorAccount { name: string; fullName: string; email: string }
const ACCOUNT_KEY = 'stockflow.company-monitor.account';

function deviceId() {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) { id = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, id); }
  return id;
}
function friendlyError(status: number, body: any) {
  if (body?.code === 'ADMIN_ONLY' || body?.code === 'FORBIDDEN' || status === 403) return 'This view is only available to the business administrator account.';
  if (status === 401) return 'Your cloud session expired. Please sign in again.';
  if (status >= 500) return 'The cloud service is temporarily unavailable. Please try again shortly.';
  return typeof body?.message === 'string' ? body.message : 'We could not complete that request.';
}

async function call<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  if (!API_URL) throw new Error('Cloud connection is not configured for this website yet. Please try again later.');
  const access = sessionStorage.getItem(ACCESS_KEY);
  const headers = new Headers(init.headers || {});
  headers.set('Accept', 'application/json');
  if (init.body) headers.set('Content-Type', 'application/json');
  if (access) headers.set('Authorization', `Bearer ${access}`);
  let response: Response;
  try { response = await fetch(`${API_URL}${path}`, { ...init, headers }); }
  catch { throw new Error('Cannot reach StockFlow Cloud. Check your internet connection and try again.'); }
  if (response.status === 401 && retry && sessionStorage.getItem(REFRESH_KEY)) {
    const refreshToken = sessionStorage.getItem(REFRESH_KEY)!;
    let renewed: Response | null = null;
    try { renewed = await fetch(`${API_URL}/auth/refresh`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refreshToken, deviceId: deviceId() }) }); } catch { /* handled as expired below */ }
    if (renewed?.ok) {
      const session = await renewed.json();
      sessionStorage.setItem(ACCESS_KEY, session.accessToken);
      if (session.refreshToken) sessionStorage.setItem(REFRESH_KEY, session.refreshToken);
      return call<T>(path, init, false);
    }
    clearMonitorSession();
    throw new Error('Your cloud session expired. Please sign in again.');
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(friendlyError(response.status, payload));
  return payload as T;
}

export function clearMonitorSession() {
  sessionStorage.removeItem(ACCESS_KEY);
  sessionStorage.removeItem(REFRESH_KEY);
  sessionStorage.removeItem(ACCOUNT_KEY);
}

export async function monitorLogin(email: string, password: string): Promise<MonitorAccount> {
  const session = await call<{ accessToken: string; refreshToken: string; user: { role: string; fullName: string; email: string }; business: { name: string } }>(
    '/auth/login', { method: 'POST', body: JSON.stringify({ email, password, deviceId: deviceId(), deviceName: 'StockFlow Web Monitor', platform: 'WEB', appVersion: '0.1.0' }) }, false,
  );
  if (session.user?.role !== 'ADMIN') {
    // Revoke the just-issued refresh token immediately for non-administrator accounts.
    await fetch(`${API_URL}/auth/logout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.accessToken}` }, body: JSON.stringify({ refreshToken: session.refreshToken }) }).catch(() => undefined);
    throw new Error('Sign in with the cloud administrator account for this business.');
  }
  const account = { name: session.business.name, fullName: session.user.fullName, email: session.user.email };
  sessionStorage.setItem(ACCESS_KEY, session.accessToken);
  sessionStorage.setItem(REFRESH_KEY, session.refreshToken);
  sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  return account;
}

export function hasMonitorSession() { return !!sessionStorage.getItem(ACCESS_KEY); }

export async function getMonitorAccount(): Promise<MonitorAccount> {
  const result = await call<{ user: { role: string; fullName: string; email: string }; business: { name: string } }>('/auth/me');
  if (result.user?.role !== 'ADMIN') throw new Error('This view is only available to the business administrator account.');
  const account = { name: result.business.name, fullName: result.user.fullName, email: result.user.email };
  sessionStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
  return account;
}

export function getMonitorSales(filters: { from: string; to: string; paymentMethod: string; search: string; cursor?: string | null; limit?: number }) {
  const params = new URLSearchParams({ limit: String(filters.limit ?? 50) });
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.paymentMethod) params.set('paymentMethod', filters.paymentMethod);
  if (filters.search) params.set('search', filters.search);
  if (filters.cursor) params.set('cursor', filters.cursor);
  return call<MonitorResponse>(`/company/transactions?${params}`);
}

export async function monitorLogout() {
  const refreshToken = sessionStorage.getItem(REFRESH_KEY);
  try {
    if (refreshToken) await call('/auth/logout', { method: 'POST', body: JSON.stringify({ refreshToken }) }, false);
  } finally { clearMonitorSession(); }
}
