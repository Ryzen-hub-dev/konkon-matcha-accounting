"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Globe2, ShieldCheck, Workflow } from "lucide-react";
import styles from "@/app/index.module.css";

export function CinematicIndexHero() {
  const section = useRef<HTMLElement>(null);
  const visual = useRef<HTMLImageElement>(null);

  useEffect(() => {
    const root = section.current;
    const image = visual.current;
    if (!root || !image || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      const distance = Math.max(1, rect.height - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -rect.top / distance));
      root.dataset.stage = progress < 0.3 ? "0" : progress < 0.67 ? "1" : "2";
      root.style.setProperty("--cinema-progress", String(progress));
      image.style.transform = `scale(${1.02 + progress * 0.17}) translate3d(${-progress * 5.5}%, ${progress * 2.5}%, 0)`;
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    addEventListener("scroll", schedule, { passive: true });
    addEventListener("resize", schedule, { passive: true });
    return () => {
      removeEventListener("scroll", schedule);
      removeEventListener("resize", schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return <section ref={section} className={styles.cinema} id="content" data-stage="0">
    <div className={styles.cinemaSticky}>
      <picture className={styles.cinemaVisual}>
        <source media="(max-width: 700px)" srcSet="/media/konkon-ledger-hero-mobile.webp" />
        <source media="(min-width: 2000px)" srcSet="/media/konkon-ledger-hero-4k.webp" />
        <img ref={visual} src="/media/konkon-ledger-hero-1920.webp" alt="A ceramic matcha bowl with tea, receipts, inventory and point-of-sale tools moving through one connected operation" fetchPriority="high" decoding="async" />
      </picture>
      <div className={styles.cinemaShade} />
      <div className={styles.cinemaCopy}>
        <p className={styles.eyebrow}>KŌN-KŌN MATCHĀ · CONNECTED LEDGER</p>
        <h1>Every movement.<br /><em>One clear story.</em></h1>
        <p className={`${styles.cinemaLine} ${styles.storyZero}`}>Matcha craft, customer orders and accounting move as one continuous operation.</p>
        <p className={`${styles.cinemaLine} ${styles.storyOne}`}>From shelf and counter to invoice, stock movement and journal—without rebuilding the evidence.</p>
        <p className={`${styles.cinemaLine} ${styles.storyTwo}`}>Built for teams that want calm operations, exact books and room to grow across borders.</p>
        <div className={styles.heroActions}>
          <Link href="/shop">Explore the store <ArrowRight /></Link>
          <Link href="/login">Open workspace</Link>
        </div>
        <div className={styles.trustRow}>
          <span><ShieldCheck />Server-enforced roles</span>
          <span><Globe2 />Country-configurable</span>
          <span><Workflow />Auditable workflows</span>
        </div>
      </div>
      <div className={styles.scrollCue}><span>Scroll to follow the flow</span><ArrowDown /></div>
      <div className={styles.cinemaProgress}><i /></div>
    </div>
  </section>;
}
