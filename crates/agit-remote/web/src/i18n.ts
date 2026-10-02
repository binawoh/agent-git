// The interface language. It is chosen once when the page loads, and switching it saves the
// choice and reloads the page, so any module may read `t` at import time.

import { en, type Messages } from "./locales/en";
import { zhCN } from "./locales/zh-CN";

export type Locale = "en" | "zh-CN";

const STORAGE_KEY = "agit.locale";
const catalogs: Record<Locale, Messages> = { en, "zh-CN": zhCN };

/** The browser's first preferred language that has a catalog; English when none does. */
function preferred(): Locale {
  const tags = navigator.languages?.length ? navigator.languages : [navigator.language];
  for (const tag of tags) {
    if (/^zh\b/i.test(tag)) return "zh-CN";
    if (/^en\b/i.test(tag)) return "en";
  }
  return "en";
}

function saved(): Locale | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "en" || value === "zh-CN" ? value : null;
  } catch {
    return null;
  }
}

export const locale: Locale = saved() ?? preferred();
export const t: Messages = catalogs[locale];
document.documentElement.lang = locale;

/** Every interface language, each named in itself. */
export const locales = (Object.keys(catalogs) as Locale[]).map((id) => ({ id, name: catalogs[id].languageName }));

/** Headings of every language, since a message keeps the heading of the page that sent it. */
export const attachmentHeadings = Object.values(catalogs).map((catalog) => catalog.composer.attachmentHeading);

export function switchLocale(next: Locale) {
  if (next === locale) return;
  try {
    localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Storage refused: the reload falls back to the browser's preferred language.
  }
  location.reload();
}
