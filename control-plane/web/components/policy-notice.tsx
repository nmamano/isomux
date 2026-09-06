import type { ReactNode } from "react";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { webTranslatorFor } from "../lib/i18n/rich";

/**
 * One sentence, one catalog key, three links inside it (ruling 16).
 *
 * THE POLICY NAMES STAY ENGLISH in every language, because they name specific
 * English documents: the hosted Terms of Service, Privacy Policy and Refund
 * Policy are the governing text and have no Spanish or Catalan version. A
 * translated name would promise one.
 */
function policyLink(href: string) {
  return (chunk: ReactNode) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {chunk}
    </a>
  );
}

export function PolicyNotice({
  language,
}: {
  language: SupportedLanguageCode;
}) {
  const { rich } = webTranslatorFor(language);
  return (
    <p className="note">
      {rich("policy.notice", {
        terms: policyLink("https://isomux.com/hosted-terms"),
        privacy: policyLink("https://isomux.com/hosted-privacy"),
        refund: policyLink("https://isomux.com/hosted-refund"),
      })}
    </p>
  );
}
