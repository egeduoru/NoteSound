import type { BunnyMood } from "./mood";

export interface BunnyPose {
  /** Displacements relative to the whole character, in normalized UV units. */
  rootX: number;
  rootY: number;
  /** All rotations use radians. */
  rootRotate: number;
  /** Scale multiplier: 1 is the resting body size. */
  bodyBreath: number;
  headRotate: number;
  headY: number;
  earLeft: number;
  earRight: number;
  pawLeft: number;
  pawRight: number;
  /** 0 is open; 1 is fully closed. */
  blink: number;
  /** Mouth opening, from 0 to 0.25. */
  mouth: number;
}

const TAU = Math.PI * 2;
const rest = (): BunnyPose => ({
  rootX: 0,
  rootY: 0,
  rootRotate: 0,
  bodyBreath: 1,
  headRotate: 0,
  headY: 0,
  earLeft: 0,
  earRight: 0,
  pawLeft: 0,
  pawRight: 0,
  blink: 0,
  mouth: 0,
});

// Reducing before multiplication also keeps very large finite input times safe.
const wave = (time: number, period: number, phase = 0) =>
  Math.sin(((time % period) / period) * TAU + phase);

function pulse(time: number, period: number, center: number, width: number) {
  const distance = Math.abs((time % period) - center);
  return distance < width
    ? (Math.cos((distance / width) * Math.PI) + 1) / 2
    : 0;
}

/** Cosmetic movement, independent of audio decoding or the playback clock. */
export function getBunnyPose(
  timeSeconds: number,
  mood: BunnyMood,
  playing: boolean,
  petting: boolean,
  reducedMotion = false,
): BunnyPose {
  if (reducedMotion) return rest();
  const time = Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0;
  const leftFlick = pulse(time, 6.7, 4.8, 0.32);
  const rightFlick = pulse(time, 8.1, 2.3, 0.28);
  const pawGreeting = pulse(time, 9.3, 1.3, 0.8);

  // The paused pet stays alive: breathing, glancing, twitching ears and blinking.
  const pose: BunnyPose = {
    rootX: 0.0025 * wave(time, 7.2),
    rootY: 0.002 * wave(time, 3.7),
    rootRotate: 0.008 * wave(time, 8.6),
    bodyBreath: 1 + 0.007 * wave(time, 3.7),
    headRotate: 0.04 * wave(time, 6.8),
    headY: 0.0018 * wave(time, 3.7, 0.6),
    earLeft: 0.04 * wave(time, 4.9) + 0.18 * leftFlick,
    earRight: 0.035 * wave(time, 5.6, 0.7) - 0.17 * rightFlick,
    pawLeft: 0.12 * pawGreeting * wave(time, 0.45),
    pawRight: 0.005 * wave(time, 6.2),
    blink: pulse(time, 4.4, 4.16, 0.13),
    mouth: 0,
  };

  if (mood === "sad") {
    pose.headY += 0.004;
    pose.headRotate -= 0.025;
    pose.bodyBreath = 1 + 0.0055 * wave(time, 4.8);
    if (playing) {
      pose.headRotate += 0.009 * wave(time, 5.4);
      pose.headY += 0.001 * wave(time, 4.8);
    }
  } else if (playing && mood === "rock") {
    pose.headRotate += 0.11 * wave(time, 0.48);
    pose.headY += 0.0135 * wave(time, 0.48, 0.45);
    pose.rootY += 0.003 * wave(time, 0.96);
    pose.rootRotate += 0.012 * wave(time, 0.96);
    pose.earLeft += 0.055 * wave(time, 0.48, 0.5);
    pose.earRight += 0.045 * wave(time, 0.48, 1.1);
    pose.pawLeft += 0.05 * wave(time, 0.96);
  } else if (playing && mood === "rap") {
    pose.headRotate += 0.035 * wave(time, 1.36);
    pose.headY += 0.006 * wave(time, 0.68);
    pose.rootX += 0.003 * wave(time, 1.36);
    pose.pawRight += 0.075 * wave(time, 0.68, 0.4);
    pose.pawLeft += 0.045 * wave(time, 1.36, 1);
    pose.mouth = 0.045 + 0.205 * ((wave(time, 0.29) + 1) / 2);
  } else if (playing) {
    pose.headRotate += 0.012 * wave(time, 2.1);
    pose.rootY += 0.0015 * wave(time, 1.8);
  }

  if (petting) {
    pose.rootY += 0.004 * wave(time, 0.42);
    pose.headRotate += 0.025 * wave(time, 0.84);
    pose.earLeft += 0.14 * wave(time, 0.38);
    pose.earRight -= 0.13 * wave(time, 0.38, 0.5);
    pose.pawLeft += 0.14 * wave(time, 0.42);
    pose.pawRight -= 0.12 * wave(time, 0.42, 0.3);
    pose.mouth = Math.max(pose.mouth, 0.05 + 0.025 * wave(time, 0.42));
  }

  return pose;
}
