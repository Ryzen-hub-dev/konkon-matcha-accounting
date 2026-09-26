"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Radio, Volume2 } from "lucide-react";
import styles from "@/app/index.module.css";
import {
  KONA_RADIO_STREAM,
  konaRadioStatus,
  type KonaRadioState,
} from "@/lib/kona-radio";

export function KonaRadio() {
  const audio = useRef<HTMLAudioElement>(null);
  const [state, setState] = useState<KonaRadioState>("idle");
  const [volume, setVolume] = useState(0.38);

  useEffect(() => () => audio.current?.pause(), []);

  async function togglePlayback() {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) {
      player.pause();
      setState("idle");
      return;
    }

    setState("loading");
    try {
      await player.play();
    } catch {
      setState("error");
    }
  }

  function updateVolume(nextVolume: number) {
    setVolume(nextVolume);
    if (audio.current) audio.current.volume = nextVolume;
  }

  return (
    <div className={styles.konaRadio} data-state={state}>
      <audio
        ref={audio}
        src={KONA_RADIO_STREAM}
        preload="none"
        onPlaying={() => setState("playing")}
        onWaiting={() => setState("loading")}
        onError={() => setState("error")}
      />
      <button
        type="button"
        className={styles.radioToggle}
        onClick={togglePlayback}
        aria-label={state === "playing" ? "Pause KONA radio" : "Play KONA radio"}
      >
        {state === "playing" ? <Pause /> : <Play />}
      </button>
      <div className={styles.radioIdentity}>
        <span><Radio /> KONA RADIO / LIVE</span>
        <strong>Sound for the daily flow.</strong>
        <small aria-live="polite">{konaRadioStatus(state)}</small>
      </div>
      <label className={styles.radioVolume}>
        <Volume2 aria-hidden="true" />
        <span className={styles.srOnly}>Radio volume</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={volume}
          onChange={(event) => updateVolume(Number(event.target.value))}
          aria-label="Radio volume"
        />
      </label>
    </div>
  );
}
