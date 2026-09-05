"use client";

import { useCallback, useEffect, useState } from "react";
import BotDashboard from "./BotDashboard";
import AdminPanel from "./AdminPanel";
import SettingsPanel from "./SettingsPanel";
import TrainAiPanel from "./TrainAiPanel";
import LicensePanel from "./LicensePanel";
import ShopPanel from "./ShopPanel";
import { Logo } from "./Logo";

type Me = {
  id: string;
  username: string;
  avatar: string | null;
  role: string;
  botSlots: number;
  botCount: number;
  isGuest: boolean;
};

type Tab = "dashboard" | "license" | "shop" | "admin" | "train" | "settings";

export default function AppShell() {
  const [me, setMe] = useState<Me | null>(null);
  const [discordConfigured, setDiscordConfigured] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [mobileNav, setMobileNav] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { cache: "no-store" });
      const data = await res.json();
      setMe(data.user ?? null);
      setDiscordConfigured(data.discordConfigured ?? false);
    } catch {
      setMe(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadMe();
  }, [loadMe]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.data?.type === "mcbm:login-success") {
        loadMe();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [loadMe]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("login") === "success" && window.opener) {
      try {
        window.opener.postMessage({ type: "mcbm:login-success" }, "*");
      } catch {}
      window.history.replaceState({}, "", "/");
      setTimeout(() => {
        try {
          window.close();
        } catch {}
      }, 400);
    }
  }, []);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setMe(null);
    setTab("dashboard");
  }

  if (!loaded) {
    return (
      <div className="grid min-h-screen place-items-center">
        <div className="flex flex-col items-center gap-4">
          <Logo size={56} className="animate-pulse" />
          <div className="flex items-center gap-2 text-sm text-slate-400">
            <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-slate-600 border-t-emerald-400" />
            Loading…
          </div>
        </div>
      </div>
    );
  }

  if (!me) {
    return (
      <LoginScreen discordConfigured={discordConfigured} onDevLogin={loadMe} />
    );
  }

  const navItems: { key: Tab; label: string; icon: React.ReactNode }[] = [
    { key: "dashboard", label: "Bots", icon: <BotIcon /> },
    { key: "license", label: "License", icon: <TicketIcon /> },
    { key: "shop", label: "Shop", icon: <ShopIcon /> },
    ...(me.role === "admin"
      ? [
          { key: "admin" as Tab, label: "Admin", icon: <ShieldIcon /> },
          { key: "train" as Tab, label: "Train AI", icon: <BrainIcon /> },
        ]
      : []),
    { key: "settings", label: "Settings", icon: <GearIcon /> },
  ];

  return (
    <div className="flex min-h-screen">
      <aside
        className={`fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-800/80 bg-slate-950/80 backdrop-blur-xl transition-transform duration-300 lg:translate-x-0 ${
          mobileNav ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-3 px-5 py-5">
          <Logo size={40} className="drop-shadow-[0_4px_16px_rgba(16,185,129,0.35)]" />
          <div className="leading-tight">
            <div className="text-sm font-bold tracking-tight">
              MC Bot Manager
            </div>
            <div className="text-[11px] text-slate-500">control center</div>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 px-3 py-2">
          {navItems.map((item) => (
            <button
              key={item.key}
              onClick={() => {
                setTab(item.key);
                setMobileNav(false);
              }}
              className={`group flex items-center gap-3 rounded-xl px-3.5 py-2.5 text-sm font-medium transition-all ${
                tab === item.key
                  ? "bg-gradient-to-r from-emerald-500/15 to-emerald-500/5 text-emerald-300 ring-1 ring-emerald-500/20"
                  : "text-slate-400 hover:bg-slate-800/60 hover:text-slate-100"
              }`}
            >
              <span
                className={`grid h-8 w-8 place-items-center rounded-lg transition ${
                  tab === item.key
                    ? "bg-emerald-500/20 text-emerald-300"
                    : "bg-slate-800/60 text-slate-400 group-hover:text-slate-200"
                }`}
              >
                {item.icon}
              </span>
              {item.label}
              {tab === item.key && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-emerald-400" />
              )}
            </button>
          ))}
        </nav>

        <div className="border-t border-slate-800/80 p-3">
          <div className="flex items-center gap-3 rounded-xl bg-slate-900/60 p-3">
            {me.avatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={me.avatar} alt="" className="h-9 w-9 rounded-full" />
            ) : (
              <div className="grid h-9 w-9 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-700 text-xs font-bold">
                {me.username.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold">
                  {me.username}
                </span>
                {me.role === "admin" && (
                  <span className="rounded bg-fuchsia-500/15 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-fuchsia-300">
                    admin
                  </span>
                )}
              </div>
              <div className="text-[11px] text-slate-500">
                {me.isGuest ? "guest account" : me.username.includes("local:") ? "local" : "discord"}
              </div>
            </div>
          </div>
          <button
            onClick={logout}
            className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl border border-slate-800 px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300"
          >
            <LogoutIcon /> Logout
          </button>
        </div>
      </aside>

      {mobileNav && (
        <div
          onClick={() => setMobileNav(false)}
          className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm lg:hidden"
        />
      )}

      <div className="flex min-w-0 flex-1 flex-col lg:pl-64">
        <div className="sticky top-0 z-30 flex items-center justify-between border-b border-slate-800/80 bg-slate-950/80 px-4 py-3 backdrop-blur lg:hidden">
          <div className="flex items-center gap-2">
            <Logo size={28} />
            <span className="text-sm font-bold">MC Bot Manager</span>
          </div>
          <button
            onClick={() => setMobileNav(true)}
            className="grid h-9 w-9 place-items-center rounded-lg border border-slate-800 text-slate-300"
          >
            <MenuIcon />
          </button>
        </div>

        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:px-8">
          <div key={tab} className="animate-fade-in">
            {tab === "dashboard" && <BotDashboard />}
            {tab === "license" && <LicensePanel />}
            {tab === "shop" && <ShopPanel onGoLicense={() => setTab("license")} />}
            {tab === "admin" && me.role === "admin" && (
              <AdminPanel meId={me.id} />
            )}
            {tab === "train" && me.role === "admin" && <TrainAiPanel />}
            {tab === "settings" && <SettingsPanel me={me} onChange={loadMe} />}
          </div>
        </main>
      </div>
    </div>
  );
}

function LoginScreen({
  discordConfigured,
  onDevLogin,
}: {
  discordConfigured: boolean;
  onDevLogin: () => void;
}) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function devLogin() {
    setBusy(true);
    try {
      await fetch("/api/auth/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onDevLogin();
    } finally {
      setBusy(false);
    }
  }

  async function passwordAuth() {
    setError(null);
    if (!username.trim() || !password) {
      setError("Username and password required");
      return;
    }
    setBusy(true);
    try {
      const endpoint = mode === "login" ? "/api/auth/login" : "/api/auth/register";
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Failed");
        return;
      }
      onDevLogin();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-1/2 top-0 h-96 w-96 -translate-x-1/2 rounded-full bg-emerald-600/20 blur-[130px]" />
        <div className="absolute bottom-0 right-1/4 h-80 w-80 rounded-full bg-indigo-600/20 blur-[130px]" />
        <div className="absolute left-1/4 top-1/3 h-72 w-72 rounded-full bg-fuchsia-600/10 blur-[130px]" />
      </div>

      <div className="relative w-full max-w-md animate-pop-in rounded-3xl border border-slate-800/80 bg-slate-900/60 p-8 shadow-2xl backdrop-blur-xl">
        <div className="flex flex-col items-center text-center">
          <Logo
            size={72}
            className="drop-shadow-[0_8px_30px_rgba(16,185,129,0.45)]"
          />
          <h1 className="mt-5 text-2xl font-bold tracking-tight">
            MC Bot Manager
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-400">
            Spin up Minecraft bots, watch their console live, and run the beam —
            all from one sleek dashboard.
          </p>
        </div>

        <div className="mt-7 space-y-4">
          <div className="rounded-2xl border border-slate-700 bg-slate-900/60 p-4">
            <div className="flex gap-1 rounded-xl bg-slate-950 p-1">
              <button
                onClick={() => setMode("login")}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === "login" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                Login
              </button>
              <button
                onClick={() => setMode("register")}
                className={`flex-1 rounded-lg px-3 py-2 text-xs font-semibold transition ${mode === "register" ? "bg-slate-800 text-white" : "text-slate-400 hover:text-slate-200"}`}
              >
                Register
              </button>
            </div>

            <div className="mt-4 space-y-3">
              <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
              />
              <input
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && passwordAuth()}
                placeholder="Password"
                type="password"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
              />
              {error && (
                <div className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-rose-500/20">
                  {error}
                </div>
              )}
              <button
                onClick={passwordAuth}
                disabled={busy}
                className="w-full rounded-xl bg-emerald-500 px-4 py-3 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-50"
              >
                {busy ? "Please wait…" : mode === "login" ? "Login with Username" : "Create Account"}
              </button>
              <p className="text-center text-[11px] text-slate-500">
                {mode === "login" ? "New here? Switch to Register" : "Already have account? Switch to Login"} · First account becomes admin
              </p>
            </div>
          </div>

          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-800" />
            </div>
            <div className="relative flex justify-center text-xs">
              <span className="bg-slate-900/60 px-2 text-slate-500">or</span>
            </div>
          </div>

          {discordConfigured ? (
            <a
              href="/api/auth/discord/login"
              className="group flex w-full items-center justify-center gap-2.5 rounded-xl bg-[#5865F2] px-4 py-3.5 text-sm font-semibold text-white shadow-lg shadow-indigo-900/40 transition hover:bg-[#4752c4] active:scale-[.98]"
            >
              <DiscordIcon />
              Continue with Discord
            </a>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-300 ring-1 ring-amber-500/20">
                Discord OAuth isn&apos;t configured. Use a quick guest login for now:
              </div>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && devLogin()}
                placeholder="Pick a username"
                className="w-full rounded-xl border border-slate-700 bg-slate-950/60 px-4 py-3 text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
              />
              <button
                onClick={devLogin}
                disabled={busy}
                className="w-full rounded-xl bg-slate-800 px-4 py-3 text-sm font-semibold text-slate-200 transition hover:bg-slate-700 disabled:opacity-50"
              >
                {busy ? "Signing in…" : "Continue as guest"}
              </button>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-[11px] text-slate-600">
          Secure session · local auth for now, will be removed later
        </p>
      </div>
    </div>
  );
}

function DiscordIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M20.317 4.369a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.249a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.036A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128c.126-.094.252-.192.372-.291a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.009c.12.099.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.331c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}
function BotIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01M2 13v2M22 13v2" />
    </svg>
  );
}
function ShieldIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}
function BrainIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 2A2.5 2.5 0 0 1 12 4.5v15a2.5 2.5 0 0 1-4.96.44 2.5 2.5 0 0 1-2.96-3.08 3 3 0 0 1-.34-5.58 2.5 2.5 0 0 1 1.32-4.24 2.5 2.5 0 0 1 1.98-3A2.5 2.5 0 0 1 9.5 2z" />
      <path d="M14.5 2A2.5 2.5 0 0 0 12 4.5v15a2.5 2.5 0 0 0 4.96.44 2.5 2.5 0 0 0 2.96-3.08 3 3 0 0 0 .34-5.58 2.5 2.5 0 0 0-1.32-4.24 2.5 2.5 0 0 0-1.98-3A2.5 2.5 0 0 0 14.5 2z" />
    </svg>
  );
}
function GearIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function LogoutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />
    </svg>
  );
}
function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M3 12h18M3 6h18M3 18h18" />
    </svg>
  );
}
function TicketIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  );
}
function ShopIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 01-8 0" />
    </svg>
  );
}
