"use client";

import { useCallback, useEffect, useState } from "react";

type LicenseInfo = {
  id: string;
  slots: number;
  durationDays: number;
  durationHours: number;
  expiresAt: string;
  active: boolean;
  reason: string;
  licenseKey?: string;
  createdAt: string;
  isExpired: boolean;
  timeLeft: string;
};

type LicenseStatus = {
  totalSlots: number;
  usedSlots: number;
  availableSlots: number;
  activeLicenses: LicenseInfo[];
  expiredLicenses: LicenseInfo[];
  hasActiveLicense: boolean;
  nextExpiry: string | null;
};

export default function LicensePanel() {
  const [status, setStatus] = useState<LicenseStatus | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [redeemMsg, setRedeemMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [redeeming, setRedeeming] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/licenses", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setStatus(data);
      }
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 10000);
    return () => clearInterval(t);
  }, [refresh]);

  async function redeem() {
    const k = keyInput.trim();
    if (!k) {
      setRedeemMsg({ type: "error", text: "Enter a license key" });
      return;
    }
    if (!k.startsWith("abeam-key-")) {
      setRedeemMsg({ type: "error", text: "Invalid format - key should start with abeam-key-" });
      return;
    }
    setRedeeming(true);
    setRedeemMsg(null);
    try {
      const res = await fetch("/api/licenses/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: k }),
      });
      const data = await res.json();
      if (!res.ok) {
        setRedeemMsg({ type: "error", text: data.error || "Failed to redeem" });
        return;
      }
      setRedeemMsg({ type: "success", text: `Redeemed! Got ${data.license.slots} slots for ${data.license.durationDays}d ${data.license.durationHours}h` });
      setKeyInput("");
      await refresh();
    } catch {
      setRedeemMsg({ type: "error", text: "Network error" });
    } finally {
      setRedeeming(false);
    }
  }

  if (!loaded) {
    return (
      <div className="grid place-items-center py-20">
        <div className="flex items-center gap-3 text-sm text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-amber-400" />
          Loading licenses…
        </div>
      </div>
    );
  }

  if (!status) {
    return <p className="py-10 text-center text-slate-500">Failed to load.</p>;
  }

  const hasLicense = status.totalSlots > 0;

  return (
    <div className="relative">
      {/* background glow */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-[-40px] top-[-40px] h-[260px] w-[260px] rounded-full bg-amber-500/10 blur-[80px]" />
        <div className="absolute right-[-20px] top-[80px] h-[200px] w-[200px] rounded-full bg-orange-500/10 blur-[80px]" />
      </div>

      <div className="flex items-start gap-4">
        <div className="relative">
          <div className="absolute inset-0 rounded-[16px] bg-gradient-to-br from-amber-400 to-orange-600 blur-[14px] opacity-50" />
          <div className="relative grid h-[48px] w-[48px] place-items-center rounded-[16px] bg-gradient-to-br from-amber-400 via-orange-500 to-orange-600 shadow-[0_8px_24px_rgba(245,158,11,0.35)] ring-1 ring-white/15">
            <TicketThumbIcon />
            <div className="absolute inset-0 rounded-[16px] bg-gradient-to-tr from-white/25 to-transparent" />
          </div>
        </div>
        <div className="flex-1">
          <h2 className="text-[20px] font-bold tracking-tight text-white">License</h2>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-400">
            Redeem a license key to get bot slots. Keys look like{" "}
            <span className="rounded bg-amber-500/10 px-1.5 py-0.5 font-mono text-amber-300 ring-1 ring-amber-500/20">abeam-key-xxxx-xxxx</span>
          </p>
        </div>
        <div className="hidden sm:flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-400 backdrop-blur">
          <span className={`h-2 w-2 rounded-full ${hasLicense ? "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)] animate-pulse" : "bg-slate-600"}`} />
          {hasLicense ? `${status.totalSlots} slots active` : "No license"}
        </div>
      </div>

      <div className="mt-7 grid grid-cols-3 gap-3">
        <StatCard label="TOTAL SLOTS" value={status.totalSlots} accent="text-amber-300" sub="max bots" icon={<SlotsIcon />} gradient="from-amber-500/15 to-orange-500/10" />
        <StatCard label="USED" value={status.usedSlots} accent="text-slate-100" sub="running" icon={<UsedIcon />} gradient="from-slate-700/40 to-slate-800/20" />
        <StatCard label="AVAILABLE" value={status.availableSlots} accent="text-emerald-300" sub="free" icon={<AvailableIcon />} gradient="from-emerald-500/15 to-teal-500/10" />
      </div>

      {/* Redeem section */}
      <div className="group mt-6 relative overflow-hidden rounded-[18px] border border-slate-800 bg-slate-900/70 p-[1px] backdrop-blur-xl">
        <div className="absolute inset-0 bg-gradient-to-br from-amber-500/10 via-transparent to-orange-500/10 opacity-0 transition-opacity group-hover:opacity-100" />
        <div className="relative rounded-[17px] bg-[#0f121f]/80 p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-2 text-[14px] font-semibold text-white">
                <span className="grid h-6 w-6 place-items-center rounded-lg bg-amber-500/15 text-amber-300 ring-1 ring-amber-500/20">
                  <KeyIcon />
                </span>
                Redeem License Key
              </h3>
              <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
                Enter your key like <code className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-amber-300">abeam-key-aqiwok192k</code> to unlock slots instantly
              </p>
            </div>
            <div className="hidden sm:flex items-center gap-1 rounded-full bg-slate-800 px-2.5 py-1 text-[10px] font-medium text-slate-400 ring-1 ring-slate-700/50">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
              Secure redeem
            </div>
          </div>

          <div className="mt-5 flex gap-2.5">
            <div className="relative flex-1">
              <input
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && redeem()}
                placeholder="abeam-key-xxxxxxxxxx-xxxxxx"
                className="w-full rounded-xl border border-slate-700/80 bg-slate-950/70 px-4 py-3.5 pr-10 text-[13px] font-mono tracking-wide text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-amber-500/50 focus:ring-2 focus:ring-amber-500/20"
              />
              <div className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-600">
                <TicketSmallIcon />
              </div>
            </div>
            <button
              onClick={redeem}
              disabled={redeeming}
              className="group/btn relative overflow-hidden rounded-xl bg-gradient-to-br from-amber-400 via-orange-500 to-orange-600 px-7 py-3.5 text-[13px] font-bold text-amber-950 shadow-[0_8px_24px_rgba(245,158,11,0.3)] transition-all hover:from-amber-300 hover:to-orange-500 hover:shadow-[0_12px_32px_rgba(245,158,11,0.4)] active:scale-[0.98] disabled:opacity-50"
            >
              <span className="relative z-10 flex items-center gap-1.5">
                {redeeming ? "Redeeming…" : "Redeem"}
                {!redeeming && <span className="text-[14px]">→</span>}
              </span>
              <div className="absolute inset-0 bg-gradient-to-r from-white/0 via-white/20 to-white/0 opacity-0 transition-opacity group-hover/btn:opacity-100" />
            </button>
          </div>

          {redeemMsg && (
            <div className={`mt-4 flex items-start gap-2 rounded-xl px-3.5 py-3 text-[12px] leading-relaxed ${redeemMsg.type === "success" ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/20" : "bg-rose-500/10 text-rose-300 ring-1 ring-rose-500/20"}`}>
              <span className={`mt-0.5 grid h-5 w-5 place-items-center rounded-full text-[11px] ${redeemMsg.type === "success" ? "bg-emerald-500/20" : "bg-rose-500/20"}`}>
                {redeemMsg.type === "success" ? "✓" : "!"}
              </span>
              <span>{redeemMsg.text}</span>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
            <span>Need a key?</span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-slate-400 ring-1 ring-slate-700/50">Go to Shop tab → choose $5 / $8 / $15</span>
            <span>· Contact admin on Discord</span>
          </div>
        </div>
      </div>

      {!hasLicense ? (
        <div className="mt-6 relative overflow-hidden rounded-[18px] border border-amber-500/20 bg-gradient-to-br from-amber-500/[0.08] to-orange-500/[0.05] p-[1px]">
          <div className="rounded-[17px] bg-slate-900/80 p-8 text-center backdrop-blur">
            <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-500/10 text-3xl ring-1 ring-amber-500/20">🔒</div>
            <h3 className="mt-4 text-[15px] font-semibold text-amber-200">No active license</h3>
            <p className="mx-auto mt-2 max-w-[420px] text-[12px] leading-relaxed text-amber-200/60">
              You start with 0 bot slots. Redeem a key above to get slots.
              <br />
              License decides how many slots and for how long (days/hours) they stay.
            </p>
            {status.nextExpiry && (
              <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-slate-800 px-3 py-1 text-[11px] text-slate-400 ring-1 ring-slate-700/50">
                <span className="h-1.5 w-1.5 rounded-full bg-slate-500" />
                Next expiry: {new Date(status.nextExpiry).toLocaleString()}
              </p>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-7 space-y-5">
          <div className="relative overflow-hidden rounded-[16px] border border-emerald-500/20 bg-gradient-to-br from-emerald-500/10 via-emerald-500/5 to-teal-500/5 p-[1px]">
            <div className="rounded-[15px] bg-slate-900/70 p-4 backdrop-blur">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.6)] animate-pulse" />
                <span className="text-[13px] font-semibold tracking-wide text-emerald-200">Active License</span>
                <span className="ml-auto rounded-full bg-emerald-500/10 px-2.5 py-1 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/20">
                  {status.availableSlots} free
                </span>
              </div>
              <p className="mt-2.5 text-[12px] leading-relaxed text-emerald-200/60">
                You have <span className="font-semibold text-emerald-200">{status.totalSlots} slots</span>,{" "}
                <span className="font-semibold text-emerald-300">{status.availableSlots} available</span>.
                {status.nextExpiry && (
                  <>
                    {" "}
                    Expires {new Date(status.nextExpiry).toLocaleString()} ({status.activeLicenses[0]?.timeLeft})
                  </>
                )}
              </p>
            </div>
          </div>

          <div>
            <h3 className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-200">
              <span className="h-1 w-1 rounded-full bg-emerald-400" />
              Active Licenses
            </h3>
            <div className="mt-3 space-y-2.5">
              {status.activeLicenses.map((lic) => (
                <LicenseCard key={lic.id} lic={lic} />
              ))}
            </div>
          </div>

          {status.expiredLicenses.length > 0 && (
            <div>
              <h3 className="flex items-center gap-2 text-[13px] font-semibold tracking-wide text-slate-500">
                <span className="h-1 w-1 rounded-full bg-slate-600" />
                Expired / Inactive
              </h3>
              <div className="mt-3 space-y-2.5">
                {status.expiredLicenses.map((lic) => (
                  <LicenseCard key={lic.id} lic={lic} expired />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LicenseCard({ lic, expired }: { lic: LicenseInfo; expired?: boolean }) {
  return (
    <div className={`group relative overflow-hidden rounded-[14px] border p-[1px] transition-all hover:-translate-y-[1px] ${expired ? "border-slate-800/60 bg-slate-900/30 opacity-60" : "border-slate-700/60 bg-slate-800/40 hover:border-slate-600/60 hover:bg-slate-800/60"}`}>
      <div className={`rounded-[13px] p-3.5 ${expired ? "bg-slate-900/40" : "bg-slate-900/60 backdrop-blur"}`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <span className={`h-2 w-2 rounded-full ${expired ? "bg-slate-500" : "bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]"}`} />
            <span className="text-[12px] font-semibold text-slate-200">{lic.slots} slots</span>
            <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[11px] text-slate-500 ring-1 ring-slate-700/40">
              {lic.durationDays}d {lic.durationHours}h
            </span>
          </div>
          <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${expired ? "bg-slate-800 text-slate-500" : "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/20"}`}>
            {lic.timeLeft}
          </span>
        </div>
        <div className="mt-2.5 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
          <span className="inline-flex items-center gap-1">
            <ClockIcon /> {new Date(lic.expiresAt).toLocaleString()}
          </span>
          {lic.reason && (
            <span className="rounded bg-slate-800/60 px-1.5 py-0.5 text-slate-400 ring-1 ring-slate-700/30">{lic.reason}</span>
          )}
          {lic.licenseKey && <span className="font-mono text-amber-300/50">· {lic.licenseKey.slice(0, 22)}...</span>}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, accent, sub, icon, gradient }: { label: string; value: number; accent: string; sub: string; icon: React.ReactNode; gradient: string }) {
  return (
    <div className="group relative overflow-hidden rounded-[16px] border border-slate-800 bg-slate-900/60 p-[1px] backdrop-blur transition-all hover:-translate-y-[1px] hover:border-slate-700">
      <div className={`absolute inset-0 bg-gradient-to-br ${gradient} opacity-0 transition-opacity group-hover:opacity-100`} />
      <div className="relative rounded-[15px] bg-[#121526]/80 p-4">
        <div className="flex items-start justify-between">
          <div className={`grid h-8 w-8 place-items-center rounded-lg bg-slate-800 text-slate-400 ring-1 ring-slate-700/50`}>{icon}</div>
          <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-widest text-slate-500 ring-1 ring-slate-700/30">{sub}</span>
        </div>
        <div className={`mt-3 text-[26px] font-bold leading-none tracking-tight ${accent}`}>{value}</div>
        <div className="mt-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-500">{label}</div>
      </div>
    </div>
  );
}

function TicketThumbIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
      <path d="M13 5v2M13 17v2M13 11v2" />
    </svg>
  );
}
function TicketSmallIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z" />
    </svg>
  );
}
function KeyIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="7.5" cy="7.5" r="4.5" />
      <path d="m21 21-5.5-5.5M10.5 7.5h3M7.5 10.5v-3" />
    </svg>
  );
}
function ClockIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}
function SlotsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function UsedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function AvailableIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
    </svg>
  );
}
