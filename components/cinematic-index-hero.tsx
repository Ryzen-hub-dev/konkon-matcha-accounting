"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { ArrowDown, ArrowRight, Globe2, ShieldCheck, Workflow } from "lucide-react";
import styles from "@/app/index.module.css";
import { cinematicScrollState } from "@/lib/cinematic-scroll";

export function CinematicIndexHero() {
  const section = useRef<HTMLElement>(null);
  const visual = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const root = section.current;
    const video = visual.current;
    if (!root || !video) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      video.pause();
      const resetFrame = () => { video.currentTime = 0; };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) resetFrame();
      else video.addEventListener("loadedmetadata", resetFrame, { once: true });
      return;
    }

    let frame = 0;
    let targetProgress = 0;
    let targetX = 0;
    let targetY = 0;
    let currentX = 0;
    let currentY = 0;
    let visible = true;
    const requestFrame = typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (callback: FrameRequestCallback) => window.setTimeout(() => callback(window.performance.now()), 16);
    const cancelFrame = typeof window.cancelAnimationFrame === "function"
      ? window.cancelAnimationFrame.bind(window)
      : window.clearTimeout.bind(window);

    const render = () => {
      frame = 0;
      const state = cinematicScrollState(targetProgress, 1);
      currentX += (targetX - currentX) * 0.12;
      currentY += (targetY - currentY) * 0.12;

      root.dataset.stage = state.stage;
      root.style.setProperty("--cinema-progress", String(state.progress));
      root.style.setProperty("--cinema-x", `${currentX.toFixed(3)}deg`);
      root.style.setProperty("--cinema-y", `${currentY.toFixed(3)}deg`);

      if (
        Math.abs(targetX - currentX) > 0.008 ||
        Math.abs(targetY - currentY) > 0.008
      ) frame = requestFrame(render);
    };

    const schedule = () => { if (!frame) frame = requestFrame(render); };
    const measure = () => {
      const rect = root.getBoundingClientRect();
      targetProgress = -rect.top / Math.max(1, rect.height - window.innerHeight);
      schedule();
    };
    const point = (event: PointerEvent) => {
      if (event.pointerType === "touch") return;
      targetX = (event.clientX / window.innerWidth - 0.5) * 3.2;
      targetY = (event.clientY / window.innerHeight - 0.5) * -2.4;
      schedule();
    };
    const resetPoint = () => { targetX = 0; targetY = 0; schedule(); };
    const syncPlayback = () => {
      if (!visible || document.hidden) video.pause();
      else void video.play().catch(() => undefined);
    };
    const observer = typeof window.IntersectionObserver === "function"
      ? new IntersectionObserver(([entry]) => {
          visible = Boolean(entry?.isIntersecting);
          syncPlayback();
        }, { threshold: 0.05 })
      : null;

    measure();
    video.playbackRate = 1;
    observer?.observe(root);
    syncPlayback();
    document.addEventListener("visibilitychange", syncPlayback);
    addEventListener("scroll", measure, { passive: true });
    addEventListener("resize", measure, { passive: true });
    root.addEventListener("pointermove", point, { passive: true });
    root.addEventListener("pointerleave", resetPoint);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", syncPlayback);
      removeEventListener("scroll", measure);
      removeEventListener("resize", measure);
      root.removeEventListener("pointermove", point);
      root.removeEventListener("pointerleave", resetPoint);
      if (frame) cancelFrame(frame);
    };
  }, []);

  return <section ref={section} className={styles.cinema} id="content" data-stage="0">
    <div className={styles.cinemaSticky}>
      <div className={styles.cinemaVisual}>
        <div className={styles.cinemaDepth} aria-hidden="true"><i /><i /><i /><span /><span /></div>
        <div className={styles.cinemaStage}>
          <video ref={visual} autoPlay muted loop playsInline preload="auto" poster="/media/mascot/kona-base-v1.png" disablePictureInPicture tabIndex={-1} aria-hidden="true">
            <source src="/media/mascot/kona-hero-source.mp4" type="video/mp4" />
            Your browser does not support background video.
          </video>
          <div className={styles.konaSticker} aria-hidden="true">
            <strong>KONA</strong><span>MATCHĀ<br />HOUSE GUIDE</span>
          </div>
        </div>
      </div>
      <div className={styles.cinemaShade} />
      <div className={styles.cinemaCopy}>
        <p className={styles.eyebrow}>KONA · OPERATIONS GUIDE</p>
        <h1>Meet KONA.<br /><em>Counter to close.</em></h1>
        <p className={`${styles.cinemaLine} ${styles.storyZero}`}><strong>01 / Counter</strong>Every sale connects its member, coupon, payment and receipt.</p>
        <p className={`${styles.cinemaLine} ${styles.storyOne}`}><strong>02 / Stock</strong>Products, batches and locations move from the same verified event.</p>
        <p className={`${styles.cinemaLine} ${styles.storyTwo}`}><strong>03 / Ledger</strong>Posted movements finish as balanced, traceable accounting evidence.</p>
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
