import { useLanguage } from "./LanguageProvider.js";
import { locales, messages } from "./messages.js";

export function LanguageSelector() {
  const { locale, setLocale } = useLanguage();

  return (
    <div className="language-selector" role="group" aria-label="Language / Язык / Լեզու">
      {locales.map((option) => (
        <button
          className="language-option"
          aria-pressed={option === locale}
          key={option}
          lang={option}
          onClick={() => setLocale(option)}
          type="button"
        >
          {messages[option].languageName}
        </button>
      ))}
    </div>
  );
}
