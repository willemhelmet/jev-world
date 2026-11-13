import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Jev World",
  description:
    "A decision model (Jev) plays levels inside a world model (LingBot World 2).",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // The app is dark-only; setting the class here (rather than from a
  // client effect) lets server-rendered pages like <SetupRequired />
  // pick up the dark theme tokens too.
  return (
    <html lang="en" className="dark">
      <body className="antialiased font-sans">{children}</body>
    </html>
  );
}
