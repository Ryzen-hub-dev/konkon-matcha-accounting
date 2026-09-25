export const KONA_RADIO_STREAM =
  "https://streaming.exclusive.radio/er/billyeilish/icecast.audio";

export type KonaRadioState = "idle" | "loading" | "playing" | "error";

const statusByState: Record<KonaRadioState, string> = {
  idle: "Ready when you are",
  loading: "Tuning the live signal…",
  playing: "Live radio is playing",
  error: "Stream unavailable — try again",
};

export function konaRadioStatus(state: KonaRadioState) {
  return statusByState[state];
}
