import { expect, it } from "bun:test";

// Each HTML shell declares the folder its bundle is served from, and the
// bundle loads its lazy assets (the KaTeX stylesheet) from there. The build
// scripts copy those assets beside the bundle, so the declared root must be
// the folder of the shell's own module script.
async function readShell(name: string) {
  const roots: string[] = [];
  const modules: string[] = [];
  await new HTMLRewriter()
    .on('meta[name="isomux-asset-root"]', {
      element(el) {
        roots.push(el.getAttribute("content") ?? "");
      },
    })
    .on('script[type="module"][src]', {
      element(el) {
        modules.push(el.getAttribute("src") ?? "");
      },
    })
    .transform(new Response(Bun.file(`${import.meta.dir}/${name}`)))
    .text();
  return { roots, modules };
}

it.each(["index.html", "demo.html", "demo-app.html"])(
  "%s declares the folder of its bundle as the asset root",
  async (name) => {
    const { roots, modules } = await readShell(name);
    expect(modules.length).toBe(1);
    const bundleFolder = modules[0].slice(0, modules[0].lastIndexOf("/") + 1);
    expect(roots).toEqual([bundleFolder]);
  },
);
