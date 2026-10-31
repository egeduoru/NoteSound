import { describe, expect, it } from "vitest";
import { getBunnyPose, type BunnyPose } from "./motion";
import type { BunnyMood } from "./mood";

const moods: BunnyMood[] = ["idle", "rock", "sad", "rap"];
const times = Array.from({ length: 500 }, (_, i) => i / 40);
const range = (values: number[]) => Math.max(...values) - Math.min(...values);
const rest: BunnyPose = {
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
};

describe("deterministic living bunny motion", () => {
  it("returns finite bounded poses even for invalid or extreme input times", () => {
    for (const mood of moods) {
      for (const time of [-10, 0, 0.4, 1000, Number.MAX_VALUE, NaN, Infinity]) {
        const pose = getBunnyPose(time, mood, true, true);
        expect(Object.values(pose).every(Number.isFinite)).toBe(true);
        expect(Math.abs(pose.rootX)).toBeLessThan(0.02);
        expect(Math.abs(pose.rootY)).toBeLessThan(0.02);
        expect(Math.abs(pose.headY)).toBeLessThan(0.025);
        expect(pose.bodyBreath).toBeGreaterThan(0.98);
        expect(pose.bodyBreath).toBeLessThan(1.02);
        expect(pose.mouth).toBeGreaterThanOrEqual(0);
        expect(pose.mouth).toBeLessThanOrEqual(0.25);
      }
    }
  });

  it("keeps every paused costume breathing, tilting and moving its ears", () => {
    for (const mood of moods) {
      const poses = times.map((time) => getBunnyPose(time, mood, false, false));
      expect(range(poses.map((pose) => pose.bodyBreath))).toBeGreaterThan(
        0.008,
      );
      expect(range(poses.map((pose) => pose.headRotate))).toBeGreaterThan(0.02);
      expect(range(poses.map((pose) => pose.earLeft))).toBeGreaterThan(0.07);
      expect(range(poses.map((pose) => pose.pawLeft))).toBeGreaterThan(0.03);
    }
  });

  it("uses a more energetic head motion for playing rock than for a sad song", () => {
    const rock = times.map((time) => getBunnyPose(time, "rock", true, false));
    const sad = times.map((time) => getBunnyPose(time, "sad", true, false));
    expect(range(rock.map((pose) => pose.headRotate))).toBeGreaterThan(
      2 * range(sad.map((pose) => pose.headRotate)),
    );
    expect(range(rock.map((pose) => pose.headY))).toBeGreaterThan(
      3 * range(sad.map((pose) => pose.headY)),
    );
  });

  it("blinks briefly and repeatedly while playback is paused", () => {
    const samples = times.map((time) => ({
      time,
      blink: getBunnyPose(time, "idle", false, false).blink,
    }));
    expect(samples.every(({ blink }) => blink >= 0 && blink <= 1)).toBe(true);
    expect(Math.max(...samples.map(({ blink }) => blink))).toBeGreaterThan(
      0.95,
    );
    expect(
      samples.filter(({ blink }) => blink > 0).length / samples.length,
    ).toBeLessThan(0.1);
    const closures = samples.filter(
      ({ blink }, index) =>
        blink > 0.8 && (index === 0 || samples[index - 1].blink <= 0.8),
    );
    expect(closures.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < closures.length; i++) {
      expect(closures[i].time - closures[i - 1].time).toBeGreaterThan(3.8);
      expect(closures[i].time - closures[i - 1].time).toBeLessThan(5);
    }
  });

  it("opens the rap mouth while singing and rests it on pause", () => {
    const singing = times.map(
      (time) => getBunnyPose(time, "rap", true, false).mouth,
    );
    expect(range(singing)).toBeGreaterThan(0.15);
    expect(
      times.every(
        (time) => getBunnyPose(time, "rap", false, false).mouth === 0,
      ),
    ).toBe(true);
  });

  it("responds to petting with a clearer paw gesture", () => {
    const usual = times.map(
      (time) => getBunnyPose(time, "idle", false, false).pawRight,
    );
    const petted = times.map(
      (time) => getBunnyPose(time, "idle", false, true).pawRight,
    );
    expect(range(petted)).toBeGreaterThan(10 * range(usual));
  });

  it("is reproducible and does not retain mutable pose state", () => {
    const first = getBunnyPose(2.7, "rap", true, false);
    expect(getBunnyPose(2.7, "rap", true, false)).toEqual(first);
    first.rootX = 500;
    expect(getBunnyPose(2.7, "rap", true, false).rootX).not.toBe(500);
  });

  it("honors reduced motion with a stable neutral pose for every mode", () => {
    for (const mood of moods) {
      for (const time of [0, 1.8, 100]) {
        expect(getBunnyPose(time, mood, true, true, true)).toEqual(rest);
        expect(getBunnyPose(time, mood, false, false, true)).toEqual(rest);
      }
    }
  });
});
