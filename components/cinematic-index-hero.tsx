"use client";

import Link from "next/link";
import {
  ArrowRight,
  Check,
  Headphones,
  Menu,
  Pause,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import styles from "@/app/index.module.css";
import { KonaRadio } from "@/components/kona-radio";
import {
  frameDamping,
  incrementalScrubTarget,
  normalizePointer,
} from "@/lib/interactive-video";

const KONA_VIDEO = "/media/mascot/kona-mainframe-scrub-v5.mp4";
const KONA_POSTER = "/media/mascot/kona-mainframe-poster.jpg";
const INTRO_COPY =
  "KONA keeps every hand-off connected — from the first order and stock movement to the final receipt and close.";

type IntroStage = "loading" | "docking" | "ready";

function BrandMark() {
  return (
    <svg viewBox="0 0 56 56" role="img" aria-label="Kōn-Kōn">
      <path d="M28 2 50 15v26L28 54 6 41V15Z" fill="currentColor" />
      <path d="M18 16v24m0-11 19-13M18 29l19 11" fill="none" stroke="#f8f3e8" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="39" cy="16" r="2.7" fill="#ef6b3f" />
    </svg>
  );
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button, input, label"));
}

export function CinematicIndexHero() {
  const rootRef = useRef<HTMLElement>(null);
  const poseRef = useRef<HTMLVideoElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5, clientX: 0, clientY: 0 });
  const previewingRef = useRef(false);
  const lastPointerXRef = useRef<number | null>(null);
  const targetTimeRef = useRef(0);
  const smoothTimeRef = useRef(0);
  const durationRef = useRef(0);
  const [stage, setStage] = useState<IntroStage>("loading");
  const [progress, setProgress] = useState(0);
  const [typedCopy, setTypedCopy] = useState("");
  const [previewing, setPreviewing] = useState(false);
  const [storyOpen, setStoryOpen] = useState(false);
  const [radioExpanded, setRadioExpanded] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion || document.visibilityState !== "visible") {
      setProgress(100);
      setStage("ready");
      return;
    }

    let frame = 0;
    let dockingTimer = 0;
    let fallbackTimer = 0;
    let finished = false;
    const startedAt = performance.now();
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      setProgress(100);
      setStage("docking");
      dockingTimer = window.setTimeout(() => setStage("ready"), 1100);
    };
    const tick = (now: number) => {
      const ratio = Math.min(1, (now - startedAt) / 2600);
      setProgress(Math.round(ratio * 100));
      if (ratio < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    const finishWhenHidden = () => {
      if (document.visibilityState !== "visible") finish();
    };
    document.addEventListener("visibilitychange", finishWhenHidden);
    frame = requestAnimationFrame(tick);
    fallbackTimer = window.setTimeout(finish, 2850);
    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      clearTimeout(dockingTimer);
      clearTimeout(fallbackTimer);
      document.removeEventListener("visibilitychange", finishWhenHidden);
    };
  }, []);

  useEffect(() => {
    if (stage === "loading") return;
    setTypedCopy("");
    let index = 0;
    let typeTimer = 0;
    const startTimer = window.setTimeout(() => {
      typeTimer = window.setInterval(() => {
        index += 1;
        setTypedCopy(INTRO_COPY.slice(0, index));
        if (index >= INTRO_COPY.length) clearInterval(typeTimer);
      }, 22);
    }, 380);
    return () => {
      clearTimeout(startTimer);
      clearInterval(typeTimer);
    };
  }, [stage]);

  useEffect(() => {
    const root = rootRef.current;
    const video = poseRef.current;
    if (!root || !video) return;

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let animationFrame = 0;
    let lastFrameAt = performance.now();
    let lastSeekAt = 0;
    let seekBusy = false;
    let pendingSeek: number | null = null;
    let activeTouchPointer: number | null = null;
    let cursorX = innerWidth * 0.5;
    let cursorY = innerHeight * 0.5;
    let parallaxX = 0;
    let parallaxY = 0;

    const flushSeek = () => {
      if (seekBusy || pendingSeek === null || previewingRef.current) return;
      const next = pendingSeek;
      pendingSeek = null;
      if (Math.abs(video.currentTime - next) < 1 / 120) return;
      seekBusy = true;
      try {
        video.currentTime = next;
      } catch {
        seekBusy = false;
      }
    };
    const handleSeeked = () => {
      seekBusy = false;
      if (pendingSeek !== null) requestAnimationFrame(flushSeek);
    };
    const initializeVideo = () => {
      durationRef.current = Number.isFinite(video.duration) ? video.duration : 0;
      const middle = durationRef.current * 0.5;
      targetTimeRef.current = middle;
      smoothTimeRef.current = middle;
      video.currentTime = middle;
      video.pause();
    };
    const move = (event: PointerEvent) => {
      const isTouchScrub = activeTouchPointer === event.pointerId;
      if (!finePointer.matches && !isTouchScrub) return;

      const normalized = normalizePointer(event.clientX, event.clientY, innerWidth, innerHeight);
      pointerRef.current = { ...normalized, clientX: event.clientX, clientY: event.clientY };
      if (finePointer.matches) root.dataset.cursor = "visible";

      const previousX = lastPointerXRef.current;
      lastPointerXRef.current = event.clientX;
      if (previousX !== null && !previewingRef.current && durationRef.current > 0) {
        targetTimeRef.current = incrementalScrubTarget(
          targetTimeRef.current,
          event.clientX - previousX,
          innerWidth,
          durationRef.current,
          finePointer.matches ? 0.82 : 1.05,
        );
      }
    };
    const startTouchScrub = (event: PointerEvent) => {
      if (finePointer.matches || isInteractiveTarget(event.target)) return;
      activeTouchPointer = event.pointerId;
      lastPointerXRef.current = event.clientX;
      root.setPointerCapture?.(event.pointerId);
    };
    const endTouchScrub = (event: PointerEvent) => {
      if (activeTouchPointer !== event.pointerId) return;
      activeTouchPointer = null;
      lastPointerXRef.current = null;
      if (root.hasPointerCapture?.(event.pointerId)) root.releasePointerCapture(event.pointerId);
    };
    const resetMouse = () => {
      if (!finePointer.matches) return;
      lastPointerXRef.current = null;
      root.dataset.cursor = "hidden";
    };
    const render = (now: number) => {
      const deltaMs = Math.min(64, now - lastFrameAt);
      lastFrameAt = now;
      const pointer = pointerRef.current;

      cursorX = frameDamping(cursorX, pointer.clientX || innerWidth * 0.5, deltaMs, 28);
      cursorY = frameDamping(cursorY, pointer.clientY || innerHeight * 0.5, deltaMs, 28);
      root.style.setProperty("--cursor-x", `${cursorX.toFixed(2)}px`);
      root.style.setProperty("--cursor-y", `${cursorY.toFixed(2)}px`);

      if (!previewingRef.current && durationRef.current > 0) {
        smoothTimeRef.current = frameDamping(
          smoothTimeRef.current,
          targetTimeRef.current,
          deltaMs,
          reducedMotion ? 24 : 15,
        );
        pendingSeek = smoothTimeRef.current;
        if (!seekBusy && now - lastSeekAt >= 16) {
          lastSeekAt = now;
          flushSeek();
        }
      }

      const targetParallaxX = reducedMotion ? 0 : (pointer.x - 0.5) * -9;
      const targetParallaxY = reducedMotion ? 0 : (pointer.y - 0.5) * -6;
      parallaxX = frameDamping(parallaxX, targetParallaxX, deltaMs, 9);
      parallaxY = frameDamping(parallaxY, targetParallaxY, deltaMs, 9);
      root.style.setProperty("--parallax-x", `${parallaxX.toFixed(2)}px`);
      root.style.setProperty("--parallax-y", `${parallaxY.toFixed(2)}px`);
      root.style.setProperty("--cursor-tilt", `${((pointer.x - 0.5) * 24 - 8).toFixed(2)}deg`);
      animationFrame = requestAnimationFrame(render);
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) initializeVideo();
    else video.addEventListener("loadedmetadata", initializeVideo, { once: true });
    video.addEventListener("seeked", handleSeeked);
    window.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerdown", startTouchScrub);
    root.addEventListener("pointerup", endTouchScrub);
    root.addEventListener("pointercancel", endTouchScrub);
    window.addEventListener("blur", resetMouse);
    document.documentElement.addEventListener("mouseleave", resetMouse);
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      video.removeEventListener("loadedmetadata", initializeVideo);
      video.removeEventListener("seeked", handleSeeked);
      window.removeEventListener("pointermove", move);
      root.removeEventListener("pointerdown", startTouchScrub);
      root.removeEventListener("pointerup", endTouchScrub);
      root.removeEventListener("pointercancel", endTouchScrub);
      window.removeEventListener("blur", resetMouse);
      document.documentElement.removeEventListener("mouseleave", resetMouse);
    };
  }, []);

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setStoryOpen(false);
      setMenuOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, []);

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 780px)");
    const collapseForCompactScreen = () => {
      if (compact.matches) setRadioExpanded(false);
    };
    collapseForCompactScreen();
    compact.addEventListener("change", collapseForCompactScreen);
    return () => compact.removeEventListener("change", collapseForCompactScreen);
  }, []);

  const updatePreview = (value: boolean) => {
    const video = poseRef.current;
    previewingRef.current = value;
    setPreviewing(value);
    if (!video) return;
    if (value) {
      video.loop = true;
      video.playbackRate = 0.7;
      void video.play().catch(() => {
        previewingRef.current = false;
        setPreviewing(false);
      });
    } else {
      video.pause();
      targetTimeRef.current = video.currentTime;
      smoothTimeRef.current = video.currentTime;
      lastPointerXRef.current = null;
    }
  };

  const openStory = () => {
    setStoryOpen(true);
    setMenuOpen(false);
  };
  const openRadio = () => {
    setRadioExpanded(true);
    setMenuOpen(false);
  };

  return (
    <section ref={rootRef} className={styles.experience} data-stage={stage} id="content">
      <div className={styles.preloader} aria-hidden={stage === "ready"}>
        <div className={styles.preloaderAura} />
        <p>KONA IS GETTING THE DAY READY</p>
        <div className={styles.preloaderCounter} aria-live="polite">
          <span>{progress.toString().padStart(2, "0")}</span><small>%</small>
        </div>
      </div>

      <Link href="/" className={styles.dockingLogo} aria-label="Kōn-Kōn home" tabIndex={stage === "ready" ? 0 : -1}>
        <BrandMark />
      </Link>

      <nav className={styles.navbar} aria-label="Main navigation">
        <div className={styles.brandCopy}>
          <strong>KŌN-KŌN</strong>
          <small>KONA HOUSE SYSTEM</small>
        </div>
        <div className={styles.desktopNav}>
          <button type="button" onClick={openStory}>Meet KONA</button>
          <button type="button" onClick={openStory}>How she helps</button>
          <button type="button" onClick={openRadio}>KONA Radio</button>
          <Link href="/shop">Shop</Link>
        </div>
        <div className={styles.navActions}>
          <Link className={styles.workspaceLink} href="/login">Open workspace <ArrowRight /></Link>
          <button
            className={styles.menuButton}
            type="button"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            onClick={() => setMenuOpen((value) => !value)}
          >
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
        <div className={styles.mobileMenu} data-open={menuOpen}>
          <button type="button" onClick={openStory}>Meet KONA</button>
          <button type="button" onClick={openStory}>How she helps</button>
          <button type="button" onClick={openRadio}>KONA Radio</button>
          <Link href="/shop">Shop</Link>
          <Link href="/login">Open workspace</Link>
        </div>
      </nav>

      <div className={styles.heroMedia} aria-label="Interactive KONA motion portrait">
        <video
          ref={poseRef}
          muted
          playsInline
          preload="auto"
          poster={KONA_POSTER}
          disablePictureInPicture
          tabIndex={-1}
          aria-hidden="true"
        >
          <source src={KONA_VIDEO} type="video/mp4" />
        </video>
        <div className={styles.colorAtmosphere} aria-hidden="true" />
        <div className={styles.filmGrain} aria-hidden="true" />
      </div>

      <div className={styles.heroContent} id="hero-content">
        <p className={styles.introLabel}>Hey there, meet KONA,<br />Kōn-Kōn’s calm operations guide.</p>
        <p className={styles.eyebrow}><Sparkles /> MOVE LEFT OR RIGHT — KONA RESPONDS</p>
        <h1>A calmer way to<br />run the whole day.</h1>
        <p className={styles.typewriter}>
          {typedCopy}
          {typedCopy.length < INTRO_COPY.length ? <span aria-hidden="true" /> : null}
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.primaryAction} onClick={openStory}>Meet KONA <ArrowRight /></button>
          <button type="button" className={styles.lightAction} onClick={() => updatePreview(!previewing)}>
            {previewing ? <Pause /> : <Play />}{previewing ? "Pause her motion" : "Watch her move"}
          </button>
          <button type="button" className={styles.radioAction} onClick={openRadio}><Headphones /> Open KONA Radio</button>
          <Link className={styles.shopAction} href="/shop">Explore the shop</Link>
        </div>
      </div>

      {storyOpen ? (
        <aside className={styles.storyPanel} aria-label="About KONA">
          <header>
            <span>KONA / HOUSE GUIDE</span>
            <button type="button" onClick={() => setStoryOpen(false)} aria-label="Close KONA introduction"><X /></button>
          </header>
          <h2>One familiar guide across every hand-off.</h2>
          <p>KONA gives the team one calm place to move from customer request to stock, payment, receipt and the final accounting trail. She helps people find the next action; your team stays in control of every approval.</p>
          <div className={styles.storySteps}>
            <article><small>AT THE COUNTER</small><strong>Welcome, identify and sell</strong><p>Members, coupons, payments and receipts stay connected to the same sale.</p></article>
            <article><small>BEHIND THE COUNTER</small><strong>Keep stock moving</strong><p>Products, batches, locations and purchasing share one operational record.</p></article>
            <article><small>AT CLOSE</small><strong>Finish with evidence</strong><p>Posted journals and reports preserve what actually happened.</p></article>
          </div>
          <footer><Check /> KONA assists the flow. Server-enforced roles still decide who may act.</footer>
        </aside>
      ) : null}

      <div id="kona-radio" className={styles.radioDock} data-expanded={radioExpanded}>
        <button type="button" className={styles.radioCollapse} onClick={() => setRadioExpanded((value) => !value)} aria-label={radioExpanded ? "Minimize KONA Radio" : "Open KONA Radio"}>
          <Headphones />
        </button>
        <KonaRadio />
      </div>

      <div className={styles.motionNote}>MOVE LEFT · MOVE RIGHT <span>DRAG ON TOUCHSCREENS</span></div>
      <div className={styles.creatorMark}>CREATED BY <strong>RYZEN HUB DEV</strong></div>
      <div className={styles.doritoCursor} aria-hidden="true"><span /><i /><b /></div>
    </section>
  );
}
