import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "./globals.css";

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
      <body>{children}</body>
    </html>
  );
}
