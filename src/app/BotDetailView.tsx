"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BotItem, BotStatus, LogEntry, HotbarItem, ViewSnapshot } from "./types";
import { StatusBadge, BotAvatar } from "./BotDashboard";

export default function BotDetailView({
  bot,
  onChanged,
}: {
  bot: BotItem;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"console" | "screen">("console");
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<BotStatus>(bot.status);
  const [msg, setMsg] = useState("");
  const [beam, setBeam] = useState<{ looping: boolean; stage: string }>({
    looping: false,
    stage: "",
  });
  const [ai, setAi] = useState<{
    lastProvider: string | null;
    pollinations: number;
    openrouter: number;
    failed: number;
    lastLatencyMs: number;
  } | null>(null);
  const [acting, setActing] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [snap, setSnap] = useState<ViewSnapshot | null>(null);

  const poll = useCallback(async () => {
    try {
      const endpoint = tab === "console" ? "console" : "view";
      const res = await fetch(`/api/bots/${bot.id}/${endpoint}`, {
        cache: "no-store",
      });
      const data = await res.json();
      setStatus(data.status ?? "offline");
      setBeam(data.beam ?? { looping: false, stage: "" });
      if (data.ai) setAi(data.ai);
      if (tab === "console") {
        const rawLogs = data.logs ?? [];
        const filtered = rawLogs.filter((l: any) => {
          const line = (l.line || "").toLowerCase();
          const bad = [
            "more than 1,000 items",
            "packet-event",
            "error reading packet",
            "explode (id 36)",
            "failed to fill whole buffer",
            "packet explode",
            "azalea_client::plugins::connection",
          ];
          return !bad.some(f => line.includes(f));
        });
        setLogs(filtered);
      } else {
        setSnap(data.snapshot ?? { available: false });
      }
    } catch {
      /* ignore */
    }
  }, [bot.id, tab]);

  useEffect(() => {
    poll();
    const t = setInterval(poll, tab === "console" ? 1500 : 700);
    return () => clearInterval(t);
  }, [poll, tab]);

  useEffect(() => {
    const el = scroller.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  async function act(action: string, method = "POST") {
    setActing(true);
    try {
      await fetch(`/api/bots/${bot.id}/${action}`, { method });
      await onChanged();
      await poll();
    } finally {
      setActing(false);
    }
  }

  async function doAction(action: string, payload: any = {}) {
    setActing(true);
    try {
      await fetch(`/api/bots/${bot.id}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
      await poll();
    } finally {
      setActing(false);
    }
  }

  async function sendChat() {
    const m = msg.trim();
    if (!m) return;
    setMsg("");
    await fetch(`/api/bots/${bot.id}/console`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: m }),
    });
    poll();
  }

  async function toggleBeam() {
    await doAction(beam.looping ? "beam_stop" : "beam_start");
  }

  const running = status === "online" || status === "connecting";

  return (
    <div className="glass flex flex-col overflow-hidden rounded-[24px] border border-slate-800/80">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-white/5 bg-white/[0.02] px-6 py-4">
        <div className="flex items-center gap-4">
          <BotAvatar
            username={bot.username}
            status={status}
            className="h-12 w-12 rounded-2xl text-2xl shadow-lg transition-colors"
          />
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-bold text-white">{bot.name}</h2>
              <StatusBadge status={status} />
              {beam.looping && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-fuchsia-500/15 px-2 py-0.5 text-xs font-medium text-fuchsia-300 ring-1 ring-fuchsia-500/30">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-fuchsia-400" />
                  beam: {beam.stage || "running"}
                </span>
              )}
              {ai && ai.pollinations + ai.openrouter + ai.failed > 0 && (
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ${
                    ai.lastProvider
                      ? "bg-emerald-500/15 text-emerald-300 ring-emerald-500/30"
                      : "bg-rose-500/15 text-rose-300 ring-rose-500/30"
                  }`}
                  title={`pollinations: ${ai.pollinations} · openrouter: ${ai.openrouter} · failed: ${ai.failed}`}
                >
                  AI:{" "}
                  {ai.lastProvider
                    ? `${ai.lastProvider} · ${(ai.lastLatencyMs / 1000).toFixed(1)}s`
                    : "offline — canned replies"}
                </span>
              )}
            </div>
            <p className="text-sm font-medium text-slate-400">
              {bot.host}:{bot.port}
              {bot.username && ` · as ${bot.username}`}
              {bot.engine && ` · ${bot.engine === "azalea" ? "Azalea" : bot.engine === "nmp" ? "NMP" : "Mineflayer"}`}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {beam.looping ? (
            <button
              onClick={toggleBeam}
              disabled={acting}
              className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-semibold text-rose-950 transition hover:bg-rose-400 disabled:opacity-40"
            >
              ⏹ Stop Beam
            </button>
          ) : (
            <button
              onClick={toggleBeam}
              disabled={acting || status !== "online"}
              className="rounded-xl bg-fuchsia-500 px-4 py-2 text-sm font-semibold text-fuchsia-950 transition hover:bg-fuchsia-400 disabled:opacity-40"
            >
              📡 Beam
            </button>
          )}
          {running ? (
            <button
              disabled={acting}
              onClick={() => act("stop")}
              className="rounded-xl bg-amber-500/90 px-4 py-2 text-sm font-semibold text-amber-950 transition hover:bg-amber-400 disabled:opacity-40"
            >
              Stop Bot
            </button>
          ) : (
            <button
              disabled={acting}
              onClick={() => act("start")}
              className="rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 transition hover:bg-emerald-400 disabled:opacity-40"
            >
              Start Bot
            </button>
          )}
        </div>
      </div>

      <div className="flex border-b border-white/5 bg-black/20 px-6">
        <button
          onClick={() => setTab("console")}
          className={`border-b-2 px-4 py-3 text-sm font-medium transition ${
            tab === "console"
              ? "border-emerald-400 text-emerald-400"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          Console
        </button>
        <button
          onClick={() => setTab("screen")}
          className={`border-b-2 px-4 py-3 text-sm font-medium transition ${
            tab === "screen"
              ? "border-emerald-400 text-emerald-400"
              : "border-transparent text-slate-400 hover:text-slate-200"
          }`}
        >
          Screen / Game View
        </button>
      </div>

      <div className="flex h-[68vh] flex-col bg-[#030712]/50">
        {tab === "console" ? (
          <>
            <div
              ref={scroller}
              onScroll={(e) => {
                const el = e.currentTarget;
                stickToBottom.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 40;
              }}
              className="flex-1 overflow-y-auto p-4 font-mono text-sm leading-relaxed"
            >
              {logs.length === 0 ? (
                <p className="text-slate-600">No output yet…</p>
              ) : (
                logs.map((l, i) => {
                  const w = whisperKind(l.line);
                  return (
                    <div key={i} className="whitespace-pre-wrap break-words">
                      <span className="text-slate-600">
                        {new Date(l.ts).toLocaleTimeString()}{" "}
                      </span>
                      {w === "from" ? (
                        <span className="rounded bg-cyan-500/15 px-1 font-semibold text-cyan-300 ring-1 ring-cyan-500/30">
                          {l.line}
                        </span>
                      ) : w === "to" ? (
                        <span className="rounded bg-fuchsia-500/15 px-1 font-semibold text-fuchsia-300 ring-1 ring-fuchsia-500/30">
                          {l.line}
                        </span>
                      ) : (
                        <span className={logColor(l.level)}>{l.line}</span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
            <div className="flex gap-3 border-t border-white/5 bg-black/20 p-4">
              <input
                value={msg}
                onChange={(e) => setMsg(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && sendChat()}
                placeholder={
                  status === "online"
                    ? "Type a chat message or command…"
                    : "Bot must be online to chat"
                }
                disabled={status !== "online"}
                className="w-full rounded-xl border border-slate-700/80 bg-slate-950/60 px-4 py-2.5 font-mono text-sm text-slate-100 placeholder:text-slate-600 outline-none transition focus:border-emerald-500/60 focus:bg-slate-950/80 focus:ring-2 focus:ring-emerald-500/20 disabled:opacity-50"
              />
              <button
                onClick={sendChat}
                disabled={status !== "online"}
                className="rounded-xl bg-emerald-500 px-6 py-2.5 font-bold text-emerald-950 shadow-[0_0_20px_-5px_rgba(16,185,129,0.4)] transition hover:bg-emerald-400 disabled:opacity-50"
              >
                Send
              </button>
            </div>
          </>
        ) : (
          <BotScreen tab={tab} snap={snap} doAction={doAction} acting={acting} engine={bot.engine} beam={beam} />
        )}
      </div>
    </div>
  );
}

function BotScreen({
  tab,
  snap,
  doAction,
  acting,
  engine,
  beam,
}: {
  tab: string;
  snap: ViewSnapshot | null;
  doAction: (a: string, p?: any) => Promise<void>;
  acting: boolean;
  engine: string;
  beam: { looping: boolean; stage: string };
}) {
  const radar = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (tab !== "screen") return;
      const t = (e.target as HTMLElement)?.tagName;
      if (t === "INPUT" || t === "TEXTAREA") return;
      if (e.key >= "1" && e.key <= "9") {
        doAction("select", { slot: Number(e.key) - 1 });
      } else if (e.key.toLowerCase() === "r") {
        doAction("use");
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [doAction, tab]);

  useEffect(() => {
    const canvas = radar.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    const cx = W / 2;
    const cy = H / 2;
    const RANGE = 32;
    const scale = Math.min(W, H) / 2 / RANGE;

    ctx.clearRect(0, 0, W, H);
    const sky = snap?.isDay ? "#0e1525" : "#080c18";
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, W, H);

    // subtle grid glow
    ctx.strokeStyle = "rgba(99,102,241,0.12)";
    ctx.lineWidth = 1;
    for (let r = 8; r <= RANGE; r += 8) {
      ctx.beginPath();
      ctx.arc(cx, cy, r * scale, 0, Math.PI * 2);
      ctx.stroke();
    }
    // crosshair
    ctx.strokeStyle = "rgba(148,163,184,0.08)";
    ctx.beginPath();
    ctx.moveTo(cx, 0);
    ctx.lineTo(cx, H);
    ctx.moveTo(0, cy);
    ctx.lineTo(W, cy);
    ctx.stroke();

    ctx.fillStyle = "rgba(56,189,248,0.08)";
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    const fov = (70 * Math.PI) / 180;
    ctx.arc(cx, cy, RANGE * scale, -Math.PI / 2 - fov / 2, -Math.PI / 2 + fov / 2);
    ctx.closePath();
    ctx.fill();

    if (snap?.nearbyBlocks) {
      ctx.fillStyle = "rgba(100,116,139,0.45)";
      for (const b of snap.nearbyBlocks) {
        const px = cx + b.right * scale;
        const py = cy - b.forward * scale;
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      }
    }

    if (snap?.entities) {
      for (const e of snap.entities) {
        const px = cx + e.right * scale;
        const py = cy - e.forward * scale;
        if (px < -10 || px > W + 10 || py < -10 || py > H + 10) continue;
        let color = "#94a3b8";
        if (e.kind === "player") color = "#34d399";
        else if (e.kind === "mob") color = "#f87171";
        else if (e.kind === "object") color = "#fbbf24";
        ctx.fillStyle = color;
        ctx.shadowColor = color;
        ctx.shadowBlur = e.kind === "player" ? 8 : 0;
        ctx.beginPath();
        ctx.arc(px, py, e.kind === "player" ? 5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0;
        if (e.kind === "player") {
          ctx.fillStyle = "rgba(167,243,208,0.9)";
          ctx.font = "11px ui-monospace, monospace";
          ctx.fillText(e.name.slice(0, 12), px + 7, py + 3);
        }
      }
    }

    ctx.fillStyle = "#38bdf8";
    ctx.shadowColor = "#38bdf8";
    ctx.shadowBlur = 12;
    ctx.beginPath();
    ctx.moveTo(cx, cy - 8);
    ctx.lineTo(cx - 5, cy + 6);
    ctx.lineTo(cx + 5, cy + 6);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
  }, [snap]);

  if (!snap?.available) {
    return (
      <div className="grid h-full place-items-center px-6 py-20 text-center text-slate-500">
        <div className="relative">
          <div className="absolute inset-0 blur-2xl bg-indigo-500/10 rounded-full" />
          <div className="relative text-4xl">🛰️</div>
        </div>
        <p className="mt-3 max-w-sm text-sm">
          The bot must be online and spawned in the world to stream its view.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {snap.window ? (
        <div className="flex flex-1 flex-col items-center justify-center p-6 bg-[radial-gradient(ellipse_at_center,_rgba(99,102,241,0.08),_transparent_60%)]">
          <div className="w-full max-w-[560px] rounded-[20px] border border-slate-700/50 bg-slate-900/80 p-5 shadow-2xl backdrop-blur-xl">
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-violet-500 to-indigo-600 text-sm">📦</div>
                <div>
                  <h3 className="text-sm font-bold text-white">{snap.window.title || "Container"}</h3>
                  <p className="text-[11px] text-slate-500">{snap.window.slots.filter(Boolean).length} items</p>
                </div>
              </div>
              <button
                onClick={() => doAction("closeWindow")}
                className="rounded-lg bg-rose-500/10 px-3 py-1.5 text-xs font-semibold text-rose-400 ring-1 ring-rose-500/20 hover:bg-rose-500/20"
              >
                Close
              </button>
            </div>
            <div className="rounded-xl bg-slate-950/60 p-3 ring-1 ring-slate-800">
              <div className="grid grid-cols-9 gap-2">
                {snap.window.slots.map((it, idx) => (
                  <button
                    key={idx}
                    disabled={acting || !it}
                    onClick={() => doAction("clickWindow", { slot: it?.slot })}
                    className={`group relative grid aspect-square place-items-center rounded-xl border transition-all duration-200 ${
                      it
                        ? "border-slate-700/60 bg-gradient-to-br from-slate-800/80 to-slate-900/80 hover:border-violet-500/40 hover:from-slate-800 hover:to-slate-800 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)] hover:shadow-[0_0_15px_rgba(139,92,246,0.15)] hover:scale-[1.04] active:scale-[0.97]"
                        : "border-slate-800/30 bg-slate-900/20"
                    } disabled:opacity-50`}
                  >
                    {it?.name ? (
                      <>
                        <ItemIcon name={it.name} size={28} />
                        {it.count > 1 && (
                          <span className="absolute -bottom-1 -right-1 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white ring-1 ring-slate-700 shadow">
                            {it.count}
                          </span>
                        )}
                        <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs shadow-2xl group-hover:block">
                          <span className="font-medium text-violet-300">{it.displayName}</span>
                          <span className="ml-2 font-mono text-slate-500">x{it.count}</span>
                        </div>
                      </>
                    ) : (
                      <span className="text-slate-700/50">·</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid gap-6 p-6 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col items-center gap-4">
            {engine === "nmp" ? (
              <div className="relative overflow-hidden rounded-[20px] border border-slate-800 bg-slate-900/60 p-[1px]">
                <div className="flex h-[300px] w-[300px] flex-col items-center justify-center rounded-[19px] bg-gradient-to-br from-slate-900 to-slate-950 text-center">
                  <div className="grid h-12 w-12 place-items-center rounded-xl bg-sky-500/10 text-2xl ring-1 ring-sky-500/20">📡</div>
                  <span className="mt-4 font-semibold text-slate-200">Raw NMP Mode</span>
                  <span className="mt-2 max-w-[220px] text-xs leading-relaxed text-slate-500">Radar and chunk processing disabled for stealth bypass. Pure protocol.</span>
                </div>
              </div>
            ) : (
              <div className="relative rounded-[20px] border border-slate-800 bg-slate-900/60 p-[1px] shadow-xl">
                <div className="rounded-[19px] bg-slate-950 p-2">
                  <canvas
                    ref={radar}
                    width={300}
                    height={300}
                    className="rounded-[14px] bg-slate-950"
                  />
                  <div className="pointer-events-none absolute inset-2 rounded-[14px] ring-1 ring-white/5" />
                </div>
                <div className="absolute -bottom-1 -right-1 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-medium text-emerald-300 ring-1 ring-emerald-500/20">LIVE</div>
              </div>
            )}
            
            <div className="grid grid-cols-3 gap-2">
              <div />
              <KeyCap label="W" k="W" onClick={() => doAction("move", { dir: "forward" })} disabled={acting} />
              <div />
              <KeyCap label="A" k="A" onClick={() => doAction("move", { dir: "left" })} disabled={acting} />
              <KeyCap label="S" k="S" onClick={() => doAction("move", { dir: "back" })} disabled={acting} />
              <KeyCap label="D" k="D" onClick={() => doAction("move", { dir: "right" })} disabled={acting} />
            </div>
          </div>

          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <Stat label="Health"><span className="flex items-center gap-1.5"><span className="text-rose-400">❤️</span> {snap.health} / 20</span></Stat>
              <Stat label="Food"><span className="flex items-center gap-1.5"><span className="text-amber-400">🍗</span> {snap.food} / 20</span></Stat>
              <Stat label="Location">
                <span className="font-mono text-xs text-slate-300">{snap.position?.x ?? 0}, {snap.position?.y ?? 0}, {snap.position?.z ?? 0}</span>
              </Stat>
              <Stat label="Looking at">
                <span className="truncate text-slate-300">{snap.lookingAt ? snap.lookingAt.name : "air"}</span>
              </Stat>
            </div>
            
            <div>
              <h3 className="mb-2.5 flex items-center gap-2 text-[11px] font-bold uppercase tracking-widest text-slate-400">
                <span className="h-1 w-1 rounded-full bg-emerald-400 animate-pulse" />
                Nearby Players & Mobs
              </h3>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-xl border border-slate-800 bg-slate-900/40 p-2.5 backdrop-blur">
                {engine === "nmp" ? (
                   <p className="px-2 py-2 text-xs text-slate-500">Entity tracking disabled in NMP mode.</p>
                ) : snap.entities && snap.entities.length > 0 ? (
                  snap.entities.map((e, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-lg px-2.5 py-2 transition hover:bg-slate-800/60">
                      <span className="flex items-center gap-2.5 truncate text-slate-300">
                        <span
                          className="h-2 w-2 shrink-0 rounded-full shadow-[0_0_6px]"
                          style={{
                            background:
                              e.kind === "player" ? "#34d399" : e.kind === "mob" ? "#f87171" : "#fbbf24",
                            boxShadow: `0 0 6px ${e.kind === "player" ? "#34d399" : e.kind === "mob" ? "#f87171" : "#fbbf24"}`,
                          }}
                        />
                        <span className="truncate text-xs font-medium">{e.name}</span>
                      </span>
                      <span className="shrink-0 rounded-full bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-400">
                        {e.distance}m
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="grid place-items-center py-8 text-center">
                    <div className="text-lg opacity-30">◍</div>
                    <p className="mt-1 text-xs text-slate-600">No entities nearby</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="mt-auto border-t border-white/5 bg-gradient-to-b from-black/40 to-black/60 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2.5">
          {(snap.hotbar ?? []).map((it) => (
            <button
              key={it.slot}
              onClick={() => doAction("select", { slot: it.slot })}
              disabled={acting}
              className={`group relative grid h-[56px] w-[56px] place-items-center rounded-[12px] border transition-all duration-200 ${
                it.selected
                  ? "border-emerald-400/60 bg-gradient-to-br from-emerald-500/20 to-emerald-600/10 shadow-[0_0_20px_rgba(16,185,129,0.25),inset_0_1px_0_rgba(255,255,255,0.1)] scale-[1.05]"
                  : "border-slate-700/50 bg-gradient-to-br from-slate-800/60 to-slate-900/60 hover:border-slate-600 hover:from-slate-800 hover:to-slate-800/80 hover:scale-[1.03] active:scale-[0.97]"
              } disabled:opacity-60`}
            >
              <span className={`absolute left-1.5 top-1 text-[10px] font-bold leading-none ${it.selected ? "text-emerald-300" : "text-slate-500"}`}>
                {it.slot + 1}
              </span>
              {it.name ? (
                <>
                  <ItemIcon name={it.name} size={26} />
                  {it.count > 1 && (
                    <span className="absolute -bottom-1 -right-1 rounded-full bg-slate-900 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white ring-1 ring-slate-700 shadow-md">
                      {it.count}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-slate-700">·</span>
              )}
              {it.selected && <span className="absolute inset-0 rounded-[11px] bg-emerald-400/10 animate-pulse" />}
              {it.name && (
                <div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-3 hidden -translate-x-1/2 whitespace-nowrap rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs shadow-2xl group-hover:block">
                  <span className="font-semibold text-white">{it.displayName}</span>
                  <span className="ml-2 font-mono text-slate-500">x{it.count}</span>
                </div>
              )}
            </button>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={() => doAction("use")}
              disabled={acting || !snap.heldItem}
              className="rounded-xl bg-gradient-to-b from-emerald-400 to-emerald-600 px-5 py-3 text-sm font-bold text-emerald-950 shadow-[0_0_20px_rgba(16,185,129,0.3)] transition hover:from-emerald-300 hover:to-emerald-500 active:scale-[0.97] disabled:opacity-40"
            >
              Right-click / Use
            </button>
            <button
              onClick={() => doAction("drop")}
              disabled={acting || !snap.heldItem}
              className="rounded-xl border border-slate-700 bg-slate-800 px-4 py-3 text-sm font-medium text-slate-300 transition hover:bg-slate-700 active:scale-[0.97] disabled:opacity-40"
            >
              Drop
            </button>
            <div className="mx-1 h-8 w-px bg-slate-800" />
            {beam?.looping ? (
              <button
                onClick={() => doAction("beam_stop")}
                disabled={acting}
                className="rounded-xl bg-gradient-to-b from-rose-400 to-rose-600 px-5 py-3 text-sm font-bold text-rose-950 shadow-[0_0_20px_rgba(244,63,94,0.3)] transition hover:from-rose-300 hover:to-rose-500 active:scale-[0.97] disabled:opacity-40"
              >
                ⏹ Stop Beam
              </button>
            ) : (
              <button
                onClick={() => doAction("beam_start")}
                disabled={acting || !snap.available}
                className="rounded-xl bg-gradient-to-b from-fuchsia-400 to-fuchsia-600 px-5 py-3 text-sm font-bold text-fuchsia-950 shadow-[0_0_20px_rgba(217,70,239,0.3)] transition hover:from-fuchsia-300 hover:to-fuchsia-500 active:scale-[0.97] disabled:opacity-40"
              >
                📡 Start Beam
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function KeyCap({ label, k, onClick, disabled }: { label: string; k: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className="group relative grid h-11 w-11 place-items-center rounded-xl border border-slate-700/80 bg-gradient-to-b from-slate-800 to-slate-900 text-sm font-bold text-slate-300 shadow-[0_2px_0_rgba(0,0,0,0.3),inset_0_1px_0_rgba(255,255,255,0.08)] transition-all hover:from-slate-700 hover:to-slate-800 hover:text-white hover:border-slate-600 active:translate-y-[2px] active:shadow-none disabled:opacity-40"
    >
      {k}
      <span className="absolute -bottom-5 text-[9px] font-medium uppercase tracking-widest text-slate-600 group-hover:text-slate-400">{label}</span>
    </button>
  );
}

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-3 backdrop-blur">
      <div className="text-[10px] font-bold uppercase tracking-widest text-slate-500">
        {label}
      </div>
      <div className="mt-1.5 truncate font-semibold text-slate-200">
        {children}
      </div>
    </div>
  );
}

const ITEM_IMG_VERSION = "1.21.4";
function itemImageUrl(name: string, dir: "item" | "block"): string {
  let cleanName = name.replace("spear", "trident");
  if (cleanName === "glass_pane") cleanName = "white_stained_glass_pane";
  if (cleanName.endsWith("_pane") && dir === "block") {
    cleanName = cleanName.replace("_pane", "");
  }
  return `https://assets.mcasset.cloud/${ITEM_IMG_VERSION}/assets/minecraft/textures/${dir}/${cleanName}.png`;
}

function ItemIcon({ name, size = 32 }: { name: string; size?: number }) {
  const [stage, setStage] = useState<0 | 1 | 2 | 3>(0);
  
  const getUrl = () => {
    if (stage === 0) return itemImageUrl(name, "item");
    if (stage === 1) return itemImageUrl(name, "block");
    if (name.includes("sword") || name.includes("blade") || name.includes("spear")) return itemImageUrl("iron_sword", "item");
    if (name.includes("potion")) return itemImageUrl("potion", "item");
    if (name.includes("helmet")) return itemImageUrl("iron_helmet", "item");
    if (name.includes("chestplate")) return itemImageUrl("iron_chestplate", "item");
    if (name.includes("leggings")) return itemImageUrl("iron_leggings", "item");
    if (name.includes("boots")) return itemImageUrl("iron_boots", "item");
    return "";
  };

  if (stage === 3) {
    const letter = name.replace(/[^a-zA-Z]/g, "").charAt(0).toUpperCase() || "?";
    return (
      <div className="grid place-items-center rounded-lg bg-slate-800 text-xs font-bold text-slate-300" style={{ width: size, height: size }}>
        {letter}
      </div>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={getUrl()}
      alt={name}
      width={size}
      height={size}
      onError={() => setStage((s) => (s + 1) as 0 | 1 | 2 | 3)}
      style={{ imageRendering: "pixelated" }}
      className="object-contain drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]"
    />
  );
}

function logColor(level: LogEntry["level"]) {
  switch (level) {
    case "error":
      return "text-rose-400";
    case "system":
      return "text-sky-400";
    case "chat":
      return "text-slate-200";
    default:
      return "text-slate-400";
  }
}

function whisperKind(line: string): "from" | "to" | null {
  const l = line.toLowerCase();
  if (/<you\s*→/.test(line)) return null;
  if (/\(from\b/.test(l) || /^\s*from\s+\w+/.test(l) || /whispers to you/.test(l))
    return "from";
  if (/\(to\b/.test(l) || /\byou whisper to\b/.test(l)) return "to";
  return null;
}
