"use client";

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

export default function SettingsPanel({
  me,
  onChange,
}: {
  me: Me;
  onChange: () => void;
}) {
  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    onChange();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-slate-600 to-slate-800 text-lg ring-1 ring-slate-600/50">
          ⚙
        </div>
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-slate-400">
            Your account and app preferences.
          </p>
        </div>
      </div>

      {/* Profile card */}
      <section className="glass rounded-2xl p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Account
        </h3>
        <div className="mt-4 flex items-center gap-4">
          {me.avatar ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={me.avatar}
              alt=""
              className="h-16 w-16 rounded-2xl ring-2 ring-slate-700"
            />
          ) : (
            <div className="grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-700 text-xl font-bold">
              {me.username.slice(0, 2).toUpperCase()}
            </div>
          )}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-semibold">{me.username}</span>
              {me.role === "admin" && (
                <span className="rounded-md bg-fuchsia-500/15 px-2 py-0.5 text-xs font-medium text-fuchsia-300 ring-1 ring-fuchsia-500/30">
                  admin
                </span>
              )}
            </div>
            <p className="mt-0.5 text-sm text-slate-400">
              {me.isGuest ? "Guest account" : "Signed in with Discord"}
            </p>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
          <InfoTile label="Role" value={me.role} />
          <InfoTile label="Bot slots" value={String(me.botSlots)} />
          <InfoTile
            label="Bots used"
            value={`${me.botCount}/${me.botSlots}`}
          />
        </div>
      </section>

      {/* Beam AI info */}
      <section className="glass rounded-2xl p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Beam &amp; AI
        </h3>
        <p className="mt-3 text-sm leading-relaxed text-slate-400">
          The Beam feature recruits the nearest player via private messages,
          handles their replies with AI (Pollinations), and loops until you stop
          it. Set each bot&apos;s YouTube channel name in the bot&apos;s{" "}
          <span className="text-slate-200">Manage</span> panel.
        </p>
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <FeatureRow
            icon="🤖"
            title="Humanized movement"
            desc="Subtle idle head movement + timing variance"
          />
          <FeatureRow
            icon="💬"
            title="AI conversations"
            desc="Polite, natural, in-character replies"
          />
          <FeatureRow
            icon="🎯"
            title="Smart targeting"
            desc="Nearest valid player, auto-restart on deny/death"
          />
          <FeatureRow
            icon="👁"
            title="Live bot view"
            desc="Radar, hotbar, and item control"
          />
        </div>
      </section>

      {/* Danger / session */}
      <section className="glass rounded-2xl p-5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Session
        </h3>
        <div className="mt-3 flex items-center justify-between gap-4">
          <p className="text-sm text-slate-400">
            Sign out of this device. You can sign back in anytime.
          </p>
          <button
            onClick={logout}
            className="shrink-0 rounded-xl border border-slate-700 px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-rose-500/40 hover:text-rose-300"
          >
            Logout
          </button>
        </div>
      </section>

      <div className="flex items-center justify-center gap-2 pt-2 text-xs text-slate-600">
        <Logo size={18} /> MC Bot Manager
      </div>
    </div>
  );
}

function InfoTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-0.5 font-semibold capitalize text-slate-200">
        {value}
      </div>
    </div>
  );
}

function FeatureRow({
  icon,
  title,
  desc,
}: {
  icon: string;
  title: string;
  desc: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-950/40 px-4 py-3">
      <span className="text-lg">{icon}</span>
      <div>
        <div className="text-sm font-medium text-slate-200">{title}</div>
        <div className="text-xs text-slate-500">{desc}</div>
      </div>
    </div>
  );
}
