import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Kōn-Kōn Ledger", template: "%s · Kōn-Kōn Ledger" },
  description: "Connected commerce, accounting, inventory, members and point of sale for Kōn-Kōn Matchā.",
  applicationName: "Kōn-Kōn Ledger",
  authors: [{ name: "Ryzen Hub Dev", url: "https://github.com/Ryzen-hub-dev" }],
  creator: "Ryzen Hub Dev",
  icons: { icon: "/icon.svg", shortcut: "/icon.svg" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0d1631" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
