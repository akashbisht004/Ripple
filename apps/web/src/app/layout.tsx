import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "RIPPLE — impact analysis on the graph",
  description:
    "Graph-powered code change intelligence: every change creates waves. See them before they hit production.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <div className="header-inner">
            <a href="/" className="brand">
              <span className="brand-mark">🌊</span>
              <span className="brand-name">
                RIPPLE<span className="brand-sub">graph-powered review</span>
              </span>
            </a>
            <nav className="header-links">
              <span className="chip chip-falkordb">⚡ Powered by FalkorDB</span>
              <a href="https://github.com/FalkorDB/falkordb-nodejs" target="_blank" rel="noreferrer" className="ghost-link">
                falkordb-js ↗
              </a>
            </nav>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          every change creates waves — see them before they hit production ·{" "}
          <code>docs/implementation.md</code>
        </footer>
      </body>
    </html>
  );
}
