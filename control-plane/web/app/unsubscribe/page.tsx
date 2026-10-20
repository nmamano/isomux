import { UnsubscribeView } from "../../components/unsubscribe-view";
import { DocumentLanguage } from "../../lib/i18n/document-language";
import { languageForRequest } from "../../lib/i18n/request.server";

export const dynamic = "force-dynamic";

/** The page the unsubscribe link in a welcome mail opens. It changes nothing
 * until its button is pressed (components/unsubscribe-view.tsx). */
export default async function Unsubscribe(props: {
  searchParams: Promise<{ t?: string | string[] }>;
}) {
  const { t } = await props.searchParams;
  const language = await languageForRequest();
  return (
    <main lang={language}>
      <DocumentLanguage language={language} />
      <UnsubscribeView
        token={typeof t === "string" && t ? t : null}
        language={language}
      />
    </main>
  );
}
