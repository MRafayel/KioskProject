import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { messages, numberLocales, type Locale, type MessageCatalog } from "./messages.js";

interface LanguageContextValue {
  locale: Locale;
  numberLocale: string;
  messages: MessageCatalog;
  setLocale: (locale: Locale) => void;
  resetLocale: () => void;
}

const DEFAULT_LOCALE: Locale = "hy";
const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LanguageContextValue>(
    () => ({
      locale,
      numberLocale: numberLocales[locale],
      messages: messages[locale],
      setLocale,
      resetLocale: () => setLocale(DEFAULT_LOCALE)
    }),
    [locale]
  );

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const context = useContext(LanguageContext);
  if (!context) throw new Error("LANGUAGE_CONTEXT_MISSING");
  return context;
}
