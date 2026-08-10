export const metadata = {
  title: "Hosted Isomux",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, sans-serif",
          margin: 0,
          padding: "2rem",
          lineHeight: 1.5,
          maxWidth: "48rem",
        }}
      >
        {children}
      </body>
    </html>
  );
}
