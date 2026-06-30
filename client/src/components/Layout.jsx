import { Outlet, NavLink, useNavigate } from "react-router-dom";

const NAV = [
  { to: "/control",   label: "Control",   icon: "⚡" },
  { to: "/analytics", label: "Analytics", icon: "📈" },
  { to: "/config",    label: "Config",    icon: "⚙️" },
];

function NavItem({ to, label, icon, mobile }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        mobile
          ? `flex-1 flex flex-col items-center gap-0.5 py-2.5 text-xs font-medium transition-colors ${
              isActive ? "text-indigo-400" : "text-gray-500"
            }`
          : `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
              isActive
                ? "bg-indigo-600 text-white"
                : "text-gray-400 hover:text-white hover:bg-white/5"
            }`
      }
    >
      <span className={mobile ? "text-xl" : "text-base"}>{icon}</span>
      <span>{label}</span>
    </NavLink>
  );
}

export default function Layout() {
  const navigate = useNavigate();

  function logout() {
    localStorage.removeItem("token");
    navigate("/login");
  }

  return (
    <div className="min-h-screen bg-bg text-gray-100 flex flex-col lg:flex-row">
      {/* Desktop sidebar */}
      <aside className="hidden lg:flex flex-col w-56 bg-card border-r border-border shrink-0">
        <div className="p-6 border-b border-border">
          <div className="flex items-center gap-2">
            <span className="text-2xl">📈</span>
            <div>
              <h1 className="text-base font-bold text-white leading-tight">Kalshi Agents</h1>
              <p className="text-xs text-gray-500">Dashboard</p>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-0.5">
          {NAV.map((item) => (
            <NavItem key={item.to} {...item} />
          ))}
        </nav>
        <div className="p-4 border-t border-border">
          <button
            onClick={logout}
            className="text-xs text-gray-500 hover:text-white transition-colors"
          >
            Sign out →
          </button>
        </div>
      </aside>

      {/* Mobile header */}
      <header className="lg:hidden flex items-center justify-between px-4 py-3 bg-card border-b border-border">
        <div className="flex items-center gap-2">
          <span className="text-xl">📈</span>
          <span className="font-bold text-white text-sm">Kalshi Agents</span>
        </div>
        <button onClick={logout} className="text-xs text-gray-500 hover:text-white transition-colors">
          Sign out
        </button>
      </header>

      {/* Page content */}
      <main className="flex-1 overflow-auto pb-20 lg:pb-0">
        <Outlet />
      </main>

      {/* Mobile bottom nav */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 bg-card border-t border-border flex z-50">
        {NAV.map((item) => (
          <NavItem key={item.to} {...item} mobile />
        ))}
      </nav>
    </div>
  );
}
