import { useLanguage } from "./LanguageProvider.js";
import { languageOptions } from "./messages.js";

export function LanguageSelector() {
  const { locale, messages, setLocale } = useLanguage();
  const availableLanguages = languageOptions.filter((option) => option.locale !== locale);

  return (
    <nav className="language-switcher" aria-label={messages.languageSelectorLabel}>
      {availableLanguages.map((option) => (
        <button
          key={option.locale}
          className="language-switcher__button"
          type="button"
          aria-label={option.nativeName}
          onClick={() => setLocale(option.locale)}
        >
          {option.shortLabel}
        </button>
      ))}
    </nav>
  );
}
