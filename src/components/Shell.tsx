import {
  AlertTriangle, Boxes, Check, CloudOff, Crown, Database, Download, LayoutDashboard, LogOut, Mic, Moon, RefreshCw, ScanLine,
  Lightbulb, Settings as SettingsIcon, ShoppingCart, Sun, Truck, Users, BarChart3, ArrowLeftRight, PackageSearch, Circle, ClipboardCheck, FileText, Eye,
} from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useNet } from '../lan/useNet';
import { rt, useApp } from '../state/app';
import { useAssistant } from '../state/assistant';
import { AssistantPanel } from './AssistantPanel';
import { Pill, Segmented, Toaster, cn } from './ui';

const NAV = [
  { to: '/', key: 'dashboard', icon: LayoutDashboard, perm: null },
  { to: '/insights', key: 'insights', icon: Lightbulb, perm: 'reports.read', ai: true },
  { to: '/voice', key: 'voice', icon: Mic, perm: null, hint: 'F8', ai: true },
  { to: '/pos', key: 'pos', icon: ShoppingCart, perm: 'sales.create', hint: 'F2' },
  { to: '/products', key: 'products', icon: Boxes, perm: 'products.read' },
  { to: '/purchases', key: 'purchases', icon: Truck, perm: 'purchases.read' },
  { to: '/movements', key: 'movements', icon: ArrowLeftRight, perm: 'products.read' },
  { to: '/customers', key: 'customers', icon: Users, perm: 'customers.read' },
  { to: '/counts', key: 'counts', icon: ClipboardCheck, perm: 'inventory.adjust' },
  { to: '/documents', key: 'documents', icon: FileText, perm: 'sales.read' },
  { to: '/reports', key: 'reports', icon: BarChart3, perm: 'reports.read' },
  { to: '/company', key: 'companyMonitor', icon: Eye, perm: null, webOnly: true },
  { to: '/scan', key: 'scan', icon: ScanLine, perm: 'inventory.adjust', premium: true },
  { to: '/settings', key: 'settings', icon: SettingsIcon, perm: null },
] as const;

function SyncPill() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const ent = useApp((s) => s.entitlement);
  const sync = useApp((s) => s.sync);
  const { lan } = useNet();                       // syncing with the shop's main PC: no subscription involved
  let node: ReactNode;
  if (lan && sync) {
    // LAN performs a short safety check every five seconds. If nothing is queued,
    // keep the pill steady while that background pull checks for remote changes.
    if (sync.state === 'SYNCING' && sync.pending > 0) node = <Pill tone="info" icon={<RefreshCw className="h-3 w-3 animate-spin" />}>{t('header.syncing')}</Pill>;
    else if (sync.state === 'FAILED') node = <Pill tone="bad" icon={<AlertTriangle className="h-3 w-3" />}>{t('header.syncFailed')}</Pill>;
    else if (sync.state === 'OFFLINE') node = <Pill tone="warn" icon={<CloudOff className="h-3 w-3" />}>{t('header.lanOffline')}{sync.pending ? ` · ${sync.pending}` : ''}</Pill>;
    else node = <Pill tone="ok" icon={<Check className="h-3 w-3" />}>{sync.pending ? t('header.pending', { count: sync.pending }) : t('header.lanSynced')}</Pill>;
    return <button onClick={() => nav('/settings?tab=network')} title={t('header.lanTitle')}>{node}</button>;
  }
  if (ent.state !== 'ACTIVE' || !sync || sync.state === 'DISABLED')
    node = <Pill icon={<Database className="h-3 w-3" />}>{t('header.localMode')}</Pill>;
  else if (sync.state === 'SYNCING') node = <Pill tone="info" icon={<RefreshCw className="h-3 w-3 animate-spin" />}>{t('header.syncing')}</Pill>;
  else if (sync.state === 'FAILED') node = <Pill tone="bad" icon={<AlertTriangle className="h-3 w-3" />}>{t('header.syncFailed')}</Pill>;
  else if (sync.state === 'OFFLINE') node = <Pill tone="warn" icon={<CloudOff className="h-3 w-3" />}>{t('header.offline')}{sync.pending ? ` · ${sync.pending}` : ''}</Pill>;
  else node = <Pill tone="ok" icon={<Check className="h-3 w-3" />}>{sync.pending ? t('header.pending', { count: sync.pending }) : t('header.synced')}</Pill>;
  return <button onClick={() => nav('/settings?tab=sync')} title={t('header.syncTitle')}>{node}</button>;
}

