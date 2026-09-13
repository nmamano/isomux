import type { AgentOutfit } from "../../shared/types.ts";
import {
  COSTUMES,
  costumeOf,
  SHIRT_COLORS,
  HAIR_COLORS,
  SKIN_COLORS,
  HAIR_STYLES,
  BEARDS,
  HATS,
  ACCESSORIES,
} from "../../shared/outfit-options.ts";
import { Character } from "../office/Character.tsx";
import { useI18n, type UiTranslator } from "../i18n.tsx";

// The outfit selects. The value stored on the agent is the id; only the words
// beside it move to the catalog (internal-docs/i18n-loop.md, S4). Pure
// functions of the translator, called during a render but not components, so
// the translator arrives as an argument (ruling 18).
function hairStyleLabels(
  i18n: UiTranslator,
): Record<AgentOutfit["hairStyle"], string> {
  return {
    short: i18n.t("dialogs.agent.hairStyle.short"),
    long: i18n.t("dialogs.agent.hairStyle.long"),
    ponytail: i18n.t("dialogs.agent.hairStyle.ponytail"),
    bun: i18n.t("dialogs.agent.hairStyle.bun"),
    pigtails: i18n.t("dialogs.agent.hairStyle.pigtails"),
    curly: i18n.t("dialogs.agent.hairStyle.curly"),
    bald: i18n.t("dialogs.agent.hairStyle.bald"),
  };
}

function hatLabels(i18n: UiTranslator): Record<AgentOutfit["hat"], string> {
  return {
    none: i18n.t("dialogs.agent.hat.none"),
    cap: i18n.t("dialogs.agent.hat.cap"),
    beanie: i18n.t("dialogs.agent.hat.beanie"),
    bow: i18n.t("dialogs.agent.hat.bow"),
    headband: i18n.t("dialogs.agent.hat.headband"),
  };
}

function accessoryLabels(i18n: UiTranslator): Record<string, string> {
  return {
    none: i18n.t("dialogs.agent.accessory.none"),
    glasses: i18n.t("dialogs.agent.accessory.glasses"),
    headphones: i18n.t("dialogs.agent.accessory.headphones"),
    bow_tie: i18n.t("dialogs.agent.accessory.bowTie"),
    tie: i18n.t("dialogs.agent.accessory.tie"),
    earrings: i18n.t("dialogs.agent.accessory.earrings"),
  };
}

function beardLabels(i18n: UiTranslator): Record<AgentOutfit["beard"], string> {
  return {
    none: i18n.t("dialogs.agent.beard.none"),
    stubble: i18n.t("dialogs.agent.beard.stubble"),
    full: i18n.t("dialogs.agent.beard.full"),
    goatee: i18n.t("dialogs.agent.beard.goatee"),
    mustache: i18n.t("dialogs.agent.beard.mustache"),
  };
}

export function OutfitPicker({
  outfit,
  onChange,
}: {
  outfit: AgentOutfit;
  onChange: (outfit: AgentOutfit) => void;
}) {
  const i18n = useI18n();
  const { t } = i18n;
  // Remove head coverings in detail previews so each option stays visible.
  const detail = {
    ...outfit,
    costume: "none" as const,
    hat: "none" as const,
    accessory: null,
  };
  function tiles(
    label: string,
    options: {
      id: string;
      label: string;
      selected: boolean;
      preview: AgentOutfit;
      select: () => void;
    }[],
    head = false,
  ) {
    return (
      <fieldset className="outfit-options">
        <legend>
          {label}
          <span className="outfit-selected-label">
            {" "}
            · {options.find((option) => option.selected)?.label}
          </span>
        </legend>
        <div className="outfit-tiles">
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              className="outfit-tile"
              aria-label={option.label}
              title={option.label}
              aria-pressed={option.selected}
              onClick={option.select}
            >
              <span
                aria-hidden="true"
                className={
                  head
                    ? "outfit-tile-picture outfit-tile-head"
                    : "outfit-tile-picture"
                }
              >
                <Character
                  state="idle"
                  outfit={option.preview}
                  portrait
                  height={head ? 90 : 60}
                />
              </span>
            </button>
          ))}
        </div>
      </fieldset>
    );
  }
  function colors(
    label: string,
    values: string[],
    field: "skin" | "color" | "hair",
  ) {
    return (
      <fieldset className="outfit-options">
        <legend>{label}</legend>
        <div className="outfit-colors">
          {values.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`${label} ${color}`}
              aria-pressed={outfit[field] === color}
              onClick={() => onChange({ ...outfit, [field]: color })}
            >
              <span style={{ background: color }} />
            </button>
          ))}
        </div>
      </fieldset>
    );
  }
  return (
    <div className="outfit-picker">
      {tiles(
        t("dialogs.agent.costume"),
        COSTUMES.map((costume) => ({
          id: costume,
          label: t(`dialogs.agent.costume.${costume}`),
          selected: costumeOf(outfit.costume) === costume,
          preview: { ...outfit, costume },
          select: () => onChange({ ...outfit, costume }),
        })),
      )}
      <div className="agent-settings-fields">
        {colors(t("dialogs.agent.skin"), SKIN_COLORS, "skin")}
        {colors(t("dialogs.agent.shirt"), SHIRT_COLORS, "color")}
        {colors(t("dialogs.agent.hairColor"), HAIR_COLORS, "hair")}
      </div>
      {tiles(
        t("dialogs.agent.hairStyle"),
        HAIR_STYLES.map((hairStyle) => ({
          id: hairStyle,
          label: hairStyleLabels(i18n)[hairStyle],
          selected: (outfit.hairStyle ?? "short") === hairStyle,
          preview: { ...detail, hairStyle },
          select: () => onChange({ ...outfit, hairStyle }),
        })),
        true,
      )}
      {tiles(
        t("dialogs.agent.hat"),
        HATS.map((hat) => ({
          id: hat,
          label: hatLabels(i18n)[hat],
          selected: outfit.hat === hat,
          preview: { ...detail, hat },
          select: () => onChange({ ...outfit, hat }),
        })),
        true,
      )}
      {tiles(
        t("dialogs.agent.beard"),
        BEARDS.map((beard) => ({
          id: beard,
          label: beardLabels(i18n)[beard],
          selected: (outfit.beard ?? "none") === beard,
          preview: { ...detail, beard },
          select: () => onChange({ ...outfit, beard }),
        })),
        true,
      )}
      {tiles(
        t("dialogs.agent.accessory"),
        ACCESSORIES.map((accessory) => ({
          id: accessory ?? "none",
          label: accessoryLabels(i18n)[accessory ?? "none"],
          selected: (outfit.accessory ?? null) === accessory,
          preview: { ...detail, accessory },
          select: () => onChange({ ...outfit, accessory }),
        })),
        true,
      )}
    </div>
  );
}
