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
  calculateMediaCalibration,
  correctedPoseTime,
  frameDamping,
  normalizePointer,
  skipCounterTurnFrames,
} from "@/lib/interactive-video";

const PRELOADER_VIDEO = "/media/intro/optical-preloader-h264.mp4";
const KONA_VIDEO = "/media/mascot/kona-mainframe-ai-2x-v9.mp4";
const KONA_VIDEO_FALLBACK = "/media/mascot/kona-mainframe-original-v8.mp4";
const KONA_POSTER = "/media/mascot/kona-mainframe-poster-v9.jpg";
const KONA_MEDIA_CACHE = "kona-hd-media-v9";
const INTRO_COPY =
  "KONA keeps every hand-off connected — from the first order and stock movement to the final receipt and close.";

type IntroStage = "loading" | "docking" | "ready";

type CinematicIndexHeroProps = {
  businessName: string;
  workspaceLogoDataUrl?: string;
};

function BrandMark({ businessName, logoSrc }: { businessName: string; logoSrc?: string }) {
  if (logoSrc) {
    return <img src={logoSrc} alt={`${businessName} logo`} />;
  }
  return (
    <svg viewBox="0 0 56 56" role="img" aria-label={businessName}>
      <path d="M28 2 50 15v26L28 54 6 41V15Z" fill="currentColor" />
      <path d="M18 16v24m0-11 19-13M18 29l19 11" fill="none" stroke="#f8f3e8" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="39" cy="16" r="2.7" fill="#ef6b3f" />
    </svg>
  );
}

function isInteractiveTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("a, button, input, label"));
}

