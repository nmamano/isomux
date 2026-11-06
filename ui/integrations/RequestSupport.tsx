// The end of a tab with more options to add: a line and a button that opens a
// new issue on the Isomux repo (Nil, 2026-11-05).

import { useI18n } from "../i18n.tsx";
import { REPO_URL } from "../repo.ts";
import { Btn, hintText } from "./kit.tsx";

const HINT = {
  providers: "integrations.requestSupport.providers",
  voice: "integrations.requestSupport.voice",
  pager: "integrations.requestSupport.pager",
  messaging: "integrations.requestSupport.messaging",
} as const;

type RequestSupportTab = keyof typeof HINT;

export function hasRequestSupport(tab: string): tab is RequestSupportTab {
  return Object.hasOwn(HINT, tab);
}

export function RequestSupport({ tab }: { tab: RequestSupportTab }) {
  const { t } = useI18n();
  return (
    <p
      data-request-support={tab}
      style={{
        ...hintText,
        marginTop: 20,
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
      }}
    >
      {t(HINT[tab])}
      <Btn small href={`${REPO_URL}/issues/new`} data-request-support-link>
        {t("integrations.requestSupport.button")}
      </Btn>
    </p>
  );
}