function Header() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { user, lang, theme, entitlement, setLang, setTheme, logout, setAssistantOpen, assistantOpen, settings, desktop } = useApp();
  const premium = entitlement.state === 'ACTIVE';
  const [installPrompt, setInstallPrompt] = useState<any>(null);
  const [installed, setInstalled] = useState(false);
  const [showInstallHelp, setShowInstallHelp] = useState(false);
  useEffect(() => {
    const beforeInstall = (event: Event) => { event.preventDefault(); setInstallPrompt(event); };
    const onInstalled = () => { setInstalled(true); setInstallPrompt(null); setShowInstallHelp(false); };
    setInstalled(window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true);
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', onInstalled); };
  }, []);
  const install = async () => {
    if (!installPrompt) { setShowInstallHelp((value) => !value); return; }
    await installPrompt.prompt();
    const result = await installPrompt.userChoice;
    if (result?.outcome === 'accepted') setInstalled(true);
    setInstallPrompt(null);
  };
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface px-4 max-md:px-2">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded bg-brand text-on-brand"><PackageSearch className="h-4 w-4" /></div>
        <div className="leading-tight max-md:hidden">
          <div className="font-display text-[15px] font-bold text-ink">StockFlow AI</div>
          <div className="text-[11px] text-faint">{settings.business_name} · {settings.branch_name}</div>
        </div>
      </div>
      <div className="flex items-center gap-2.5 max-md:gap-1.5">
        {!desktop && !installed && <div className="relative md:hidden">
          <button onClick={() => void install()} aria-label={lang === 'fr' ? 'Installer StockFlow AI' : 'Install StockFlow AI'} title={lang === 'fr' ? 'Installer sur ce téléphone' : 'Install on this phone'} className="grid h-9 w-9 place-items-center rounded-lg border border-brand/30 bg-brand-soft text-brand"><Download className="h-4 w-4" /></button>
          {showInstallHelp && <div role="status" className="absolute right-0 top-11 z-50 w-64 rounded-lg border border-line bg-surface p-3 text-xs leading-5 text-body shadow-pop">{lang === 'fr' ? 'Dans le menu du navigateur, choisissez « Ajouter à l’écran d’accueil » pour installer l’application.' : 'Open your browser menu and choose “Add to Home Screen” to install the app.'}</div>}
        </div>}
        <span className="max-md:hidden"><SyncPill /></span>
        <button className="max-md:hidden" onClick={() => nav('/settings?tab=subscription')}>
          {premium
            ? <Pill tone="ai" icon={<Crown className="h-3 w-3" />}>{t('header.premium')}</Pill>
            : <Pill icon={<Circle className="h-2.5 w-2.5" />}>{t('header.free')}</Pill>}
        </button>
        {desktop && <button onClick={() => setAssistantOpen(!assistantOpen)} title={t('nav.assistant')}
          className={cn('flex h-8 items-center gap-1.5 rounded border px-2.5 text-[12px] font-semibold', assistantOpen ? 'border-ai bg-ai text-white' : 'border-ai/40 bg-ai-soft text-ai-text hover:bg-ai hover:text-white')}>
          <Mic className="h-3.5 w-3.5" />{t('nav.assistant')}
        </button>}
        <Segmented options={[{ id: 'fr', label: 'FR' }, { id: 'en', label: 'EN' }]} value={lang} onChange={(l) => setLang(l)} />
        <button onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} className="rounded p-1.5 text-faint hover:bg-muted hover:text-ink" aria-label="theme">
          {theme === 'light' ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
        </button>
        <div className="mx-1 h-6 w-px bg-line" />
        <div className="text-right leading-tight max-sm:hidden">
          <div className="text-[12px] font-semibold text-ink">{user?.full_name}</div>
          <div className="text-[10px] uppercase tracking-wide text-faint">{t(`roles.${user?.role_code}`, { defaultValue: user?.role_code })}</div>
        </div>
        <button onClick={() => logout()} className="rounded p-1.5 text-faint hover:bg-muted hover:text-bad" title={t('auth.logout')} aria-label="logout"><LogOut className="h-4 w-4" /></button>
      </div>
    </header>
  );
}

