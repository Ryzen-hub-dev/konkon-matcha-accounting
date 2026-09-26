import type { Metadata } from "next";
import { Inter } from "next/font/google";
import styles from "./index.module.css";
import { CinematicIndexHero } from "@/components/cinematic-index-hero";

const inter = Inter({ subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Step Through. Work Smarter.",
  description: "An interactive KONA optical experience for the Kōn-Kōn operational workspace.",
  authors: [{ name: "Ryzen Hub Dev", url: "https://github.com/Ryzen-hub-dev" }],
  creator: "Ryzen Hub Dev",
  robots: { index: true, follow: true },
};

export default function IndexPage() {
  return (
    <main className={`${styles.home} ${inter.className}`}>
      <a className={styles.skip} href="#hero-content">Skip to content</a>
      <CinematicIndexHero />
    </main>
  );
}
