import { ReactNode, useEffect, useState } from 'react';
import {
  LayoutGrid,
  ShoppingCart,
  Package,
  Receipt,
  Wallet,
  FileText,
  Boxes,
  BarChart3,
  Users,
  UserCog,
  Settings as SettingsIcon,
  LogOut,
  Power,
  Search,
  Bell,
  Sun,
  Moon,
  Pill,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getPosBridge } from '../bridge';
import { getUploadsBase } from '../api/client';

export type NavView =
  | 'till'
  | 'catalog'
  | 'sales'
  | 'cashup'
  | 'prescriptions'
  | 'inventory'
  | 'analytics'
  | 'customers'
  | 'team'
  | 'settings';

type Props = {
  view: NavView;
  onNavigate: (view: NavView) => void;
  title: string;
  subtitle?: string;
  stats?: ReactNode;
  children: ReactNode;
  todaySales?: string;
  logo?: string;
  navBadges?: Partial<Record<NavView, number>>;
};

const NAV_ICONS: Record<NavView, typeof LayoutGrid> = {
  till: ShoppingCart,
  catalog: Package,
  sales: Receipt,
  cashup: Wallet,
  prescriptions: FileText,
  inventory: Boxes,
  analytics: BarChart3,
  customers: Users,
  team: UserCog,
  settings: SettingsIcon,
};

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      return (localStorage.getItem('pos-theme') as 'light' | 'dark') || 'light';
    } catch {
      return 'light';
    }
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('pos-theme', theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

export default function AppShell({
  view,
  onNavigate,
  title,
  subtitle,
  stats,
  children,
  todaySales,
  logo,
  navBadges,
}: Props) {
  const { user, logout, hasPerm, apiInfo } = useAuth();
  const { theme, toggle } = useTheme();
  const logoSrc = logo ? `${getUploadsBase()}/${logo}` : '';

  const defaultItems: { id: NavView; label: string; show: boolean }[] = [
    { id: 'till', label: 'Till', show: true },
    { id: 'catalog', label: 'Catalog', show: hasPerm('perm_products') || hasPerm('perm_categories') },
    { id: 'sales', label: 'Sales', show: hasPerm('perm_transactions') },
    { id: 'cashup', label: 'Cash-up', show: hasPerm('perm_transactions') },
    { id: 'prescriptions', label: 'Prescriptions', show: hasPerm('perm_transactions') },
    { id: 'inventory', label: 'Inventory', show: hasPerm('perm_products') },
    { id: 'analytics', label: 'Analytics', show: hasPerm('perm_transactions') },
    { id: 'customers', label: 'Customers', show: true },
    { id: 'team', label: 'Team', show: hasPerm('perm_users') },
    { id: 'settings', label: 'Settings', show: hasPerm('perm_settings') },
  ];

  // Hard role separation: a till operator (cashier) sees only the Till, an admin sees
  // everything except the Till, and tech (support) sees every view including the Till.
  // Other roles (pharmacist/manager) keep the existing permission-driven visibility above.
  const items =
    user?.role === 'cashier'
      ? defaultItems.map((i) => ({ ...i, show: i.id === 'till' }))
      : user?.role === 'admin'
      ? defaultItems.map((i) => ({ ...i, show: i.id !== 'till' }))
      : user?.role === 'tech'
      ? defaultItems.map((i) => ({ ...i, show: true }))
      : defaultItems;

  const initials = (user?.fullname || '?')
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase();

  const bellCount = navBadges ? Object.values(navBadges).reduce((sum, n) => sum + (n || 0), 0) : 0;

  return (
    <div className="app">
      <aside className="nav">
        <div className="nav-brand">
          <div className="nav-brand-row">
            {logoSrc ? (
              <img className="nav-logo" src={logoSrc} alt="" />
            ) : (
              <div className="nav-logo nav-logo-fallback" aria-hidden>
                <Pill size={20} />
              </div>
            )}
            <div className="nav-brand-text">
              <strong>MediPOS</strong>
              <span>{apiInfo?.mode?.replace(' Point of Sale', '') || 'Standalone'}</span>
            </div>
          </div>
        </div>
        <div className="nav-section-label">Navigation</div>
        {items
          .filter((i) => i.show)
          .map((item) => {
            const Icon = NAV_ICONS[item.id];
            const badge = navBadges?.[item.id];
            return (
              <button
                key={item.id}
                type="button"
                className={`nav-btn ${view === item.id ? 'active' : ''}`}
                onClick={() => onNavigate(item.id)}
              >
                <Icon size={17} />
                <span className="nav-btn-label">{item.label}</span>
                {!!badge && <span className="nav-badge">{badge}</span>}
              </button>
            );
          })}
        <div className="nav-spacer" />
        <div className="nav-quick-actions">
          <div className="nav-section-label">Quick actions</div>
          <button type="button" className="nav-btn" onClick={() => logout()}>
            <LogOut size={17} />
            <span className="nav-btn-label">Sign out</span>
          </button>
          <button type="button" className="nav-btn" onClick={() => getPosBridge().quit()}>
            <Power size={17} />
            <span className="nav-btn-label">Quit</span>
          </button>
        </div>
        <div className="nav-profile">
          <div className="nav-profile-avatar">{initials}</div>
          <div className="nav-profile-meta">
            <strong>{user?.fullname}</strong>
            <span>{user?.role || 'cashier'} · Till #{apiInfo?.till || 1}</span>
          </div>
        </div>
      </aside>

      <div className="workspace">
        <header className="topbar">
          <div className="topbar-title">
            <h1>{title}</h1>
            {subtitle && <p className="topbar-subtitle">{subtitle}</p>}
          </div>
          {stats}
          <div className="spacer" />
          <div className="topbar-search">
            <Search size={15} />
            <input type="text" placeholder="Search…" />
          </div>
          <div className="icon-btn" role="img" aria-label={`${bellCount} pending items`}>
            <Bell size={17} />
            {bellCount > 0 && <span className="icon-btn-badge">{bellCount}</span>}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={toggle}
            aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          {todaySales != null && (
            <div className="stat-pill">
              Today <span className="currency">{todaySales}</span>
            </div>
          )}
        </header>
        <main className="main">{children}</main>
      </div>
    </div>
  );
}
