"use client";

import { useCallback, useEffect, useState } from "react";

type Plan = {
  id: string;
  tier: string;
  price: number;
  finalPrice?: number;
  bots: number;
  hours: number;
  features: string[];
  popular: boolean;
  active: boolean;
  discount: number;
};

type Invoice = {
  id: string;
  planId: string | null;
  amountUSD: number;
  amountLTC: string;
  ltcAddress: string;
  ownerLtcAddress: string;
  status: string;
  expiresAt: string;
  createdAt: string;
  tier?: string;
  bots?: number;
  hours?: number;
};

const INVOICE_WINDOW_MS = 30 * 60 * 1000;

function fmtUsd(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

export default function ShopPanel({ onGoLicense }: { onGoLicense?: () => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [ltcPrice, setLtcPrice] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [buying, setBuying] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [checking, setChecking] = useState(false);
  const [paidInfo, setPaidInfo] = useState<{ licenseKey: string; bots: number; tier: string } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<string>("");
  const [urgent, setUrgent] = useState(false);
  const [progress, setProgress] = useState(1);
  const [myInvoices, setMyInvoices] = useState<Invoice[]>([]);
  const [resuming, setResuming] = useState<string | null>(null);
  const [qrFailed, setQrFailed] = useState(false);

  const fetchPlans = useCallback(async () => {
    try {
      const res = await fetch("/api/shop/plans", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setPlans(data.plans || []);
        if (typeof data.ltcPrice === "number" && data.ltcPrice > 0) setLtcPrice(data.ltcPrice);
      }
    } catch {}
    setLoaded(true);
  }, []);

  const fetchInvoices = useCallback(async () => {
    try {
      const res = await fetch("/api/shop/invoices", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        setMyInvoices(data.invoices || []);
      }
    } catch {}
  }, []);

  useEffect(() => {
    // deferred so setState happens in a callback, not synchronously in the effect
    const t = setTimeout(() => {
      void fetchPlans();
      void fetchInvoices();
    }, 0);
    return () => clearTimeout(t);
  }, [fetchPlans, fetchInvoices]);

  // countdown for invoice expiry
  useEffect(() => {
    if (!invoice) return;
    const interval = setInterval(() => {
      const exp = new Date(invoice.expiresAt).getTime();
      const created = new Date(invoice.createdAt).getTime();
      const now = Date.now();
      const diff = exp - now;
      if (diff <= 0) {
        setTimeLeft("Expired");
        setUrgent(true);
        setProgress(0);
        return;
      }
      const m = Math.floor(diff / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setTimeLeft(`${m}:${String(s).padStart(2, "0")}`);
      setUrgent(diff < 5 * 60 * 1000);
      const window = Math.max(1, exp - created);
      setProgress(Math.max(0, Math.min(1, diff / window)));
    }, 1000);
    return () => clearInterval(interval);
  }, [invoice]);

  // poll payment status when invoice is pending
  useEffect(() => {
    if (!invoice || paidInfo) return;
    if (invoice.status !== "pending") return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/shop/invoices/${invoice.id}/check`, { method: "POST" });
        const data = await res.json();
        if (data.paid) {
          setPaidInfo({ licenseKey: data.licenseKey, bots: data.bots, tier: data.tier });
          setInvoice(prev => (prev ? { ...prev, status: "paid" } : prev));
          fetchInvoices();
          clearInterval(interval);
        }
      } catch {}
    }, 8000);
    return () => clearInterval(interval);
  }, [invoice, paidInfo, fetchInvoices]);

  async function handleBuy(plan: Plan) {
    // Check login properly - ain't bypassable, server will enforce
    setBuying(plan.id);
    try {
      const meRes = await fetch("/api/auth/me", { cache: "no-store" });
      const meData = await meRes.json();
      if (!meData.user) {
        setToast("Please login properly to purchase – auth required.");
        setTimeout(() => setToast(null), 4000);
        return;
      }
      // Create invoice
      const res = await fetch("/api/shop/invoices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setToast(data.error || "Failed to create invoice");
        setTimeout(() => setToast(null), 4000);
        return;
      }
      setQrFailed(false);
      setPaidInfo(null);
      setInvoice(data.invoice);
      fetchInvoices();
    } catch {
      setToast("Network error creating invoice");
      setTimeout(() => setToast(null), 4000);
    } finally {
      setBuying(null);
    }
  }

  async function resumeInvoice(inv: Invoice) {
    setResuming(inv.id);
    try {
      const res = await fetch(`/api/shop/invoices/${inv.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || !data.invoice) {
        setToast(data.error || "Could not open invoice");
        setTimeout(() => setToast(null), 3000);
        return;
      }
      const i = data.invoice as Invoice & { plan?: { tier: string; bots: number; hours: number } };
      if (i.status === "paid") {
        setToast("That invoice is already paid — check your license key.");
        setTimeout(() => setToast(null), 3500);
        fetchInvoices();
        return;
      }
      if (i.status !== "pending") {
        setToast("That invoice has expired.");
        setTimeout(() => setToast(null), 3000);
        fetchInvoices();
        return;
      }
      setQrFailed(false);
      setPaidInfo(null);
      setInvoice({ ...i, tier: i.plan?.tier, bots: i.plan?.bots, hours: i.plan?.hours });
    } catch {
      setToast("Network error opening invoice");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setResuming(null);
    }
  }

  async function checkPaymentNow() {
    if (!invoice) return;
    setChecking(true);
    try {
      const res = await fetch(`/api/shop/invoices/${invoice.id}/check`, { method: "POST" });
      const data = await res.json();
      if (data.paid) {
        setPaidInfo({ licenseKey: data.licenseKey, bots: data.bots, tier: data.tier });
        setInvoice(prev => (prev ? { ...prev, status: "paid" } : prev));
        fetchInvoices();
      } else {
        setToast(`Not confirmed yet — detected ${data.balance || "0"} LTC. Send the exact amount.`);
        setTimeout(() => setToast(null), 3500);
      }
    } catch {
      setToast("Failed to check payment");
      setTimeout(() => setToast(null), 3000);
    } finally {
      setChecking(false);
    }
  }

  async function cancelInvoice() {
    if (!invoice) return;
    try {
      await fetch(`/api/shop/invoices/${invoice.id}`, { method: "DELETE" });
    } catch {}
    setInvoice(null);
    setPaidInfo(null);
    fetchInvoices();
  }

  function copy(text: string, id: string) {
    navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  }

  function downloadTxt() {
    if (!paidInfo) return;
    const content = `License Key: ${paidInfo.licenseKey}\nPlan: ${paidInfo.tier}\nBots: ${paidInfo.bots}\nRedeem in License tab: enter the key to unlock slots.\nGenerated: ${new Date().toISOString()}\n`;
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${paidInfo.licenseKey}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function autoRedeem() {
    if (!paidInfo) return;
    try {
      const res = await fetch("/api/licenses/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: paidInfo.licenseKey }),
      });
      const data = await res.json();
      if (res.ok) {
        setToast(`Redeemed! Got ${data.license.slots} slots`);
        setTimeout(() => {
          setToast(null);
          setInvoice(null);
          setPaidInfo(null);
          if (onGoLicense) onGoLicense();
        }, 1500);
      } else {
        setToast(data.error || "Redeem failed");
        setTimeout(() => setToast(null), 3000);
      }
    } catch {
      setToast("Network error redeeming");
      setTimeout(() => setToast(null), 3000);
    }
  }

  const tierOf = (inv: Invoice) =>
    inv.tier || plans.find(p => p.id === inv.planId)?.tier || "Plan";

  if (!loaded) {
    return (
      <div className="grid place-items-center py-16">
        <div className="flex items-center gap-2 text-sm text-slate-400">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-700 border-t-violet-400" />
          Loading shop…
        </div>
      </div>
    );
  }

  const payUri = invoice ? `litecoin:${invoice.ltcAddress}?amount=${invoice.amountLTC}` : "";

  return (
    <div className="relative mx-auto max-w-[1100px] pb-8">
      {/* subtle bg */}
      <div className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-[-60px] h-[300px] w-[300px] -translate-x-1/2 rounded-full bg-indigo-600/15 blur-[80px]" />
        <div className="absolute right-[5%] top-[160px] h-[200px] w-[200px] rounded-full bg-amber-500/10 blur-[70px]" />
      </div>

      {/* header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 shadow-[0_6px_18px_rgba(99,102,241,0.3)] ring-1 ring-white/10">
            <ShopBagIcon />
          </div>
          <div>
            <h2 className="text-xl font-bold tracking-tight text-white">Shop</h2>
            <p className="text-xs leading-relaxed text-slate-400">
              Pick a plan — pay with Litecoin, get your license key instantly
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {ltcPrice && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] font-medium text-slate-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LTC ≈ ${ltcPrice.toFixed(2)}
            </span>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-400">
            🔒 Secure checkout · Automatic delivery
          </span>
        </div>
      </div>

      {/* plan cards */}
      <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {plans.map((plan) => {
          const isDiscounted = plan.discount > 0;
          const displayPrice = plan.finalPrice ?? plan.price;
          const originalPrice = plan.price;
          return (
            <div
              key={plan.id}
              className={`group relative flex flex-col rounded-2xl border p-[1px] transition duration-200 hover:-translate-y-0.5 ${
                plan.popular
                  ? "border-violet-500/40 bg-gradient-to-b from-violet-500/20 to-indigo-500/10 shadow-[0_0_28px_rgba(99,102,241,0.18)]"
                  : "border-slate-800 bg-slate-800/20 hover:border-slate-600"
              }`}
            >
              {plan.popular && (
                <div className="absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-indigo-500 to-blue-500 px-2.5 py-0.5 text-[9px] font-bold uppercase tracking-widest text-white shadow ring-1 ring-white/20">
                  Most Popular
                </div>
              )}
              <div className="flex flex-1 flex-col rounded-[15px] bg-[#0f1220]/90 p-5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500 group-hover:text-slate-400">{plan.tier}</span>
                  {isDiscounted && (
                    <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold text-amber-300 ring-1 ring-amber-500/20">
                      −{plan.discount}% OFF
                    </span>
                  )}
                </div>

                <div className="mt-2 flex items-baseline gap-1.5">
                  <span className="text-[30px] font-extrabold leading-none tracking-tight text-white">{fmtUsd(displayPrice)}</span>
                  <span className="text-xs text-slate-500">/month</span>
                  {isDiscounted && <span className="ml-1 text-xs line-through text-slate-600">{fmtUsd(originalPrice)}</span>}
                </div>
                {ltcPrice ? (
                  <div className="mt-1 text-[11px] font-mono text-slate-500">≈ {(displayPrice / ltcPrice).toFixed(4)} LTC</div>
                ) : null}

                <div className="mt-4 grid grid-cols-2 gap-1.5">
                  <div className="rounded-lg bg-slate-900/70 px-2.5 py-2 text-center ring-1 ring-slate-800">
                    <div className="text-sm font-bold text-white">{plan.bots}</div>
                    <div className="text-[9px] uppercase tracking-widest text-slate-500">Bots</div>
                  </div>
                  <div className="rounded-lg bg-slate-900/70 px-2.5 py-2 text-center ring-1 ring-slate-800">
                    <div className="text-sm font-bold text-white">{plan.hours}h</div>
                    <div className="text-[9px] uppercase tracking-widest text-slate-500">Per day</div>
                  </div>
                </div>

                <div className="mt-4 space-y-1.5">
                  {plan.features.slice(0, 7).map((f, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] leading-[1.35] text-slate-300">
                      <span className="mt-[1px] grid h-4 w-4 shrink-0 place-items-center rounded-full bg-emerald-500/10 text-[9px] text-emerald-400 ring-1 ring-emerald-500/20">✓</span>
                      <span>{f}</span>
                    </div>
                  ))}
                  {plan.features.length > 7 && (
                    <div className="pl-6 text-[10px] text-slate-500">+{plan.features.length - 7} more…</div>
                  )}
                </div>

                <div className="mt-auto pt-5">
                  <button
                    onClick={() => handleBuy(plan)}
                    disabled={!!buying}
                    className={`w-full rounded-xl py-2.5 text-xs font-bold transition active:scale-[0.98] disabled:opacity-50 ${
                      plan.popular
                        ? "bg-gradient-to-r from-indigo-500 to-blue-600 text-white shadow-[0_4px_14px_rgba(99,102,241,0.3)] hover:from-indigo-400 hover:to-blue-500"
                        : "border border-slate-700 bg-slate-900 text-slate-200 hover:border-slate-500 hover:bg-slate-800"
                    }`}
                  >
                    {buying === plan.id ? "Creating invoice…" : `Get ${plan.tier}`}
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* invoice history */}
      {myInvoices.length > 0 && (
        <div className="mt-8">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-300">Your invoices</h3>
            <span className="text-[11px] text-slate-500">{myInvoices.length} total</span>
          </div>
          <div className="mt-3 overflow-hidden rounded-2xl border border-slate-800">
            <table className="w-full text-left text-xs">
              <thead className="bg-slate-900/70 text-[10px] uppercase tracking-widest text-slate-500">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Plan</th>
                  <th className="px-4 py-2.5 font-medium">Amount</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70 bg-slate-900/30">
                {myInvoices.slice(0, 8).map(inv => (
                  <tr key={inv.id} className="text-slate-300">
                    <td className="px-4 py-2.5 font-semibold text-white">{tierOf(inv)}</td>
                    <td className="px-4 py-2.5 font-mono">{fmtUsd(inv.amountUSD)} <span className="text-slate-500">· {inv.amountLTC} LTC</span></td>
                    <td className="px-4 py-2.5 text-slate-400">{new Date(inv.createdAt).toLocaleString()}</td>
                    <td className="px-4 py-2.5"><StatusBadge status={inv.status} /></td>
                    <td className="px-4 py-2.5 text-right">
                      {inv.status === "pending" && new Date(inv.expiresAt) > new Date() && (
                        <button
                          onClick={() => resumeInvoice(inv)}
                          disabled={resuming === inv.id}
                          className="rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-2.5 py-1 text-[11px] font-semibold text-indigo-300 hover:bg-indigo-500/20 disabled:opacity-50"
                        >
                          {resuming === inv.id ? "Opening…" : "Resume"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Checkout Modal */}
      {invoice && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="max-h-[92vh] w-full max-w-[460px] overflow-y-auto rounded-2xl border border-slate-700 bg-[#151a2c] shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-800 text-slate-300 ring-1 ring-slate-700">
                  <LtcIcon />
                </span>
                <div>
                  <h3 className="text-sm font-bold text-white">{paidInfo ? "Order complete" : "Litecoin checkout"}</h3>
                  <p className="text-[11px] text-slate-500">{paidInfo ? "License ready to redeem" : `${tierOf(invoice)} · 1 month`}</p>
                </div>
              </div>
              <button onClick={cancelInvoice} className="grid h-7 w-7 place-items-center rounded-full bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white">
                ✕
              </button>
            </div>

            <div className="p-5">
              {!paidInfo ? (
                <>
                  {/* order summary */}
                  <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-white">{tierOf(invoice)} plan</span>
                      <span className="rounded-full bg-slate-800 px-2 py-0.5 text-[10px] font-medium text-slate-400">{invoice.bots ?? "—"} bots · {invoice.hours ?? "—"}h/day</span>
                    </div>
                    <div className="mt-3 flex items-end justify-between border-t border-slate-800 pt-3">
                      <span className="text-xs text-slate-500">Total due</span>
                      <div className="text-right">
                        <div className="text-lg font-bold text-white">{fmtUsd(invoice.amountUSD)}</div>
                        <div className="text-[11px] font-mono text-slate-400">≈ {invoice.amountLTC} LTC</div>
                      </div>
                    </div>
                  </div>

                  {/* countdown */}
                  <div className="mt-4">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="text-slate-500">Rate locks for</span>
                      <span className={`font-mono font-bold ${urgent ? "text-rose-400" : "text-slate-300"}`}>{timeLeft || "30:00"}</span>
                    </div>
                    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className={`h-full rounded-full transition-all duration-1000 ${urgent ? "bg-rose-500" : "bg-gradient-to-r from-indigo-500 to-blue-500"}`}
                        style={{ width: `${Math.round(progress * 100)}%` }}
                      />
                    </div>
                  </div>

                  {/* payment details */}
                  <div className="mt-4 grid grid-cols-[1fr_118px] gap-3">
                    <div className="space-y-3">
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Send exactly</div>
                        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5">
                          <span className="flex-1 truncate font-mono text-xs font-bold text-white">{invoice.amountLTC} LTC</span>
                          <button onClick={() => copy(invoice.amountLTC, "amt")} className="rounded bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-300 hover:bg-slate-700">
                            {copied === "amt" ? "✓" : "COPY"}
                          </button>
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">To address</div>
                        <div className="mt-1.5 flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5">
                          <span className="flex-1 truncate font-mono text-[11px] text-white">{invoice.ltcAddress}</span>
                          <button onClick={() => copy(invoice.ltcAddress, "addr")} className="rounded bg-slate-800 px-2 py-1 text-[10px] font-bold text-slate-300 hover:bg-slate-700">
                            {copied === "addr" ? "✓" : "COPY"}
                          </button>
                        </div>
                      </div>
                      <button
                        onClick={() => copy(payUri, "uri")}
                        className="w-full rounded-lg border border-slate-700 bg-slate-900 py-2 text-[11px] font-semibold text-slate-300 hover:bg-slate-800"
                      >
                        {copied === "uri" ? "✓ Payment link copied" : "Copy payment link (opens wallet)"}
                      </button>
                    </div>
                    <div className="flex flex-col items-center gap-1.5">
                      {!qrFailed ? (
                        <div className="rounded-lg bg-white p-1.5">
                          <img
                            src={`https://api.qrserver.com/v1/create-qr-code/?size=160x160&margin=0&data=${encodeURIComponent(payUri)}`}
                            alt="LTC QR"
                            width={96}
                            height={96}
                            className="h-[96px] w-[96px]"
                            onError={() => setQrFailed(true)}
                          />
                        </div>
                      ) : (
                        <div className="grid h-[102px] w-[102px] place-items-center rounded-lg border border-dashed border-slate-700 text-center text-[9px] leading-tight text-slate-500">
                          QR unavailable — copy the address
                        </div>
                      )}
                      <div className="text-[10px] text-slate-500">scan with LTC wallet</div>
                    </div>
                  </div>

                  {/* waiting */}
                  <div className="mt-4 flex items-center justify-center gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2.5 text-xs text-amber-300">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-amber-500/30 border-t-amber-400" />
                    Waiting for payment — checking every 8s…
                  </div>

                  <div className="mt-3 rounded-lg bg-slate-900/60 px-3 py-2.5 text-[11px] leading-relaxed text-slate-400">
                    <div className="flex gap-2">
                      <span className="mt-0.5">ⓘ</span>
                      <span>
                        Send the exact amount from any LTC wallet. Your license key is generated automatically once the payment confirms (usually a few minutes).
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 flex gap-2">
                    <button onClick={checkPaymentNow} disabled={checking} className="flex-1 rounded-xl border border-slate-700 bg-slate-800 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-50">
                      {checking ? "Checking…" : "I've paid — check now"}
                    </button>
                    <button onClick={cancelInvoice} className="flex-1 rounded-xl border border-rose-900/40 bg-rose-500/10 py-2.5 text-xs font-semibold text-rose-400 hover:bg-rose-500/20">
                      Cancel invoice
                    </button>
                  </div>
                </>
              ) : (
                <div className="text-center">
                  <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-emerald-500/15 text-2xl text-emerald-400 ring-1 ring-emerald-500/20">✓</div>
                  <h4 className="mt-3 text-base font-bold text-white">Payment confirmed!</h4>
                  <p className="mt-1 text-xs text-slate-400">
                    {paidInfo.tier} · {paidInfo.bots} bots — your license key is ready
                  </p>

                  <div className="mt-4 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3">
                    <div className="text-[10px] uppercase tracking-widest text-slate-500">License key</div>
                    <code className="mt-1 block break-all rounded-lg bg-slate-950 px-3 py-2.5 font-mono text-xs font-bold text-amber-300">{paidInfo.licenseKey}</code>
                    <div className="mt-2 flex gap-2">
                      <button onClick={() => copy(paidInfo.licenseKey, "key")} className="flex-1 rounded-lg bg-slate-800 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700">
                        {copied === "key" ? "Copied!" : "Copy key"}
                      </button>
                      <button onClick={downloadTxt} className="flex-1 rounded-lg bg-amber-500/15 py-2 text-xs font-semibold text-amber-300 ring-1 ring-amber-500/20 hover:bg-amber-500/20">
                        Download .txt
                      </button>
                    </div>
                  </div>

                  <div className="mt-4 space-y-1 rounded-lg bg-slate-900/60 p-3 text-left text-[11px] leading-relaxed text-slate-400">
                    <div>✓ Payment of {invoice.amountLTC} LTC detected</div>
                    <div>✓ {paidInfo.bots} bot slots unlocked on redeem</div>
                    <div>✓ Valid for 30 days from redemption</div>
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <button onClick={autoRedeem} className="rounded-xl bg-emerald-500 py-3 text-xs font-bold text-emerald-950 transition hover:bg-emerald-400">
                      Redeem now
                    </button>
                    <button onClick={() => { setInvoice(null); setPaidInfo(null); if (onGoLicense) onGoLicense(); }} className="rounded-xl border border-slate-700 bg-slate-800 py-3 text-xs font-semibold text-slate-200 hover:bg-slate-700">
                      Go to License
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {toast && (
        <div className="fixed bottom-5 left-1/2 z-50 max-w-[90%] -translate-x-1/2 rounded-xl border border-slate-700 bg-slate-900 px-4 py-2.5 text-xs text-slate-200 shadow-2xl">
          {toast}
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    pending: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    paid: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    expired: "border-slate-600/40 bg-slate-700/20 text-slate-400",
    forwarded: "border-indigo-500/30 bg-indigo-500/10 text-indigo-300",
  };
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold capitalize ${map[status] || map.expired}`}>
      {status === "pending" && <span className="h-1 w-1 animate-pulse rounded-full bg-current" />}
      {status}
    </span>
  );
}

function ShopBagIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 2L3 6v14a2 2 0 002 2h14a2 2 0 002-2V6l-3-4z" />
      <line x1="3" y1="6" x2="21" y2="6" />
      <path d="M16 10a4 4 0 01-8 0" />
    </svg>
  );
}
function LtcIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 8h8M8 12h8M8 16h8M10 4L8 8M14 4l-2 4M10 16l-2 4M14 16l2 4" />
    </svg>
  );
}
