"use client";

import Link from "next/link";
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Menu,
  Play,
  Search,
  Star,
  UserRound,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import styles from "@/app/index.module.css";
import { dampedPlayhead, normalizePointer, videoPoseTarget } from "@/lib/interactive-video";

const PRELOADER_SOURCE = "https://d2ol7oe51mr4n9.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/5fc5651c-3b5d-4171-b507-87f7e635d1b4.mp4";
const PRELOADER_VIDEO = "/media/intro/optical-preloader-h264.mp4";
const BACKGROUND_VIDEO = "https://d8j0ntlcm91z4.cloudfront.net/user_38xzZboKViGWJOttwIXH07lWA1P/hf_20260406_094145_4a271a6c-3869-4f1c-8aa7-aeb0cb227994.mp4";
const POSE_VIDEO = "/media/mascot/kona-parallax-v3.mp4";

const NAV_ITEMS = ["Eyewear", "Optics", "Sound System", "Edition", "Studio"] as const;

const SPECS = [
  { id: "frame", label: "Titanium Frame", detail: "Featherweight structure · precision-cut profile · satin monochrome finish" },
  { id: "lens", label: "Polarized AR Lens", detail: "Low-reflection optics · adaptive highlight control · edge-to-edge clarity" },
  { id: "audio", label: "Integrated Spatial Audio", detail: "Open-ear directionality · low-leakage chambers · tuned near-field sound" },
] as const;

type IntroStage = "loading" | "docking" | "ready";
type SpecId = (typeof SPECS)[number]["id"];

function BrandMark() {
  return (
    <svg viewBox="0 0 48 48" role="img" aria-label="Kōn-Kōn">
      <rect x="1" y="1" width="46" height="46" rx="14" fill="none" stroke="currentColor" strokeWidth="1" />
      <path d="M15 12v24M15 25l16-13M15 25l17 11" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="35" cy="13" r="2.2" fill="currentColor" />
    </svg>
  );
}

