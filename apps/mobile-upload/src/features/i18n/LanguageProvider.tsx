import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { messages, type Locale, type Messages } from "./messages.js";

interface LanguageContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  text: Messages;
}

const LanguageContext = createContext<LanguageContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>("hy");

  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = messages[locale].pageTitle;
  }, [locale]);

  const value = useMemo(() => ({ locale, setLocale, text: messages[locale] }), [locale]);

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useLanguage(): LanguageContextValue {
  const value = useContext(LanguageContext);
  if (!value) throw new Error("LANGUAGE_PROVIDER_MISSING");
  return value;
}
