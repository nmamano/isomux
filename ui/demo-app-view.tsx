import { demoAppMockContent } from "./demo-app.ts";

export function DemoAppView({ name }: { name: string }) {
  const content = demoAppMockContent(name);
  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "grid",
        placeItems: "center",
        padding: 20,
        color: "var(--text-primary)",
        background: "var(--bg-base)",
      }}
    >
      <section
        aria-label={`${content.heading} demo`}
        style={{
          width: "min(760px, 100%)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          overflow: "hidden",
          background: "var(--bg-base)",
          boxShadow: "0 24px 80px var(--shadow-heavy)",
        }}
      >
        <header
          style={{
            padding: "12px 16px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          <strong style={{ fontSize: 14, color: "var(--text-muted)" }}>
            Demo app
          </strong>
        </header>
        <div style={{ padding: 24 }}>
          <h1 style={{ margin: "0 0 22px", fontSize: 22 }}>
            {content.heading}
          </h1>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 12,
            }}
          >
            {content.tiles.map(([label, value]) => (
              <div
                key={label}
                style={{
                  minHeight: 105,
                  padding: 14,
                  border: "1px solid var(--border-subtle)",
                  borderRadius: 8,
                  background: "var(--bg-subtle)",
                }}
              >
                <div
                  style={{
                    marginBottom: 12,
                    color: "var(--text-muted)",
                    fontSize: 11,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                  }}
                >
                  {label}
                </div>
                <div style={{ fontSize: content.valueSize }}>{value}</div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </main>
  );
}
