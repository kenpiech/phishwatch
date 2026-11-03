"use client";

// How a match reaches the user, besides appearing in the feed:
//   toast (suspicious/likely), "(3) phishwatch" in the tab title while hidden,
//   an opt-in system notification while hidden, and "New" tags since the last visit.
// All in the browser; nothing works with every phishwatch tab closed (no push service in v1).

import { useCallback, useEffect, useRef, useState } from "react";
import { defang } from "./display.ts";
import type { Hit } from "./types.ts";

const TITLE = "phishwatch";
const TOAST_MS = 8_000;

export interface Toast {
  id: number;
  severity: Hit["severity"];
  text: string;
  domain: string;
}

type Permission = NotificationPermission | "unsupported";

export function useNotifications(userId: string | null | undefined) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [unread, setUnread] = useState(0);
  const [permission, setPermission] = useState<Permission>(() =>
    typeof Notification === "undefined" ? "unsupported" : Notification.permission,
  );

  // Last visit on this device: matches saved after it get a "New" tag. Read once per page load.
  const storageKey = userId ? `phishwatch:last-seen:${userId}` : null;
  const [unseenSince] = useState<string | null>(() => (storageKey ? localStorage.getItem(storageKey) : null));
  useEffect(() => {
    if (!storageKey) return;
    const save = () => localStorage.setItem(storageKey, new Date().toISOString());
    const onVisibility = () => document.hidden && save();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", save);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", save);
    };
  }, [storageKey]);

  // Tab title shows unread matches while the tab is hidden; cleared on return.
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) ${TITLE}` : TITLE;
  }, [unread]);
  useEffect(() => {
    const onVisibility = () => !document.hidden && setUnread(0);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const nextId = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((ts) => ts.filter((t) => t.id !== id)), []);

  const notify = useCallback(
    (hit: Hit, watchName: string) => {
      if (document.hidden) setUnread((n) => n + 1);
      if (hit.severity === "low") return;

      const label = hit.severity === "likely" ? "likely-phishing" : "suspicious";
      const id = ++nextId.current;
      setToasts((ts) => [...ts.slice(-3), { id, severity: hit.severity, text: `New ${label} domain for ${watchName}`, domain: hit.domain }]);
      setTimeout(() => dismiss(id), TOAST_MS);

      if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
        new Notification(`phishwatch: ${label} domain`, { body: `${watchName}: ${defang(hit.domain)}`, tag: `hit-${hit.id}` });
      }
    },
    [dismiss],
  );

  const requestPermission = useCallback(async () => {
    if (typeof Notification === "undefined") return;
    setPermission(await Notification.requestPermission());
  }, []);

  return { toasts, dismiss, notify, permission, requestPermission, unseenSince };
}
