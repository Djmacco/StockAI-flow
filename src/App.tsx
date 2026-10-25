import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Shell } from './components/Shell';
import { PageLoader } from './components/ui';
import { useApp } from './state/app';

const RecoveryKeyScreen = lazy(() => import('./components/RecoveryKey').then((m) => ({ default: m.RecoveryKeyScreen })));
const Customers = lazy(() => import('./pages/Customers').then((m) => ({ default: m.Customers })));
const Documents = lazy(() => import('./pages/Documents').then((m) => ({ default: m.Documents })));
const Dashboard = lazy(() => import('./pages/Dashboard').then((m) => ({ default: m.Dashboard })));
const Insights = lazy(() => import('./pages/Insights').then((m) => ({ default: m.Insights })));
const VoicePage = lazy(() => import('./pages/Voice').then((m) => ({ default: m.VoicePage })));
const Login = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Login })));
const Setup = lazy(() => import('./pages/Auth').then((m) => ({ default: m.Setup })));
const Movements = lazy(() => import('./pages/Movements').then((m) => ({ default: m.Movements })));
const POS = lazy(() => import('./pages/POS').then((m) => ({ default: m.POS })));
const Products = lazy(() => import('./pages/Products').then((m) => ({ default: m.Products })));
const Purchases = lazy(() => import('./pages/Purchases').then((m) => ({ default: m.Purchases })));
const Reports = lazy(() => import('./pages/Reports').then((m) => ({ default: m.Reports })));
const Scan = lazy(() => import('./pages/Scan').then((m) => ({ default: m.Scan })));
const StockCount = lazy(() => import('./pages/StockCount').then((m) => ({ default: m.StockCount })));
const SettingsPage = lazy(() => import('./pages/Settings').then((m) => ({ default: m.SettingsPage })));

export default function App() {
  const { ready, bootError, user, setupNeeded, recoveryKey } = useApp();
  if (!ready) return <PageLoader />;
  if (bootError) return <div className="p-8 text-bad-text">Startup error: {bootError}</div>;
  if (setupNeeded) return <Setup />;
  if (!user) return <Login />;
  if (recoveryKey) return <RecoveryKeyScreen code={recoveryKey} />;
  return (
    <Suspense fallback={<PageLoader />}>
    <HashRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<Dashboard />} />
          <Route path="insights" element={<Insights />} />
          <Route path="voice" element={<VoicePage />} />
          <Route path="pos" element={<POS />} />
          <Route path="products" element={<Products />} />
          <Route path="purchases" element={<Purchases />} />
          <Route path="movements" element={<Movements />} />
          <Route path="customers" element={<Customers />} />
          <Route path="counts" element={<StockCount />} />
          <Route path="documents" element={<Documents />} />
          <Route path="reports" element={<Reports />} />
          <Route path="scan" element={<Scan />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </HashRouter>
    </Suspense>
  );
}
