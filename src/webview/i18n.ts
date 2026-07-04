/**
 * Minimal webview i18n: webviews cannot use vscode.l10n, so the extension
 * passes `vscode.env.language` in the initial state and each webview picks
 * its strings from a local dictionary (English default, pt-BR translation).
 */

export type Locale = "en" | "pt-br";

export function resolveLocale(language: string | undefined | null): Locale {
  return language?.toLowerCase().startsWith("pt") ? "pt-br" : "en";
}

export type Dictionary<K extends string> = Record<K, { en: string; "pt-br": string }>;

export function makeTranslator<K extends string>(
  dictionary: Dictionary<K>,
  locale: Locale
): (key: K, ...args: Array<string | number>) => string {
  return (key, ...args) => {
    let text = dictionary[key]?.[locale] ?? dictionary[key]?.en ?? key;
    args.forEach((arg, index) => {
      text = text.replace(`{${index}}`, String(arg));
    });
    return text;
  };
}
