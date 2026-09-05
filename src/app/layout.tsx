import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "MC Bot Manager",
  description:
    "Spin up Minecraft bots, watch them join servers, and control their consoles.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-[#070b14] text-slate-100 antialiased">
        <div className="app-bg" aria-hidden />
        {children}
      </body>
    </html>
  );
}