export function CinematicIndexHero({ businessName, workspaceLogoDataUrl }: CinematicIndexHeroProps) {
  const rootRef = useRef<HTMLElement>(null);
  const preloaderRef = useRef<HTMLVideoElement>(null);
  const poseRef = useRef<HTMLVideoElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5, clientX: 0, clientY: 0 });
  const previewingRef = useRef(false);
  const targetTimeRef = useRef(0);
  const smoothTimeRef = useRef(0);
  const durationRef = useRef(0);
  const cachedVideoUrlRef = useRef<string | null>(null);
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
    const intro = preloaderRef.current;
    const finish = () => {
      if (finished) return;
      finished = true;
      cancelAnimationFrame(frame);
      intro?.pause();
      setProgress(100);
      setStage("docking");
      dockingTimer = window.setTimeout(() => setStage("ready"), 1100);
    };
    const tick = (now: number) => {
      const mediaRatio = intro && Number.isFinite(intro.duration) && intro.duration > 0
        ? intro.currentTime / intro.duration
        : 0;
      const elapsedRatio = (now - startedAt) / 3000;
      const ratio = Math.min(1, Math.max(mediaRatio, Math.min(elapsedRatio, 0.97)));
      setProgress(Math.round(ratio * 100));
      if (ratio < 1) frame = requestAnimationFrame(tick);
      else finish();
    };
    const configurePlayback = () => {
      if (!intro || !Number.isFinite(intro.duration) || intro.duration <= 0) return;
      intro.currentTime = 0;
      intro.playbackRate = Math.max(0.25, intro.duration / 3);
      void intro.play().catch(() => undefined);
    };
    const finishWhenHidden = () => {
      if (document.visibilityState !== "visible") finish();
    };
    if (intro) {
      if (intro.readyState >= HTMLMediaElement.HAVE_METADATA) configurePlayback();
      else intro.addEventListener("loadedmetadata", configurePlayback, { once: true });
      intro.addEventListener("ended", finish, { once: true });
    }
    document.addEventListener("visibilitychange", finishWhenHidden);
    frame = requestAnimationFrame(tick);
    fallbackTimer = window.setTimeout(finish, 3400);
    return () => {
      finished = true;
      cancelAnimationFrame(frame);
      clearTimeout(dockingTimer);
      clearTimeout(fallbackTimer);
      intro?.removeEventListener("loadedmetadata", configurePlayback);
      intro?.removeEventListener("ended", finish);
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
    let seekStartedAt = 0;
    let seekIntervalMs = 1000 / 24;
    let seekBusy = false;
    let pendingSeek: number | null = null;
    let activeTouchPointer: number | null = null;
    let cursorX = innerWidth * 0.5;
    let cursorY = innerHeight * 0.5;
    let parallaxX = 0;
    let parallaxY = 0;

    const calibrateMedia = () => {
      const calibration = calculateMediaCalibration(
        video.videoWidth || 1280,
        video.videoHeight || 720,
        window.innerWidth,
        window.innerHeight,
        window.devicePixelRatio || 1,
      );
      seekIntervalMs = calibration.seekIntervalMs;
      root.style.setProperty("--media-scale", String(calibration.scale));
      root.style.setProperty("--media-focus-x", `${calibration.focusX}%`);
      root.style.setProperty("--media-focus-y", `${calibration.focusY}%`);
    };

    const flushSeek = () => {
      if (seekBusy || pendingSeek === null || previewingRef.current) return;
      const next = pendingSeek;
      pendingSeek = null;
      if (Math.abs(video.currentTime - next) < 1 / 48) return;
      seekBusy = true;
      seekStartedAt = performance.now();
      try {
        video.currentTime = next;
      } catch {
        seekBusy = false;
      }
    };
    const handleSeeked = () => {
      seekBusy = false;
      root.dataset.poseTime = video.currentTime.toFixed(3);
      if (pendingSeek !== null) requestAnimationFrame(flushSeek);
    };
    const initializeVideo = () => {
      durationRef.current = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const middle = correctedPoseTime(0.5, durationRef.current);
      targetTimeRef.current = middle;
      smoothTimeRef.current = middle;
      try {
        video.currentTime = middle;
      } catch {
        // Mobile browsers may defer the first seek until their decoder is ready.
      }
      video.pause();
      root.dataset.renderMode = "video";
      root.dataset.poseDirection = "calibrated";
      root.dataset.poseTime = middle.toFixed(3);
      calibrateMedia();
    };

    const move = (event: PointerEvent) => {
      const isTouchScrub = activeTouchPointer === event.pointerId;
      if (!finePointer.matches && !isTouchScrub) return;

      const normalized = normalizePointer(event.clientX, event.clientY, innerWidth, innerHeight);
      pointerRef.current = { ...normalized, clientX: event.clientX, clientY: event.clientY };
      if (finePointer.matches) {
        root.dataset.cursor = "visible";
        root.dataset.cursorMode = isInteractiveTarget(event.target) ? "action" : "idle";
      }
      if (!previewingRef.current && durationRef.current > 0) {
        targetTimeRef.current = correctedPoseTime(normalized.x, durationRef.current);
      }
    };
    const startTouchScrub = (event: PointerEvent) => {
      if (finePointer.matches || isInteractiveTarget(event.target)) return;
      activeTouchPointer = event.pointerId;
      root.setPointerCapture?.(event.pointerId);
      move(event);
    };
    const endTouchScrub = (event: PointerEvent) => {
      if (activeTouchPointer !== event.pointerId) return;
      activeTouchPointer = null;
      if (root.hasPointerCapture?.(event.pointerId)) root.releasePointerCapture(event.pointerId);
    };
    const resetMouse = () => {
      if (!finePointer.matches) return;
      pointerRef.current = { x: 0.5, y: 0.5, clientX: 0, clientY: 0 };
      targetTimeRef.current = correctedPoseTime(0.5, durationRef.current);
      root.dataset.cursor = "hidden";
      root.dataset.cursorMode = "idle";
    };
    const render = (now: number) => {
      const deltaMs = Math.min(64, now - lastFrameAt);
      lastFrameAt = now;
      const pointer = pointerRef.current;

      cursorX = frameDamping(cursorX, pointer.clientX || innerWidth * 0.5, deltaMs, 28);
      cursorY = frameDamping(cursorY, pointer.clientY || innerHeight * 0.5, deltaMs, 28);
      root.style.setProperty("--cursor-x", `${cursorX.toFixed(2)}px`);
      root.style.setProperty("--cursor-y", `${cursorY.toFixed(2)}px`);

      if (seekBusy && now - seekStartedAt > 240) {
        seekBusy = false;
        pendingSeek = smoothTimeRef.current;
      }

      if (!previewingRef.current && durationRef.current > 0) {
        smoothTimeRef.current = skipCounterTurnFrames(
          smoothTimeRef.current,
          targetTimeRef.current,
          durationRef.current,
        );
        smoothTimeRef.current = frameDamping(
          smoothTimeRef.current,
          targetTimeRef.current,
          deltaMs,
          reducedMotion ? 24 : 14,
        );
        pendingSeek = smoothTimeRef.current;
        if (!seekBusy && now - lastSeekAt >= seekIntervalMs) {
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

    root.dataset.renderMode = "loading";
    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) initializeVideo();
    else video.addEventListener("loadedmetadata", initializeVideo, { once: true });
    video.addEventListener("seeked", handleSeeked);
    window.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerdown", startTouchScrub);
    root.addEventListener("pointerup", endTouchScrub);
    root.addEventListener("pointercancel", endTouchScrub);
    window.addEventListener("resize", calibrateMedia, { passive: true });
    window.addEventListener("blur", resetMouse);
    document.documentElement.addEventListener("mouseleave", resetMouse);
    animationFrame = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrame);
      video.pause();
      video.removeEventListener("loadedmetadata", initializeVideo);
      video.removeEventListener("seeked", handleSeeked);
      window.removeEventListener("pointermove", move);
      root.removeEventListener("pointerdown", startTouchScrub);
      root.removeEventListener("pointerup", endTouchScrub);
      root.removeEventListener("pointercancel", endTouchScrub);
      window.removeEventListener("resize", calibrateMedia);
      window.removeEventListener("blur", resetMouse);
      document.documentElement.removeEventListener("mouseleave", resetMouse);
    };
  }, []);

  useEffect(() => {
    const video = poseRef.current;
    const root = rootRef.current;
    if (!video || !root) return;

    let cancelled = false;
    const installPersistentPlayback = async () => {
      if (!("caches" in window)) {
        root.dataset.mediaCache = "http-immutable";
        return;
      }

      try {
        const cacheNames = await window.caches.keys();
        await Promise.all(
          cacheNames
            .filter((name) => name.startsWith("kona-hd-media-") && name !== KONA_MEDIA_CACHE)
            .map((name) => window.caches.delete(name)),
        );

        const cache = await window.caches.open(KONA_MEDIA_CACHE);
        let response = await cache.match(KONA_VIDEO);
        if (!response) {
          const fetched = await fetch(KONA_VIDEO, { cache: "force-cache", credentials: "same-origin" });
          if (!fetched.ok) throw new Error(`Unable to cache KONA video (${fetched.status})`);
          await cache.put(KONA_VIDEO, fetched.clone());
          response = fetched;
        }

        const blob = await response.blob();
        if (cancelled) return;

        const resumeAt = Number.isFinite(video.currentTime) ? video.currentTime : 0;
        const shouldResume = previewingRef.current;
        const objectUrl = URL.createObjectURL(blob);
        cachedVideoUrlRef.current = objectUrl;
        video.addEventListener("loadedmetadata", () => {
          if (cancelled) return;
          video.currentTime = Math.min(resumeAt, Math.max(0, video.duration - 0.05));
          if (shouldResume) void video.play().catch(() => undefined);
          root.dataset.mediaCache = "persistent-blob";
        }, { once: true });
        video.src = objectUrl;
        video.load();
        void navigator.storage?.persist?.();
      } catch {
        root.dataset.mediaCache = "http-immutable";
      }
    };

    void installPersistentPlayback();
    return () => {
      cancelled = true;
      if (cachedVideoUrlRef.current) {
        URL.revokeObjectURL(cachedVideoUrlRef.current);
        cachedVideoUrlRef.current = null;
      }
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
        <video ref={preloaderRef} muted playsInline preload="auto" disablePictureInPicture tabIndex={-1}>
          <source src={PRELOADER_VIDEO} type="video/mp4" />
        </video>
        <div className={styles.preloaderGrey} />
        <div className={styles.preloaderAura} />
        <p>KONA IS GETTING THE DAY READY</p>
        <div className={styles.preloaderCounter} aria-live="polite">
          <span>{progress.toString().padStart(2, "0")}</span><small>%</small>
        </div>
      </div>

      <Link href="/" className={styles.dockingLogo} aria-label={`${businessName} home`} tabIndex={stage === "ready" ? 0 : -1}>
        <BrandMark businessName={businessName} logoSrc={workspaceLogoDataUrl} />
      </Link>

      <nav className={styles.navbar} aria-label="Main navigation">
        <div className={styles.brandCopy}>
          <strong>{businessName}</strong>
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
          <source src={KONA_VIDEO_FALLBACK} type="video/mp4" />
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
      <div className={styles.doritoCursor} aria-hidden="true">
        <svg viewBox="0 0 46 43">
          <defs>
            <linearGradient id="kona-chip" x1="9" y1="4" x2="39" y2="39" gradientUnits="userSpaceOnUse">
              <stop stopColor="#ffd17a" />
              <stop offset=".42" stopColor="#f28b36" />
              <stop offset="1" stopColor="#bb3c20" />
            </linearGradient>
            <filter id="kona-chip-shadow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="4" stdDeviation="3" floodColor="#5b2817" floodOpacity=".34" />
            </filter>
          </defs>
          <path d="M22.7 2.8c1.5-.4 2.9.5 3.7 1.8l16.4 30.8c1.3 2.4-.9 5.2-3.5 4.5L4.9 31.2c-2.7-.7-3-4.4-.4-5.5L22.7 2.8Z" fill="url(#kona-chip)" filter="url(#kona-chip-shadow)" />
          <path d="M7.8 27.4c8.2-1.1 13.6-8.9 16-19.4" fill="none" stroke="#ffe4a5" strokeOpacity=".74" strokeWidth="1.35" strokeLinecap="round" />
          <path d="M10.5 29.2c10.1 1.5 19 4.1 27 7.1" fill="none" stroke="#9f3820" strokeOpacity=".72" strokeWidth="1.1" strokeLinecap="round" />
          <path d="m14.5 24.6 4-2.2m8.5 7.1 3.5-2m-6.9-9.5 3-1.7" stroke="#7d281b" strokeWidth="1.45" strokeLinecap="round" />
          <circle cx="19" cy="28.5" r="1.15" fill="#ffd96d" />
          <circle cx="31.2" cy="33.2" r=".82" fill="#7d281b" />
          <circle cx="22.7" cy="12.7" r=".75" fill="#fff0ad" />
          <circle cx="25.1" cy="24.2" r=".62" fill="#6f281a" />
        </svg>
      </div>
    </section>
  );
}
