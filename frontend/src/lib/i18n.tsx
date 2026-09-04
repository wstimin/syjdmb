'use client';

import { createContext, useContext, useState, useCallback, ReactNode } from 'react';
import zh from '@/i18n/locales/zh.json';
import en from '@/i18n/locales/en.json';

type Locale = 'zh' | 'en';
type Dict = typeof zh;

const dictionaries: Record<Locale, Dict> = { zh, en };

interface I18nContextType {
  locale: Locale;
  t: (key: string) => string;
  setLocale: (locale: Locale) => void;
  toggleLocale: () => void;
}

const I18nContext = createContext<I18nContextType>({} as I18nContextType);

function getNestedValue(obj: any, path: string): string {
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    if (current === undefined || current === null) return path;
    current = current[part];
  }
  return typeof current === 'string' ? current : path;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('zh');

  const t = useCallback(
    (key: string) => getNestedValue(dictionaries[locale], key),
    [locale]
  );

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try {
      localStorage.setItem('locale', l);
    } catch { /* ignore */ }
  }, []);

  const toggleLocale = useCallback(() => {
    setLocaleState((prev) => {
      const next = prev === 'zh' ? 'en' : 'zh';
      try { localStorage.setItem('locale', next); } catch { /* ignore */ }
      return next;
    });
  }, []);

  return (
    <I18nContext.Provider value={{ locale, t, setLocale, toggleLocale }}>
      {children}
    </I18nContext.Provider>
  );
}

export const useI18n = () => useContext(I18nContext);
