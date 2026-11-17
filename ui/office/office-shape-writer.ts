import { useEffect, useRef, type RefObject } from "react";
import { getOfficeShape, setOfficeShape } from "../device-settings.ts";
import {
  OFFICE_SHAPE_DEFAULT,
  OFFICE_SHAPE_MAX_TABS,
  shapePx,
  type OfficeShape,
  type OfficeShapeDesk,
} from "../office-shape.ts";
import { SCENE_W } from "./grid.ts";

const width = (el: Element | null) =>
  el ? shapePx(el.getBoundingClientRect().width) : 0;

/** The office's shape as drawn under `root`. A part not drawn keeps its
 *  value from `prev`: the tab bar (absent in an embed), and the desks
 *  unless the front room is in view. */
export function measureOfficeShape(
  root: HTMLElement,
  prev: OfficeShape,
  desksInView: boolean,
): OfficeShape {
  const bar = root.querySelector("[data-room-tab-bar]");
  const barPart = bar
    ? {
        tabs: [...bar.querySelectorAll("[data-room-tab-button]")]
          .slice(0, OFFICE_SHAPE_MAX_TABS)
          .map((button) => width(button.parentElement)),
        online: width(bar.querySelector("[data-online-chip]")),
        tucked: width(bar.querySelector("[data-tucked-chip]")),
      }
    : { tabs: prev.tabs, online: prev.online, tucked: prev.tucked };
  // The scene is scaled to fit and zoomed: a tag is stored in scene px.
  const sceneW =
    root.querySelector("[data-floor-scene]")?.getBoundingClientRect().width ??
    0;
  const scale = sceneW > 0 ? sceneW / SCENE_W : 1;
  const desks: OfficeShapeDesk[] = desksInView
    ? [...root.querySelectorAll<HTMLElement>("[data-desk-tag]")].map((tag) => {
        const box = tag.getBoundingClientRect();
        return {
          desk: Number(tag.dataset.deskTag),
          w: shapePx(box.width / scale),
          h: shapePx(box.height / scale),
        };
      })
    : prev.desks;
  return { ...barPart, desks };
}

/** Stores the office's shape when the page hides (task ea29a8e2), for the
 *  placeholders of the next load. Nothing before the office state is in:
 *  until then the view draws placeholders, never the office. */
export function useOfficeShapeWriter(
  root: RefObject<HTMLElement | null>,
  now: { ready: boolean; desksInView: boolean },
): void {
  const latest = useRef(now);
  useEffect(() => {
    latest.current = now;
  });
  useEffect(() => {
    const store = () => {
      const el = root.current;
      if (!el || !latest.current.ready) return;
      const before = getOfficeShape();
      const next = measureOfficeShape(
        el,
        before ?? OFFICE_SHAPE_DEFAULT,
        latest.current.desksInView,
      );
      if (JSON.stringify(next) !== JSON.stringify(before)) setOfficeShape(next);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") store();
    };
    window.addEventListener("pagehide", store);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", store);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [root]);
}
