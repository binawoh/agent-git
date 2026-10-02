import { useEffect, useState } from "react";
import { t } from "../i18n";

/** Re-renders on an interval while `active` and returns the current time. */
export function useTicking(active: boolean, interval = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [active, interval]);
  return now;
}

/** A compact age for list rows: minutes, hours and days, then the date. */
export function ago(time: number, now = Date.now()): string {
  if (!time) return "";
  const minutes = Math.floor((now - time) / 60_000);
  if (minutes < 1) return t.time.justNow;
  if (minutes < 60) return t.time.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t.time.hours(hours);
  const days = Math.floor(hours / 24);
  if (days < 7) return t.time.days(days);
  const date = new Date(time);
  return date.getFullYear() === new Date(now).getFullYear() ? `${date.getMonth() + 1}/${date.getDate()}` : `${date.getFullYear()}/${date.getMonth() + 1}`;
}

export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
