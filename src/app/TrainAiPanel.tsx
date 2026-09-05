"use client";

import { useCallback, useEffect, useState } from "react";

type Convo = {
  id: string;
  target: string | null;
  outcome: string;
  transcript: { who: string; text: string }[];
  createdAt: string;
};

export default function TrainAiPanel() {
  const [training, setTraining] = useState(false);
  const [learnings, setLearnings] = useState("");
  const [convos, setConvos] = useState<Convo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/training", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setTraining(data.training);
      setLearnings(data.learnings ?? "");
      setConvos(data.conversations ?? []);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, [load]);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  }

  async function toggle() {
    setBusy(true);
    try {
      await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "toggle", value: !training }),
      });
      setTraining(!training);
      flash(!training ? "Training enabled" : "Training disabled");
    } finally {
      setBusy(false);
    }
  }

  async function analyze() {
    setAnalyzing(true);
    try {
      const res = await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "analyze" }),
      });
      const data = await res.json();
      if (data.learnings) setLearnings(data.learnings);
      flash(
        data.ok
          ? `Analyzed ${data.analyzed} conversations — guidelines updated`
          : "Not enough data to analyze yet",
      );
    } finally {
      setAnalyzing(false);
    }
  }

  async function saveLearnings() {
    setBusy(true);
    try {
      await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_learnings", learnings }),
      });
      flash("Guidelines saved");
    } finally {
      setBusy(false);
    }
  }

  async function clearAll() {
    if (!confirm("Delete all logged conversations?")) return;
    setBusy(true);
    try {
      await fetch("/api/admin/training", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "clear" }),
      });
      await load();
      flash("Conversations cleared");
    } finally {
      setBusy(false);
    }
  }

  const positive = convos.filter((c) => c.outcome === "positive").length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-700 text-lg shadow-lg shadow-indigo-900/40">
          🧠
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Train AI</h2>
          <p className="text-sm text-slate-400">
            The beam AI learns from real conversations to reply better.
          </p>
        </div>
      </div>

      {toast && (
        <div className="animate-fade-in rounded-xl bg-emerald-500/15 px-4 py-2.5 text-sm text-emerald-300 ring-1 ring-emerald-500/30">
          {toast}
        </div>
      )}

      {/* Toggle + stats */}
      <section className="glass rounded-2xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="font-semibold">Learning mode</h3>
            <p className="mt-0.5 text-sm text-slate-400">
              When on, the AI uses learned guidelines from past chats during the
              beam.
            </p>
          </div>
          <button
            onClick={toggle}
            disabled={busy}
            className={`relative h-8 w-14 rounded-full transition disabled:opacity-50 ${
              training ? "bg-emerald-500" : "bg-slate-700"
            }`}
          >
            <span
              className={`absolute top-1 h-6 w-6 rounded-full bg-white shadow transition-all ${
                training ? "left-7" : "left-1"
              }`}
            />
          </button>
        </div>

        <div className="mt-5 grid grid-cols-3 gap-3">
          <Stat label="Logged chats" value={convos.length} accent="text-sky-300" />
          <Stat label="Successful" value={positive} accent="text-emerald-300" />
          <Stat
            label="Status"
            value={training ? "ON" : "OFF"}
            accent={training ? "text-emerald-300" : "text-slate-400"}
            text
          />
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          <button
            onClick={analyze}
            disabled={analyzing || convos.length === 0}
            className="inline-flex items-center gap-2 rounded-xl bg-violet-500 px-4 py-2 text-sm font-semibold text-violet-950 transition hover:bg-violet-400 disabled:opacity-40"
          >
            {analyzing ? (
              <>
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-violet-900/40 border-t-violet-900" />
                Analyzing…
              </>
            ) : (
              <>✨ Analyze &amp; improve</>
            )}
          </button>
          <button
            onClick={clearAll}
            disabled={busy || convos.length === 0}
            className="rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-400 transition hover:border-rose-500/40 hover:text-rose-300 disabled:opacity-40"
          >
            Clear logs
          </button>
        </div>
      </section>

      {/* Learned guidelines */}
      <section className="glass rounded-2xl p-5">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Learned guidelines</h3>
          <button
            onClick={saveLearnings}
            disabled={busy}
            className="rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
          >
            Save
          </button>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          These are injected into the beam AI&apos;s prompt when learning mode is
          on. Auto-filled by &quot;Analyze &amp; improve&quot;, editable by hand.
        </p>
        <textarea
          value={learnings}
          onChange={(e) => setLearnings(e.target.value)}
          rows={8}
          placeholder="No guidelines yet. Run a few beams, then click Analyze & improve."
          className="mt-3 w-full resize-y rounded-xl border border-slate-700/80 bg-slate-950/60 px-3.5 py-3 font-mono text-xs leading-relaxed text-slate-200 placeholder:text-slate-600 outline-none transition focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20"
        />
      </section>

      {/* Conversation log */}
      <section className="glass rounded-2xl p-5">
        <h3 className="font-semibold">Conversation log</h3>
        <p className="mt-1 text-xs text-slate-500">
          Real beam conversations the AI can learn from.
        </p>

        <div className="mt-4 space-y-2">
          {!loaded ? (
            <p className="py-6 text-center text-sm text-slate-500">Loading…</p>
          ) : convos.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">
              No conversations logged yet. Start a beam to collect data.
            </p>
          ) : (
            convos.map((c) => (
              <div
                key={c.id}
                className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950/40"
              >
                <button
                  onClick={() => setOpenId(openId === c.id ? null : c.id)}
                  className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition hover:bg-slate-900/50"
                >
                  <span className="flex items-center gap-2 truncate text-sm">
                    <OutcomeBadge outcome={c.outcome} />
                    <span className="font-medium text-slate-200">
                      {c.target || "unknown"}
                    </span>
                    <span className="truncate text-xs text-slate-500">
                      {c.transcript.length} msgs
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-slate-600">
                    {new Date(c.createdAt).toLocaleString()}
                  </span>
                </button>
                {openId === c.id && (
                  <div className="space-y-1.5 border-t border-slate-800 bg-slate-950/60 p-3 font-mono text-xs">
                    {c.transcript.map((m, i) => (
                      <div
                        key={i}
                        className={
                          m.who === "me"
                            ? "text-fuchsia-300"
                            : "text-cyan-300"
                        }
                      >
                        <span className="text-slate-600">
                          {m.who === "me" ? "bot" : c.target}:
                        </span>{" "}
                        {m.text}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}

function Stat({
  label,
  value,
  accent,
  text,
}: {
  label: string;
  value: number | string;
  accent: string;
  text?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-4">
      <div className={`font-semibold ${accent} ${text ? "text-xl" : "text-2xl"}`}>
        {value}
      </div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const map: Record<string, { c: string; l: string }> = {
    positive: { c: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30", l: "won" },
    negative: { c: "bg-rose-500/15 text-rose-300 ring-rose-500/30", l: "no" },
    died: { c: "bg-amber-500/15 text-amber-300 ring-amber-500/30", l: "died" },
    stopped: { c: "bg-slate-600/20 text-slate-400 ring-slate-600/40", l: "stop" },
  };
  const m = map[outcome] || map.stopped;
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ring-1 ${m.c}`}
    >
      {m.l}
    </span>
  );
}
