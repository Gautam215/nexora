import type { Metadata } from "next";
import { IBM_Plex_Mono, Inter } from "next/font/google";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { LiquidWaveBackground } from "./components/liquid-wave-background";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  weight: ["400", "500", "600", "700", "800"],
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  variable: "--font-plex-mono",
  weight: ["400", "500"],
});

export const metadata: Metadata = {
  title: "Nexora",
  description: "A secure workspace for teams and their projects.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  await connection();

  return (
    <html lang="en">
      <body className={`${inter.variable} ${plexMono.variable}`}>
        <LiquidWaveBackground />
        <div className="nexora-page-content">{children}</div>
      </body>
    </html>
  );
}
