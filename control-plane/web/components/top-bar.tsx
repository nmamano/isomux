"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { useEffect, useRef, useState } from "react";
import {
  LanguageSwitch,
  hidesLanguageSwitch,
} from "../lib/i18n/language-switch";
import { useLanguage } from "../lib/i18n/use-language";
import { webTranslatorFor, type WebTranslator } from "../lib/i18n/rich";
import { useSessionProbe, type SessionProbe } from "../lib/use-session";

/** The wordmark is the product's name, not copy (ruling 11). */
const WORDMARK = "Isomux";

/**
 * The bar at the top of every customer page: the mark and the wordmark, and,
 * once the session probe says the visitor is signed in, the nav, the account's
 * address and Sign out. Below 640 px those move into a menu.
 *
 * The bar is mounted once, in the layout, and stays mounted across Link
 * navigations, so the menu closes when the pathname changes rather than when
 * the bar unmounts.
 *
 * The signed-in half waits for the probe: the two prerendered pages cannot
 * know the visitor, and the bar keeps one height either way so nothing below
 * it moves when the probe answers.
 */
export function TopBarView({
  i18n,
  probe,
  pathname,
}: {
  i18n: WebTranslator;
  probe: SessionProbe;
  pathname: string | null;
}) {
  const operator = hidesLanguageSwitch(pathname);
  const signedIn = probe.state === "signed-in" && !operator;
  const email = probe.state === "signed-in" ? (probe.email ?? "") : "";
  const [menuOpen, setMenuOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(pathname);
  const menuButton = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);

  // A navigation closes the menu. Derived during render rather than in an
  // effect, so the closed menu and the new page paint in the same commit.
  if (menuOpen && openedAt !== pathname) {
    setMenuOpen(false);
  }

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    const onPointer = (event: MouseEvent): void => {
      // Outside is anywhere but the panel and its button: the language
      // switch is in the same bar, and its list would open over the menu.
      const target = event.target as Node;
      if (
        !panel.current?.contains(target) &&
        !menuButton.current?.contains(target)
      )
        setMenuOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [menuOpen]);

  const current = (href: string): "page" | "true" | undefined => {
    if (pathname === href) return "page";
    if (href === "/" && pathname?.startsWith("/office/")) return "true";
    if (href === "/account" && pathname?.startsWith("/account/")) return "true";
    if (href === "/enterprise" && pathname?.startsWith("/enterprise/"))
      return "true";
    return undefined;
  };
  const navLinks = (testids: boolean) => (
    <>
      <Link href="/" aria-current={current("/")}>
        {i18n.t("nav.offices")}
      </Link>
      <Link
        href="/account"
        aria-current={current("/account")}
        data-testid={testids ? "account-link" : undefined}
      >
        {i18n.t("home.account")}
      </Link>
      <Link href="/enterprise" aria-current={current("/enterprise")}>
        {i18n.t("nav.enterprise")}
      </Link>
    </>
  );
  const signOutButton = (testid: string | undefined) => (
    <button
      type="button"
      className={testid ? "topbar-signout" : undefined}
      data-testid={testid}
      onClick={() => void signOut({ redirectTo: "/" })}
    >
      {i18n.t("common.signOut")}
    </button>
  );

  return (
    <div className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" />
          <span className="wordmark">{WORDMARK}</span>
        </Link>
        {signedIn && (
          <nav className="topbar-nav" data-testid="top-bar-nav">
            {navLinks(true)}
          </nav>
        )}
        <div className="topbar-end" ref={end}>
          {signedIn && (
            <>
              <span className="topbar-email" data-testid="signed-in-as">
                {email}
              </span>
              {signOutButton("sign-out")}
            </>
          )}
          {!operator && <LanguageSwitch />}
          {signedIn && (
            <button
              type="button"
              ref={menuButton}
              className="topbar-menu-button"
              aria-label={i18n.t("nav.menu")}
              aria-expanded={menuOpen}
              aria-controls="topbar-menu"
              data-testid="menu-button"
              onClick={() => {
                // An open language list would stay open behind the menu: a
                // <details> does not close on a click elsewhere.
                if (!menuOpen) {
                  end.current
                    ?.querySelectorAll("details[open]")
                    .forEach((details) => {
                      (details as HTMLDetailsElement).open = false;
                    });
                }
                setOpenedAt(pathname);
                setMenuOpen((open) => !open);
              }}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
          )}
        </div>
        {signedIn && (
          <div
            id="topbar-menu"
            ref={panel}
            className="topbar-menu"
            data-testid="menu"
            hidden={!menuOpen}
          >
            {navLinks(false)}
            <span className="topbar-menu-email">{email}</span>
            {signOutButton(undefined)}
          </div>
        )}
      </div>
    </div>
  );
}

/** Wires the probe, the router's pathname and the language into the view. On
 * the operator pages the probe does not mount: they ask no session question of
 * their own and the bar shows only the brand. */
export function TopBar() {
  const pathname = usePathname();
  if (hidesLanguageSwitch(pathname)) return <OperatorBar />;
  return <CustomerTopBar pathname={pathname} />;
}

function CustomerTopBar({ pathname }: { pathname: string | null }) {
  const probe = useSessionProbe({ account: true });
  const language = useLanguage();
  return (
    <TopBarView
      i18n={webTranslatorFor(language)}
      probe={probe}
      pathname={pathname}
    />
  );
}

function OperatorBar() {
  return (
    <div className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="brand">
          <span className="brand-mark" />
          <span className="wordmark">{WORDMARK}</span>
        </Link>
      </div>
    </div>
  );
}
