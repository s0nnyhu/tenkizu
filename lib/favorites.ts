"use client";

import { useCallback, useEffect, useState } from "react";

const KEY = "tenkizu:fav-icao";
const LEGACY_KEYS = ["tenshi:fav-icao", "shamu14:fav-icao"];

function read(): string[] {
  try {
    const raw =
      localStorage.getItem(KEY) ?? LEGACY_KEYS.map((k) => localStorage.getItem(k)).find(Boolean);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.map((x) => String(x).toUpperCase()).filter(Boolean))];
  } catch {
    return [];
  }
}

export function useFavorites() {
  const [favs, setFavs] = useState<string[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setFavs(read());
    setReady(true);
  }, []);

  const persist = useCallback((next: string[]) => {
    setFavs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* quota / private mode */
    }
  }, []);

  const has = useCallback((icao: string) => favs.includes(icao.toUpperCase()), [favs]);

  const toggle = useCallback(
    (icao: string) => {
      const id = icao.toUpperCase();
      persist(has(id) ? favs.filter((x) => x !== id) : [...favs, id]);
    },
    [favs, has, persist],
  );

  return { favs, ready, has, toggle };
}
