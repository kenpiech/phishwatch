"use client";

import { useEffect, useState } from "react";

// The current time, ticking every `ms`. null until mounted, so the prerendered shell
// never contains a time (and server and browser HTML always match).
export function useNow(ms = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const id = setInterval(tick, ms);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, [ms]);
  return now;
}
