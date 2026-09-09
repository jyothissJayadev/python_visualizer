import { tokenizeJson } from "../lib/format";

/** Syntax-highlighted pretty JSON — ports formatJsonHighlight(). */
export function JsonHighlight({ value }: { value: unknown }) {
  return (
    <>
      {tokenizeJson(value).map((t, i) =>
        t.cls ? (
          <span key={i} className={t.cls}>
            {t.text}
          </span>
        ) : (
          <span key={i}>{t.text}</span>
        ),
      )}
    </>
  );
}