function Sidebar() {
  const { t } = useTranslation();
  const { permissions: perms, entitlement, desktop } = useApp();
  const premium = entitlement.state === 'ACTIVE';
  const items = NAV.filter((n) => (desktop || n.key !== 'voice') && (!('webOnly' in n && n.webOnly) || !desktop) && (!n.perm || perms.has(n.perm) || (n.key === 'purchases' && perms.has('suppliers.read'))));
  return (
    <nav className="flex w-[208px] shrink-0 flex-col gap-0.5 border-r border-line bg-surface p-2.5 max-lg:w-[180px] max-md:hidden">
      {items.map((n) => (
        <NavLink key={n.to} to={n.to} end={n.to === '/'}
          className={({ isActive }) => cn('flex h-9 items-center gap-3 rounded px-3 text-[13px] font-medium transition-colors max-md:justify-center max-md:px-2', isActive ? ('ai' in n && n.ai ? 'bg-ai-soft text-ai-text' : 'bg-brand-soft text-brand') : 'text-body hover:bg-muted')}>
          <n.icon className={cn('h-4 w-4 shrink-0', 'ai' in n && n.ai && 'text-ai')} />
          <span className="flex-1 max-md:hidden">{t(`nav.${n.key}`)}</span>
          {'premium' in n && n.premium && !premium && <Crown className="h-3 w-3 text-ai" />}
          {'hint' in n && n.hint && <span className="kbd max-md:hidden">{n.hint}</span>}
        </NavLink>
      ))}
    </nav>
  );
}

function MobileNav() {
  const { t } = useTranslation();
  const { permissions: perms, desktop } = useApp();
  // Keep the phone dock focused on the four pages owners and staff open most.
  // Each entry uses the same route and permission as the desktop sidebar.
  const items = [NAV[0], NAV[4], NAV[3], NAV[10]]
    .filter((item) => (!item.perm || perms.has(item.perm)) && (!('webOnly' in item && item.webOnly) || !desktop));
  return <nav aria-label={t('nav.primary', { defaultValue: 'Main navigation' })} style={{ gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))` }} className="mobile-bottom-nav z-30 grid shrink-0 border-t border-line bg-surface px-3 pt-2 backdrop-blur md:hidden">
    {items.map((item) => <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => cn('mobile-nav-link flex min-h-[58px] flex-col items-center justify-center gap-1 rounded-xl px-1 text-[10px] font-semibold transition-all active:scale-95', isActive ? 'is-active text-brand' : 'text-faint hover:bg-muted')}>
      <span className="mobile-nav-icon grid h-9 w-12 place-items-center rounded-full transition-all"><item.icon aria-hidden="true" className="h-[19px] w-[19px]" /></span><span className="max-w-full truncate leading-none">{t(`nav.${item.key}`)}</span>
    </NavLink>)}
  </nav>;
}

function StatusBar() {
  const { t } = useTranslation();
  const { sync, desktop, entitlement, lang } = useApp();
  const { lan } = useNet();
  return (
    <footer className="flex h-7 shrink-0 items-center justify-between border-t border-line bg-surface px-4 text-[11px] text-faint max-md:hidden">
      <div className="flex items-center gap-4">
        <span className="flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-ok" />{desktop ? t('status.sqlite') : lang === 'fr' ? 'Base navigateur · enregistrée sur cet appareil' : 'Browser database · saved on this device'}</span>
        {(entitlement.state === 'ACTIVE' || lan) && sync && <span>{t('status.queue', { count: sync.pending })}</span>}
        {sync && sync.conflicts > 0 && <span className="text-warn-text">{t('status.conflicts', { count: sync.conflicts })}</span>}
      </div>
      <span className="font-mono">{rt().deviceId.slice(-8)}</span>
    </footer>
  );
}

export function Shell() {
  const nav = useNavigate();
  const { permissions: perms, desktop, lang } = useApp();
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'F2' && perms.has('sales.create')) { e.preventDefault(); nav('/pos'); }
      if (desktop && e.key === 'F8') { // F8: jump to the Voice page and start listening
        e.preventDefault(); nav('/voice');
        const st = useAssistant.getState();
        if (st.listening) st.stopListening(); else setTimeout(() => useAssistant.getState().startListening(), 200);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [nav, perms, desktop]);
  return (
    <div className="app-shell flex h-full flex-col">
      <Header />
      {!desktop && <div className="border-b border-warn/30 bg-warn-soft px-4 py-2 text-center text-[12px] font-medium text-warn-text">{lang === 'fr' ? 'La version Web est en lecture seule pendant que le PC principal reste la source de données. Le point de vente et les modifications du stock seront activés après la mise en place d’une synchronisation cloud bidirectionnelle fiable.' : 'Web view is read-only while the desktop hub remains the source of truth. POS and stock changes will be enabled after a safe two-way cloud relay is ready.'}</div>}
      <div className="app-workspace flex min-h-0 min-w-0 flex-1">
        <Sidebar />
        <main className="app-content min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto p-6 max-md:p-3 mobile-page"><Outlet /></main>
        <AssistantPanel />
      </div>
      {!desktop && <MobileNav />}
      <StatusBar />
      <Toaster />
    </div>
  );
}
