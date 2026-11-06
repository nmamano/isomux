// The button for an ask's outside page (task 0355f4b7): an ask's link, or a
// value request's, that names an https page outside the office. It opens a
// new tab at the address its label names (shared/office-links.ts
// outsideLinkFor); a link it refuses draws nothing.

import { outsideLinkFor } from "../../shared/office-links.ts";
import { filledSecondaryBtn } from "../components/dialog-styles.ts";
import { useI18n } from "../i18n.tsx";
import { noTranslate } from "../no-translate.ts";

export function OutsideLinkButton({
  link,
  isMobile,
}: {
  link: string | undefined;
  isMobile: boolean;
}) {
  const { rich } = useI18n();
  const outside = outsideLinkFor(link);
  if (!outside) return null;
  return (
    <a
      data-ask-outside-link=""
      href={outside.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        ...filledSecondaryBtn,
        display: "inline-block",
        padding: isMobile ? "8px 14px" : "5px 14px",
        fontSize: isMobile ? 13 : 12,
        textDecoration: "none",
      }}
    >
      {rich("asks.openSite", {
        site: <span {...noTranslate()}>{outside.site}</span>,
      })}
    </a>
  );
}
