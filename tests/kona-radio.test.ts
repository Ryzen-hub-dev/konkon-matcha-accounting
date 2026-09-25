import assert from "node:assert/strict";
import test from "node:test";
import { KONA_RADIO_STREAM, konaRadioStatus } from "../lib/kona-radio";

test("KONA radio uses the approved HTTPS audio endpoint", () => {
  const stream = new URL(KONA_RADIO_STREAM);
  assert.equal(stream.protocol, "https:");
  assert.equal(stream.hostname, "streaming.exclusive.radio");
  assert.equal(stream.pathname, "/er/billyeilish/icecast.audio");
});

test("KONA radio exposes honest playback states", () => {
  assert.equal(konaRadioStatus("idle"), "Ready when you are");
  assert.equal(konaRadioStatus("playing"), "Live radio is playing");
  assert.equal(konaRadioStatus("error"), "Stream unavailable — try again");
});
