import { useRef } from "react";

// A row of steps that grow left to right, the steps up to the chosen one
// filled, each named under its bar. One radio group: arrows, Home and End
// move between the steps that are not disabled.
export interface StepSliderProps<T extends string> {
  steps: readonly T[];
  value: T;
  onChange: (step: T) => void;
  stepLabel: (step: T) => string;
  ariaLabel: string;
  // The data attribute that carries the value on the group and each step's
  // own value on the step, for example "data-view-level".
  attr: `data-${string}`;
  // The whole group.
  disabled?: boolean;
  // One step: it stays in the row, dimmed, and cannot be picked.
  stepDisabled?: (step: T) => boolean;
  // A tooltip, shown only on a disabled step.
  stepTitle?: (step: T) => string | undefined;
}

// The tallest bar; each step down is 3 px shorter.
const BAR_MAX = 18;

export function StepSlider<T extends string>({
  steps,
  value,
  onChange,
  stepLabel,
  ariaLabel,
  attr,
  disabled = false,
  stepDisabled,
  stepTitle,
}: StepSliderProps<T>): React.ReactElement {
  const groupRef = useRef<HTMLDivElement>(null);
  const rank = steps.indexOf(value);
  const off = (step: T) => stepDisabled?.(step) ?? false;

  function pick(next: T) {
    if (disabled || off(next) || next === value) return;
    onChange(next);
    // Focus follows the checked step, as in a native radio group.
    groupRef.current
      ?.querySelector<HTMLButtonElement>(`[role="radio"][${attr}="${next}"]`)
      ?.focus();
  }

  // The first step from `from` in direction `dir` that is not disabled.
  function nextOn(from: number, dir: 1 | -1): T | undefined {
    for (let i = from; i >= 0 && i < steps.length; i += dir) {
      if (!off(steps[i])) return steps[i];
    }
    return undefined;
  }

  function onKeyDown(e: React.KeyboardEvent) {
    let to: T | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") to = nextOn(rank + 1, 1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown")
      to = nextOn(rank - 1, -1);
    else if (e.key === "Home") to = nextOn(0, 1);
    else if (e.key === "End") to = nextOn(steps.length - 1, -1);
    else return;
    e.preventDefault();
    if (to !== undefined) pick(to);
  }

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      {...{ [attr]: value }}
      onKeyDown={onKeyDown}
      style={{
        display: "flex",
        gap: 4,
        flex: 1,
        opacity: disabled ? 0.35 : 1,
        minWidth: 0,
        maxWidth: 480,
      }}
    >
      {steps.map((step, i) => {
        const checked = step === value;
        const filled = i <= rank;
        const stepOff = off(step);
        return (
          <button
            key={step}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-label={stepLabel(step)}
            aria-disabled={stepOff || undefined}
            title={stepOff ? stepTitle?.(step) : undefined}
            {...{ [attr]: step }}
            data-filled={filled ? "true" : "false"}
            data-disabled={stepOff || undefined}
            tabIndex={checked ? 0 : -1}
            disabled={disabled}
            onClick={() => pick(step)}
            style={{
              // A step is as wide as its name and shares the rest, so a
              // long name never breaks.
              flex: "1 1 auto",
              minWidth: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "stretch",
              justifyContent: "flex-start",
              gap: 4,
              padding: "2px 0",
              border: "none",
              background: "transparent",
              cursor: disabled
                ? "default"
                : stepOff
                  ? "not-allowed"
                  : "pointer",
              // A step that cannot be picked shows dimmed. It keeps its
              // fill, so the order still reads.
              opacity: stepOff ? 0.4 : 1,
            }}
          >
            {/* The bars grow step by step, so the order shows without the
                names. They stand on one baseline. */}
            <span
              aria-hidden
              style={{
                display: "flex",
                alignItems: "flex-end",
                height: BAR_MAX,
              }}
            >
              <span
                style={{
                  display: "block",
                  width: "100%",
                  height: BAR_MAX - (steps.length - 1 - i) * 3,
                  borderRadius: 2,
                  background: filled ? "var(--accent)" : "var(--text-ghost)",
                  opacity: filled ? 1 : 0.3,
                  boxShadow: checked
                    ? "0 0 0 1.5px var(--text-primary)"
                    : undefined,
                }}
              />
            </span>
            <span
              aria-hidden
              style={{
                fontSize: 10,
                lineHeight: 1.2,
                textAlign: "center",
                whiteSpace: "nowrap",
                color: checked ? "var(--accent-text)" : "var(--text-muted)",
                fontWeight: checked ? 600 : 400,
              }}
            >
              {stepLabel(step)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
