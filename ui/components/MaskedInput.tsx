// A field for a credential: a secret value, a token, a client secret. It is a
// text input masked with CSS, not type=password, so a password manager offers
// no generated password and asks to save nothing (Nil, 2026-10-14). Where the
// browser lacks the mask (Firefox before 114), it falls back to type=password:
// the value never shows in clear text. Copy and cut are blocked, as in a
// password field.

import type { InputHTMLAttributes } from "react";

export function cssMaskSupported(): boolean {
  return (
    typeof CSS !== "undefined" &&
    typeof CSS.supports === "function" &&
    CSS.supports("-webkit-text-security", "disc")
  );
}

type MaskedInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "type" | "autoComplete" | "autoCorrect" | "autoCapitalize" | "spellCheck"
>;

export function MaskedInput({ style, ...props }: MaskedInputProps) {
  const masked = cssMaskSupported();
  return (
    <input
      {...props}
      type={masked ? "text" : "password"}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      // How it is masked; tests read it, as happy-dom drops the property.
      data-masked-credential={masked ? "css" : "password"}
      // Password managers that skip a field on request.
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore=""
      data-form-type="other"
      onCopy={(e) => e.preventDefault()}
      onCut={(e) => e.preventDefault()}
      style={{
        ...style,
        ...(masked ? { WebkitTextSecurity: "disc" } : {}),
      }}
    />
  );
}
