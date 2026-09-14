import type { SupportedLanguageCode } from "../shared/languages.ts";

export type SpokenCommandData = {
  boundaries: "word" | "none";
  marks: readonly (readonly [phrase: string, replacement: string])[];
  terminal: readonly (readonly [phrase: string, replacement: string])[];
  submit: readonly string[];
};

export const SPOKEN_COMMANDS = {
  en: {
    boundaries: "word",
    marks: [
      ["comma", ","],
      ["question mark", "?"],
      ["exclamation mark", "!"],
      ["exclamation point", "!"],
      ["colon", ":"],
      ["semicolon", ";"],
      ["semi colon", ";"],
      ["ellipsis", "..."],
      ["open parenthesis", "("],
      ["open paren", "("],
      ["close parenthesis", ")"],
      ["close paren", ")"],
    ],
    terminal: [
      ["period", "."],
      ["full stop", "."],
      ["new line", "\n"],
      ["newline", "\n"],
      ["new paragraph", "\n\n"],
    ],
    submit: ["submit"],
  },
  es: {
    boundaries: "word",
    marks: [
      ["signo de interrogación", "?"],
      ["signo de exclamación", "!"],
      ["dos puntos", ":"],
      ["punto y coma", ";"],
      ["puntos suspensivos", "..."],
      ["abre paréntesis", "("],
      ["cierra paréntesis", ")"],
    ],
    terminal: [
      ["coma", ","],
      ["punto", "."],
      ["punto final", "."],
      ["nueva línea", "\n"],
      ["nuevo párrafo", "\n\n"],
    ],
    submit: ["enviar"],
  },
  ca: {
    boundaries: "word",
    marks: [
      ["coma", ","],
      ["signe d'interrogació", "?"],
      ["signe d'exclamació", "!"],
      ["dos punts", ":"],
      ["punt i coma", ";"],
      ["punts suspensius", "..."],
      ["obre parèntesi", "("],
      ["tanca parèntesi", ")"],
    ],
    terminal: [
      ["punt", "."],
      ["punt final", "."],
      ["nova línia", "\n"],
      ["nou paràgraf", "\n\n"],
    ],
    submit: ["enviar"],
  },
  zh: {
    boundaries: "none",
    marks: [
      ["逗号", "，"],
      ["问号", "？"],
      ["感叹号", "！"],
      ["冒号", "："],
      ["分号", "；"],
      ["省略号", "……"],
      ["左括号", "（"],
      ["右括号", "）"],
    ],
    terminal: [
      ["句号", "。"],
      ["换行", "\n"],
      ["新段落", "\n\n"],
    ],
    submit: ["提交"],
  },
} as const satisfies Record<SupportedLanguageCode, SpokenCommandData>;

export function spokenCommandsFor(locale: string): SpokenCommandData | null {
  const primary = locale.split("-")[0]?.toLowerCase();
  return primary && primary in SPOKEN_COMMANDS
    ? SPOKEN_COMMANDS[primary as SupportedLanguageCode]
    : null;
}
