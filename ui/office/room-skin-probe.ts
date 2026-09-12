// What the three room-skin DOM files read out of a mounted office. Plain
// helpers, no UI imports: each of those files calls setUpDomTestFile() before
// it imports any UI, and a module that pulled UI in at the top would load ahead
// of that call.
//
// The files are separate because the DOM harness budgets WALL CLOCK PER FILE
// (ui/test-support/dom.ts), imports included, and mounting the whole office
// scene costs about a second. One mount per file keeps each of them clear of
// the cap; three mounts in one file measured over it.

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
