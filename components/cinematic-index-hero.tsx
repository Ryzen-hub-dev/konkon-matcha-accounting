"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Globe2, ShieldCheck, Workflow } from "lucide-react";
import styles from "@/app/index.module.css";

export function CinematicIndexHero() {
  const section = useRef<HTMLElement>(null);
  const visual = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const root = section.current;
    const video = visual.current;
    if (!root || !video) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      video.pause();
      return;
    }
    let frame = 0;
    const update = () => {
      frame = 0;
      const rect = root.getBoundingClientRect();
      const distance = Math.max(1, rect.height - window.innerHeight);
      const progress = Math.min(1, Math.max(0, -rect.top / distance));
      root.dataset.stage = progress < 0.3 ? "0" : progress < 0.67 ? "1" : "2";
      root.style.setProperty("--cinema-progress", String(progress));
      video.style.transform = `scale(${1.02 + progress * 0.17}) translate3d(${-progress * 5.5}%, ${progress * 2.5}%, 0)`;
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
      <div className={styles.cinemaVisual}>
        <video ref={visual} autoPlay muted loop playsInline preload="auto" disablePictureInPicture aria-hidden="true">
          <source media="(max-width: 700px)" src="/media/konkon-ledger-motion-mobile.mp4" type="video/mp4" />
          <source media="(min-width: 2000px)" src="/media/konkon-ledger-motion-4k.mp4" type="video/mp4" />
          <source src="/media/konkon-ledger-motion-1920.mp4" type="video/mp4" />
        </video>
      </div>
      <div className={styles.cinemaShade} />
      <div className={styles.cinemaCopy}>
        <p className={styles.eyebrow}>KŌN-KŌN MATCHĀ · CONNECTED LEDGER</p>
        <h1>From counter.<br /><em>To closing.</em></h1>
        <p className={`${styles.cinemaLine} ${styles.storyZero}`}>Orders, stock, receipts and accounts stay connected from the first scan.</p>
        <p className={`${styles.cinemaLine} ${styles.storyOne}`}>One transaction carries its evidence into inventory, invoices and the journal.</p>
        <p className={`${styles.cinemaLine} ${styles.storyTwo}`}>Country settings change the workflow—not the integrity of your history.</p>
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
