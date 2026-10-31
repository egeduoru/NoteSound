import { describe, expect, it } from "vitest";
import {
  latinize,
  matchesSearch,
  normalizeSearch,
  safeHttps,
} from "./normalize";

describe("search input normalization", () => {
  it("handles Cyrillic, case, spacing and е/ё", () => {
    expect(normalizeSearch("  ФИОЛЕТОВЫЙ — ЧАС  ")).toBe("фиолетовый час");
    expect(matchesSearch("лунная вода", "Лунная вода NoteSound")).toBe(true);
    expect(normalizeSearch("СЁМГА")).toBe("семга");
  });
  it("supports Latin, mixed artist/title queries, transliteration and a small typo", () => {
    expect(
      matchesSearch("notesound orbit", "Slow Orbit NoteSound Studio"),
    ).toBe(true);
    expect(
      matchesSearch("notesound лунная", "Лунная вода NoteSound Studio"),
    ).toBe(true);
    expect(matchesSearch("lunaya", "Луная")).toBe(true);
    expect(matchesSearch("Afterglw", "Afterglow")).toBe(true);
    expect(latinize("луна")).toBe("luna");
  });
  it("does not match an empty or unrelated query", () => {
    expect(matchesSearch("", "Slow Orbit")).toBe(false);
    expect(matchesSearch("Miyagi Captain", "Slow Orbit NoteSound")).toBe(false);
  });
  it("rejects unsafe artwork URLs", () => {
    expect(safeHttps("javascript:alert(1)")).toBeUndefined();
    expect(safeHttps("http://example.com/a.jpg")).toBeUndefined();
    expect(safeHttps("https://secret:password@example.com")).toBeUndefined();
    expect(safeHttps("https://example.com/cover.jpg")).toBe(
      "https://example.com/cover.jpg",
    );
  });
});
