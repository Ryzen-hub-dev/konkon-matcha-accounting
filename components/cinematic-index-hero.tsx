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
  correctedPoseFrame,
  coverDrawRect,
  frameDamping,
  nativeCanvasPixelRatio,
  normalizePointer,
} from "@/lib/interactive-video";

const PRELOADER_VIDEO = "/media/intro/optical-preloader-h264.mp4";
const KONA_VIDEO = "/media/mascot/kona-mainframe-fallback-v7.mp4";
const KONA_POSTER = "/media/mascot/kona-mainframe-poster-v6.jpg";
const KONA_FRAME_ROOT = "/media/mascot/kona-frames-v7";
const KONA_FRAME_COUNT = 240;
const KONA_FRAME_RATE = 24;
const KONA_SOURCE_WIDTH = 1280;
const KONA_SOURCE_HEIGHT = 720;
const KONA_NEUTRAL_FRAME = (KONA_FRAME_COUNT - 1) / 2;
const MAX_DECODED_FRAMES = 12;
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
  const poseCanvasRef = useRef<HTMLCanvasElement>(null);
  const poseFallbackRef = useRef<HTMLVideoElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5, clientX: 0, clientY: 0 });
  const previewingRef = useRef(false);
  const targetFrameRef = useRef(KONA_NEUTRAL_FRAME);
  const smoothFrameRef = useRef(KONA_NEUTRAL_FRAME);
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
    const canvas = poseCanvasRef.current;
    const fallbackVideo = poseFallbackRef.current;
    const context = canvas?.getContext("2d", { alpha: false });
    if (!root || !canvas || !fallbackVideo || !context) return;

    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const cachedFrames = new Map<number, HTMLImageElement>();
    const pendingFrames = new Set<number>();
    const queuedFrames = new Set<number>();
    let frameQueue: number[] = [];
    let animationFrame = 0;
    let lastFrameAt = performance.now();
    let renderedFrame = -1;
    let desiredFrame = Math.round(KONA_NEUTRAL_FRAME);
    let renderDpr = 1;
    let focusX = 50;
    let focusY = 50;
    let activeLoads = 0;
    let frameFailures = 0;
    let fallbackMode = false;
    let fallbackDuration = 10;
    let lastFallbackSeekAt = 0;
    let previewFrame = KONA_NEUTRAL_FRAME;
    let wasPreviewing = false;
    let disposed = false;
    let activeTouchPointer: number | null = null;
    let cursorX = innerWidth * 0.5;
    let cursorY = innerHeight * 0.5;
    let parallaxX = 0;
    let parallaxY = 0;

    const frameSource = (index: number) =>
      `${KONA_FRAME_ROOT}/frame-${index.toString().padStart(4, "0")}.webp`;
    const clampFrame = (index: number) =>
      Math.min(KONA_FRAME_COUNT - 1, Math.max(0, Math.round(index)));

    const drawFrame = (image: HTMLImageElement, index: number) => {
      const width = Math.max(1, canvas.clientWidth || window.innerWidth);
      const height = Math.max(1, canvas.clientHeight || window.innerHeight);
      const rect = coverDrawRect(image.naturalWidth, image.naturalHeight, width, height, focusX, focusY);
      context.setTransform(renderDpr, 0, 0, renderDpr, 0, 0);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.fillStyle = "#edf1ef";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, rect.x, rect.y, rect.width, rect.height);
      renderedFrame = index;
      root.dataset.renderMode = "frames";
      root.dataset.poseFrame = String(index);
      fallbackVideo.pause();
    };

    const trimDecodedFrames = () => {
      if (cachedFrames.size <= MAX_DECODED_FRAMES) return;
      const protectedFrames = new Set([
        desiredFrame,
        renderedFrame,
        Math.round(KONA_NEUTRAL_FRAME),
      ]);
      const removable = [...cachedFrames.keys()]
        .filter((index) => !protectedFrames.has(index))
        .sort((a, b) => Math.abs(b - desiredFrame) - Math.abs(a - desiredFrame));
      while (cachedFrames.size > MAX_DECODED_FRAMES && removable.length) {
        cachedFrames.delete(removable.shift()!);
      }
    };

    const activateFallback = () => {
      if (fallbackMode) return;
      fallbackMode = true;
      root.dataset.renderMode = "video";
      try {
        fallbackVideo.currentTime = (smoothFrameRef.current / (KONA_FRAME_COUNT - 1)) * fallbackDuration;
      } catch {
        // Metadata may still be loading; initializeFallback will align the pose.
      }
      if (previewingRef.current) void fallbackVideo.play().catch(() => undefined);
    };

    const pumpFrameQueue = () => {
      if (disposed) return;
      while (activeLoads < 4 && frameQueue.length) {
        const index = frameQueue.shift()!;
        queuedFrames.delete(index);
        if (cachedFrames.has(index) || pendingFrames.has(index)) continue;
        const image = new Image();
        image.decoding = "async";
        activeLoads += 1;
        pendingFrames.add(index);
        image.onload = () => {
          activeLoads -= 1;
          pendingFrames.delete(index);
          if (disposed) return;
          cachedFrames.set(index, image);
          frameFailures = 0;
          trimDecodedFrames();
          if (renderedFrame < 0 || index === desiredFrame) drawFrame(image, index);
          pumpFrameQueue();
        };
        image.onerror = () => {
          activeLoads -= 1;
          pendingFrames.delete(index);
          frameFailures += 1;
          if (frameFailures >= 3 && cachedFrames.size === 0) activateFallback();
          pumpFrameQueue();
        };
        image.src = frameSource(index);
      }
    };

    const enqueueFrame = (frame: number, priority = false) => {
      const index = clampFrame(frame);
      if (cachedFrames.has(index) || pendingFrames.has(index) || queuedFrames.has(index)) return;
      if (queuedFrames.size >= 24) {
        const retained = frameQueue.filter((queued) => Math.abs(queued - desiredFrame) <= 6);
        frameQueue = retained;
        queuedFrames.clear();
        retained.forEach((queued) => queuedFrames.add(queued));
      }
      if (!priority && queuedFrames.size >= 18) return;
      queuedFrames.add(index);
      if (priority) frameQueue.unshift(index);
      else frameQueue.push(index);
      pumpFrameQueue();
    };

    const closestCachedFrame = (target: number) => {
      let closest: { index: number; image: HTMLImageElement } | null = null;
      for (const [index, image] of cachedFrames) {
        if (!closest || Math.abs(index - target) < Math.abs(closest.index - target)) {
          closest = { index, image };
        }
      }
      return closest;
    };

    const calibrateMedia = () => {
      const calibration = calculateMediaCalibration(
        KONA_SOURCE_WIDTH,
        KONA_SOURCE_HEIGHT,
        window.innerWidth,
        window.innerHeight,
        window.devicePixelRatio || 1,
      );
      focusX = calibration.focusX;
      focusY = calibration.focusY;
      root.style.setProperty("--media-scale", String(calibration.scale));
      root.style.setProperty("--media-focus-x", `${calibration.focusX}%`);
      root.style.setProperty("--media-focus-y", `${calibration.focusY}%`);
      const width = Math.max(1, canvas.clientWidth || window.innerWidth);
      const height = Math.max(1, canvas.clientHeight || window.innerHeight);
      renderDpr = nativeCanvasPixelRatio(
        KONA_SOURCE_WIDTH,
        KONA_SOURCE_HEIGHT,
        width,
        height,
        window.devicePixelRatio || 1,
      );
      const pixelWidth = Math.round(width * renderDpr);
      const pixelHeight = Math.round(height * renderDpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const current = cachedFrames.get(renderedFrame);
      if (current) drawFrame(current, renderedFrame);
    };

    const initializeFallback = () => {
      fallbackDuration = Number.isFinite(fallbackVideo.duration) && fallbackVideo.duration > 0
        ? fallbackVideo.duration
        : 10;
      try {
        fallbackVideo.currentTime = (KONA_NEUTRAL_FRAME / (KONA_FRAME_COUNT - 1)) * fallbackDuration;
      } catch {
        // Some mobile decoders only allow seeking after their first loaded frame.
      }
      fallbackVideo.pause();
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
      if (!previewingRef.current) targetFrameRef.current = correctedPoseFrame(normalized.x, KONA_FRAME_COUNT);
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
      targetFrameRef.current = KONA_NEUTRAL_FRAME;
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

      if (previewingRef.current) {
        if (!wasPreviewing) previewFrame = smoothFrameRef.current;
        previewFrame = (previewFrame + (deltaMs / 1000) * KONA_FRAME_RATE * 0.7) % KONA_FRAME_COUNT;
        smoothFrameRef.current = previewFrame;
      } else {
        smoothFrameRef.current = frameDamping(
          smoothFrameRef.current,
          targetFrameRef.current,
          deltaMs,
          reducedMotion ? 24 : 13,
        );
      }
      wasPreviewing = previewingRef.current;
      desiredFrame = clampFrame(smoothFrameRef.current);

      if (fallbackMode) {
        if (!previewingRef.current && now - lastFallbackSeekAt >= 1000 / 24) {
          lastFallbackSeekAt = now;
          const targetTime = (smoothFrameRef.current / (KONA_FRAME_COUNT - 1)) * fallbackDuration;
          if (Math.abs(fallbackVideo.currentTime - targetTime) > 1 / 48) {
            try {
              fallbackVideo.currentTime = targetTime;
            } catch {
              // Ignore transient decoder seek failures and retry on the next frame.
            }
          }
        }
      } else {
        enqueueFrame(desiredFrame, true);
        const direction = desiredFrame >= renderedFrame ? 1 : -1;
        enqueueFrame(desiredFrame + direction);
        enqueueFrame(desiredFrame + direction * 2);
        const closest = cachedFrames.get(desiredFrame)
          ? { index: desiredFrame, image: cachedFrames.get(desiredFrame)! }
          : closestCachedFrame(desiredFrame);
        if (closest && closest.index !== renderedFrame) drawFrame(closest.image, closest.index);
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
    calibrateMedia();
    enqueueFrame(KONA_NEUTRAL_FRAME, true);
    [0, 40, 80, 160, 200, KONA_FRAME_COUNT - 1].forEach((index) => enqueueFrame(index));
    if (fallbackVideo.readyState >= HTMLMediaElement.HAVE_METADATA) initializeFallback();
    else fallbackVideo.addEventListener("loadedmetadata", initializeFallback, { once: true });
    window.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerdown", startTouchScrub);
    root.addEventListener("pointerup", endTouchScrub);
    root.addEventListener("pointercancel", endTouchScrub);
    window.addEventListener("resize", calibrateMedia, { passive: true });
    window.addEventListener("blur", resetMouse);
    document.documentElement.addEventListener("mouseleave", resetMouse);
    animationFrame = requestAnimationFrame(render);

    return () => {
      disposed = true;
      cancelAnimationFrame(animationFrame);
      fallbackVideo.pause();
      fallbackVideo.removeEventListener("loadedmetadata", initializeFallback);
      window.removeEventListener("pointermove", move);
      root.removeEventListener("pointerdown", startTouchScrub);
      root.removeEventListener("pointerup", endTouchScrub);
      root.removeEventListener("pointercancel", endTouchScrub);
      window.removeEventListener("resize", calibrateMedia);
      window.removeEventListener("blur", resetMouse);
      document.documentElement.removeEventListener("mouseleave", resetMouse);
      cachedFrames.clear();
      pendingFrames.clear();
      queuedFrames.clear();
      frameQueue = [];
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
    const video = poseFallbackRef.current;
    const root = rootRef.current;
    previewingRef.current = value;
    setPreviewing(value);
    if (!video || root?.dataset.renderMode !== "video") return;
    if (value) {
      video.loop = true;
      video.playbackRate = 0.7;
      void video.play().catch(() => {
        previewingRef.current = false;
        setPreviewing(false);
      });
    } else {
      video.pause();
      const frame = (video.currentTime / Math.max(video.duration || 10, 0.01)) * (KONA_FRAME_COUNT - 1);
      targetFrameRef.current = frame;
      smoothFrameRef.current = frame;
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
        <canvas ref={poseCanvasRef} className={styles.poseCanvas} aria-hidden="true" />
        <video
          ref={poseFallbackRef}
          className={styles.poseFallback}
          muted
          playsInline
          preload="metadata"
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
