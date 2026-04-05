import { Resvg } from "@resvg/resvg-js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

const outDir = "ui/dist/icons";
mkdirSync(outDir, { recursive: true });

const sizes = [
  { src: "ui/icon.svg", name: "icon", sizes: [180, 192, 512] },
  { src: "ui/icon-maskable.svg", name: "icon", sizes: [512], suffix: "-maskable" },
];

for (const { src, name, sizes: dims, suffix } of sizes) {
  const svg = readFileSync(src, "utf-8");
  for (const size of dims) {
    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
    const png = resvg.render().asPng();
    const filename = `${name}-${size}${suffix ?? ""}.png`;
    writeFileSync(`${outDir}/${filename}`, png);
  }
}

// Copy SVG icon too
const svgSource = readFileSync("ui/icon.svg");
writeFileSync(`${outDir}/icon.svg`, svgSource);
