import { create } from "zustand";
const KEY = "notesound-search-history";
function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(value)
      ? value
          .filter((item): item is string => typeof item === "string")
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}
export const useSearchHistory = create<{
  queries: string[];
  remember: (query: string) => void;
  clear: () => void;
}>((set) => ({
  queries: read(),
  remember: (query) => {
    const clean = query.trim().slice(0, 300);
    if (!clean) return;
    set((state) => {
      const queries = [
        clean,
        ...state.queries.filter(
          (value) => value.toLocaleLowerCase() !== clean.toLocaleLowerCase(),
        ),
      ].slice(0, 12);
      try {
        localStorage.setItem(KEY, JSON.stringify(queries));
      } catch {
        /* Search still works without persistent storage. */
      }
      return { queries };
    });
  },
  clear: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* optional storage */
    }
    set({ queries: [] });
  },
}));
