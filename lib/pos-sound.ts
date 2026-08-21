let sharedContext: AudioContext | null = null;

function emitTone(context: AudioContext) {
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const start = context.currentTime;
  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(940, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.09, start + 0.008);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.075);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + 0.08);
}

export function playProductAddedTone() {
  if (typeof window === "undefined") return false;
  const AudioContextConstructor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextConstructor) return false;
  try {
    sharedContext ||= new AudioContextConstructor();
    if (sharedContext.state === "suspended") {
      void sharedContext.resume().then(() => { if (sharedContext) emitTone(sharedContext); }).catch(() => undefined);
    } else emitTone(sharedContext);
    return true;
  } catch {
    return false;
  }
}
