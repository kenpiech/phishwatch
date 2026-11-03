"use client";

import { defang } from "@/lib/display.ts";
import type { Toast } from "@/lib/useNotifications.ts";

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div aria-live="assertive" className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4 sm:items-end">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="alert"
          data-testid="toast"
          className={`pointer-events-auto w-full max-w-sm rounded-lg border-l-4 bg-white p-3 text-sm shadow-lg dark:bg-zinc-900 ${
            t.severity === "likely" ? "border-l-red-600" : "border-l-amber-500"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-medium">{t.text}</p>
              <p className="mt-0.5 break-all font-mono text-xs text-zinc-500">{defang(t.domain)}</p>
            </div>
            <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="text-zinc-400 hover:text-zinc-700">
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
