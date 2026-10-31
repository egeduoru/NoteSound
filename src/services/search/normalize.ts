/** Search normalization deliberately keeps remix/live version information. */
export function normalizeSearch(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/и\u0306/g, "й")
    .replace(/ё/g, "е")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const transliteration: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ж: "zh",
  з: "z",
  и: "i",
  й: "i",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
};
export function latinize(value: string): string {
  return [...normalizeSearch(value)]
    .map((letter) => transliteration[letter] ?? letter)
    .join("");
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 0; i < a.length; i += 1) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j += 1)
      next.push(
        Math.min(next[j] + 1, row[j + 1] + 1, row[j] + Number(a[i] !== b[j])),
      );
    row = next;
  }
  return row[b.length];
}

export function matchesSearch(query: string, haystack: string): boolean {
  const normalizedQuery = latinize(query);
  if (!normalizedQuery) return false;
  const text = latinize(haystack);
  return normalizedQuery
    .split(" ")
    .every(
      (word) =>
        text.includes(word) ||
        (word.length > 3 &&
          text
            .split(" ")
            .some(
              (target) =>
                Math.abs(target.length - word.length) <= 1 &&
                distance(word, target) <= 1,
            )),
    );
}

export function safeHttps(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}
