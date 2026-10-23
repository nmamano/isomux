// What room-skin-room.dom.test.tsx reads out of a mounted office. Plain
// helpers, no UI imports: that file calls setUpDomTestFile() before it imports
// any UI, and a module that pulled UI in at the top would load ahead of that
// call.

/** The scene container: the element the scene's own svgs hang off - they are
 *  the ones sized to the whole scene. The skin's variables are declared there,
 *  so everything drawn inside inherits them while the tab bar, the HUD and the
 *  panels outside it do not. */
export function skinProbe(container: HTMLElement, sceneW: number) {
  const root = () =>
    container.querySelector(`svg[width="${sceneW}"]`)!.parentElement!;
  return {
    floor: () => root().style.getPropertyValue("--floor-light"),
    layers: () => container.querySelectorAll("[data-skin-layer]"),
  };
}
