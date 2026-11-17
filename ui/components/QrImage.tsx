// A QR code drawn from an SVG string (uqr's renderSVG, made here or on the
// server), on a white ground with a quiet zone so a camera reads it in the dark
// theme too. Extra data-* attributes go on the <img>.
export function QrImage({
  svg,
  alt,
  ...data
}: {
  svg: string;
  alt: string;
  [marker: `data-${string}`]: string;
}) {
  return (
    <img
      {...data}
      alt={alt}
      src={`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`}
      style={{
        width: 220,
        height: 220,
        background: "#fff",
        padding: 8,
        borderRadius: 6,
        display: "block",
      }}
    />
  );
}
