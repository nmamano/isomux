"use client";

import { useState } from "react";
import type { SupportedLanguageCode } from "../lib/i18n/languages";
import { webTranslatorFor } from "../lib/i18n/rich";

/** The example hostname shown before a name is typed. It stays English in every
 * language: it is a DNS label the customer is about to replace, not copy. */
const EXAMPLE_NAME = "your-name";

export function OfficeAddressPreview({
  language,
  initialName,
  domain,
}: {
  language: SupportedLanguageCode;
  initialName: string;
  domain: string;
}) {
  const [name, setName] = useState(initialName);
  const { t, rich } = webTranslatorFor(language);
  const hostname = name.trim()
    ? `${name.trim()}.${domain}`
    : `${EXAMPLE_NAME}.${domain}`;

  return (
    <>
      <p>
        <label>
          {t("signup.officeName")}{" "}
          <input
            name="officeName"
            data-testid="office-name"
            defaultValue={initialName}
            autoComplete="off"
            onChange={(event) => setName(event.target.value)}
          />
        </label>
      </p>
      <p className="note" data-testid="office-address-preview">
        {rich("signup.addressPreview", {
          hostname,
          name: (chunk) => <strong>{chunk}</strong>,
        })}
      </p>
    </>
  );
}
