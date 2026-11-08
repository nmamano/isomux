import type { ReactNode } from "react";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { webTranslatorFor } from "../lib/i18n/rich";
import type { SignInProduct } from "../lib/signin-product";

/**
 * One sentence, one catalog key, three links inside it (ruling 16).
 *
 * THE POLICY NAMES STAY ENGLISH in every language, because they name specific
 * English documents: the hosted Terms of Service, Privacy Policy and Refund
 * Policy are the governing text and exist only in English. A translated name
 * would promise a translated document.
 */
function policyLink(href: string) {
  return (chunk: ReactNode) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {chunk}
    </a>
  );
}

const TERMS_URL = "https://isomux.com/hosted-terms";
const PRIVACY_URL = "https://isomux.com/hosted-privacy";
const REFUND_URL = "https://isomux.com/hosted-refund";

/** The same three documents as a row of links under the sign-in card, with
 * the product site after them. Their names are the documents' English titles,
 * as above, and the site is a hostname: none of it is copy.
 *
 * The three documents are Hosted's. Under the enterprise sign-in card the
 * agreement governs (the buyer signs it next), so only the product page shows. */
export function PolicyLinks({
  product = "hosted",
}: {
  product?: SignInProduct;
}) {
  if (product === "enterprise") {
    return (
      <footer className="policy-links">
        <a href="https://isomux.com/enterprise">isomux.com/enterprise</a>
      </footer>
    );
  }
  return (
    <footer className="policy-links">
      <a href={TERMS_URL} target="_blank" rel="noopener noreferrer">
        Terms of Service
      </a>
      <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
        Privacy Policy
      </a>
      <a href={REFUND_URL} target="_blank" rel="noopener noreferrer">
        Refund Policy
      </a>
      <a href="https://isomux.com/">isomux.com</a>
    </footer>
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
        terms: policyLink(TERMS_URL),
        privacy: policyLink(PRIVACY_URL),
        refund: policyLink(REFUND_URL),
      })}
    </p>
  );
}