export function CinematicIndexHero() {
  const rootRef = useRef<HTMLElement>(null);
  const preloaderRef = useRef<HTMLVideoElement>(null);
  const poseRef = useRef<HTMLVideoElement>(null);
  const pointerRef = useRef({ x: 0.5, y: 0.5 });
  const hoveredRef = useRef(false);
  const pinnedRef = useRef(false);
  const previewingRef = useRef(false);
  const [stage, setStage] = useState<IntroStage>("loading");
  const [progress, setProgress] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [activeSpec, setActiveSpec] = useState<SpecId>("lens");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const inspectionOpen = hovered || pinned;
  const selectedSpec = SPECS.find((spec) => spec.id === activeSpec) ?? SPECS[1];

  const updatePinned = (value: boolean) => {
    pinnedRef.current = value;
    setPinned(value);
  };

  const updatePreview = (value: boolean) => {
    previewingRef.current = value;
    setPreviewing(value);
    const pose = poseRef.current;
    if (!pose) return;
    if (value) {
      pose.loop = true;
      pose.playbackRate = 0.72;
      void pose.play().catch(() => {
        previewingRef.current = false;
        setPreviewing(false);
      });
    } else {
      pose.pause();
    }
  };

  useEffect(() => {
    const video = preloaderRef.current;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      setProgress(100);
      setStage("ready");
      return;
    }

    let frame = 0;
    let finishTimer = 0;
    let fallbackTimer = 0;
    let settled = false;
    const startedAt = performance.now();
    const finish = () => {
      if (settled) return;
      settled = true;
      cancelAnimationFrame(frame);
      setProgress(100);
      setStage("docking");
      finishTimer = window.setTimeout(() => setStage("ready"), 2000);
    };
    const tick = (now: number) => {
      const elapsed = Math.min(1, (now - startedAt) / 3000);
      const media = video && Number.isFinite(video.duration) && video.duration > 0
        ? video.currentTime / video.duration
        : 0;
      const next = Math.min(1, Math.max(elapsed, media));
      setProgress(Math.round(next * 100));
      if (next >= 1) finish();
      else frame = requestAnimationFrame(tick);
    };
    const play = () => {
      if (!video || !Number.isFinite(video.duration)) return;
      video.playbackRate = Math.max(0.25, video.duration / 3);
      void video.play().catch(() => undefined);
    };
    video?.addEventListener("loadedmetadata", play, { once: true });
    video?.addEventListener("ended", finish, { once: true });
    if (video && video.readyState >= HTMLMediaElement.HAVE_METADATA) play();
    frame = requestAnimationFrame(tick);
    fallbackTimer = window.setTimeout(finish, 3200);
    return () => {
      settled = true;
      cancelAnimationFrame(frame);
      clearTimeout(finishTimer);
      clearTimeout(fallbackTimer);
      video?.removeEventListener("loadedmetadata", play);
      video?.removeEventListener("ended", finish);
    };
  }, []);

  useEffect(() => {
    const root = rootRef.current;
    const video = poseRef.current;
    if (!root || !video) return;
    const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let frame = 0;
    let playhead = 0;
    let lastSeek = 0;

    const initialize = () => {
      playhead = video.duration * 0.5;
      video.currentTime = playhead;
      video.pause();
    };
    const move = (event: PointerEvent) => {
      pointerRef.current = normalizePointer(event.clientX, event.clientY, innerWidth, innerHeight);
      root.style.setProperty("--cursor-x", `${event.clientX}px`);
      root.style.setProperty("--cursor-y", `${event.clientY}px`);
      root.dataset.cursor = "visible";
    };
    const hideCursor = () => { root.dataset.cursor = "hidden"; };
    const render = (now: number) => {
      const pointer = pointerRef.current;
      const locked = hoveredRef.current || pinnedRef.current;
      const target = locked ? video.duration * 0.52 : videoPoseTarget(pointer, video.duration);
      if (!previewingRef.current && Number.isFinite(target) && video.duration > 0) {
        playhead = dampedPlayhead(playhead, target, locked ? 0.14 : 0.08);
        if (!reducedMotion && now - lastSeek > 32 && !video.seeking && Math.abs(video.currentTime - playhead) > 0.018) {
          video.currentTime = playhead;
          lastSeek = now;
        }
      }
      const yaw = locked ? 0 : (pointer.x - 0.5) * 16;
      const pitch = locked ? 0 : (0.5 - pointer.y) * 11;
      root.style.setProperty("--yaw", `${yaw.toFixed(2)}deg`);
      root.style.setProperty("--pitch", `${pitch.toFixed(2)}deg`);
      root.style.setProperty("--light-x", `${(pointer.x * 100).toFixed(1)}%`);
      root.style.setProperty("--light-y", `${(pointer.y * 100).toFixed(1)}%`);
      frame = requestAnimationFrame(render);
    };

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) initialize();
    else video.addEventListener("loadedmetadata", initialize, { once: true });
    if (finePointer) {
      root.addEventListener("pointermove", move, { passive: true });
      root.addEventListener("pointerleave", hideCursor);
    }
    frame = requestAnimationFrame(render);
    return () => {
      cancelAnimationFrame(frame);
      video.removeEventListener("loadedmetadata", initialize);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", hideCursor);
    };
  }, []);

  const enterInspection = () => {
    hoveredRef.current = true;
    setHovered(true);
  };
  const leaveInspection = () => {
    hoveredRef.current = false;
    setHovered(false);
  };
  const openInspection = (spec: SpecId = "lens") => {
    setActiveSpec(spec);
    updatePinned(true);
    updatePreview(false);
  };
  const handleNav = (item: (typeof NAV_ITEMS)[number]) => {
    if (item === "Sound System") openInspection("audio");
    else if (item === "Optics") openInspection("lens");
    else if (item === "Eyewear") openInspection("frame");
    else if (item === "Edition") updatePreview(true);
    setMenuOpen(false);
  };
  const nudgePose = (direction: -1 | 1) => {
    const video = poseRef.current;
    if (!video || !Number.isFinite(video.duration)) return;
    updatePreview(false);
    video.currentTime = Math.min(video.duration * 0.92, Math.max(video.duration * 0.08, video.currentTime + direction * video.duration * 0.12));
  };

  return (
    <section ref={rootRef} className={styles.experience} data-stage={stage} data-inspection={inspectionOpen} id="content">
      <div className={styles.preloader} aria-hidden={stage === "ready"}>
        <video ref={preloaderRef} muted playsInline preload="auto" tabIndex={-1} data-original-source={PRELOADER_SOURCE}>
          <source src={PRELOADER_VIDEO} type="video/mp4" />
        </video>
        <div className={styles.preloaderCounter} aria-live="polite"><span>{progress}</span><small>%</small></div>
      </div>

      <Link href="/" className={styles.dockingLogo} aria-label="Kōn-Kōn home" tabIndex={stage === "ready" ? 0 : -1}>
        <BrandMark />
      </Link>

      <nav className={styles.navbar} aria-label="Main navigation">
        <div className={styles.brandCopy}><strong>KŌN-KŌN</strong><small>OPTICAL WORKSPACE</small></div>
        <div className={styles.desktopNav}>
          {NAV_ITEMS.map((item, index) => item === "Studio" ? (
            <Link key={item} href="/login" style={{ "--delay": `${100 + index * 50}ms` } as CSSProperties}>{item}</Link>
          ) : (
            <button key={item} type="button" onClick={() => handleNav(item)} style={{ "--delay": `${100 + index * 50}ms` } as CSSProperties}>{item}</button>
          ))}
        </div>
        <div className={styles.navActions}>
          <div className={`${styles.searchControl} ${styles.liquidGlass}`} data-open={searchOpen}>
            <Search aria-hidden="true" />
            {searchOpen && <input autoFocus aria-label="Search experience" placeholder="Search optics" onKeyDown={(event) => { if (event.key === "Escape") setSearchOpen(false); }} />}
            {!searchOpen && <button type="button" onClick={() => setSearchOpen(true)} aria-label="Open search">Search</button>}
          </div>
          <Link href="/login" className={`${styles.profileButton} ${styles.liquidGlass}`} aria-label="Open workspace"><UserRound /></Link>
          <button className={`${styles.menuButton} ${styles.liquidGlass}`} type="button" aria-expanded={menuOpen} aria-label={menuOpen ? "Close menu" : "Open menu"} onClick={() => setMenuOpen((value) => !value)}>
            {menuOpen ? <X /> : <Menu />}
          </button>
        </div>
        <div className={`${styles.mobileMenu} ${styles.liquidGlass}`} data-open={menuOpen}>
          {NAV_ITEMS.map((item) => item === "Studio" ? <Link key={item} href="/login">{item}</Link> : <button key={item} type="button" onClick={() => handleNav(item)}>{item}</button>)}
        </div>
      </nav>

      <div className={styles.heroMedia} aria-hidden="true">
        <video className={styles.backgroundVideo} autoPlay muted loop playsInline preload="metadata" disablePictureInPicture tabIndex={-1}>
          <source src={BACKGROUND_VIDEO} type="video/mp4" />
        </video>
        <div className={styles.characterFilm}>
          <video ref={poseRef} muted playsInline preload="auto" disablePictureInPicture tabIndex={-1}>
            <source src={POSE_VIDEO} type="video/mp4" />
          </video>
        </div>
      </div>

      <div className={styles.opticalBlur} aria-hidden="true" />

      <div className={styles.characterZone} onPointerEnter={enterInspection} onPointerLeave={leaveInspection} onFocus={enterInspection} onBlur={leaveInspection}>
        <button type="button" className={styles.inspectionTarget} aria-label="Inspect KONA eyewear" aria-pressed={pinned} onClick={() => updatePinned(!pinned)} />
        <div className={styles.eyewearRig} aria-hidden="true">
          <span className={styles.lensLeft} /><span className={styles.bridge} /><span className={styles.lensRight} />
        </div>
        <div className={styles.hotspots} aria-label="Eyewear specifications">
          {SPECS.map((spec) => (
            <button key={spec.id} type="button" className={styles.hotspot} data-spec={spec.id} data-active={activeSpec === spec.id} onPointerEnter={() => setActiveSpec(spec.id)} onFocus={() => setActiveSpec(spec.id)} onClick={() => openInspection(spec.id)}>
              <span>+</span><b>{spec.label}</b>
            </button>
          ))}
        </div>
        <article className={`${styles.specCard} ${styles.liquidGlass}`} aria-live="polite">
          <div><span>OPTICAL SYSTEM / {SPECS.findIndex((spec) => spec.id === activeSpec) + 1}</span><Check /></div>
          <h2>{selectedSpec.label}</h2>
          <p>{selectedSpec.detail}</p>
          <button type="button" onClick={() => updatePinned(false)}>Close inspection</button>
        </article>
      </div>

      <div className={styles.heroContent} id="hero-content">
        <div className={styles.metadata}>
          <span><Star fill="currentColor" />8.7/10 IMDB</span><i />
          <span><Clock3 />132 min</span><i />
          <span><CalendarDays />April, 2026</span>
        </div>
        <h1>Step Through.<br />Work Smarter.</h1>
        <p>A voyage through forgotten realms, where past and future intertwine.</p>
        <div className={styles.actions}>
          <button type="button" className={styles.primaryAction} onClick={() => updatePreview(!previewing)}><Play fill="currentColor" />{previewing ? "Pause sequence" : "Play sequence"}</button>
          <button type="button" className={`${styles.secondaryAction} ${styles.liquidGlass}`} onClick={() => updatePinned(!pinned)}>Explore Optics</button>
        </div>
      </div>

      <div className={styles.poseControls} aria-label="Pose navigation">
        <button type="button" className={styles.liquidGlass} aria-label="Previous pose" onClick={() => nudgePose(-1)}><ChevronLeft /></button>
        <button type="button" className={styles.liquidGlass} aria-label="Next pose" onClick={() => nudgePose(1)}><ChevronRight /></button>
      </div>

      <div className={styles.creatorMark}>KONA / 2026 <span>CREATED BY RYZEN HUB DEV</span></div>
      <div className={styles.inspectCursor} aria-hidden="true"><span>+</span><b>Explore optics</b></div>
    </section>
  );
}
