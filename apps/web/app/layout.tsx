import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "Prompt2API — Prompt to blockchain API",
  description: "Create trusted, live ERC-4626 data APIs from a single prompt.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="ambient ambient-one" />
        <div className="ambient ambient-two" />
        <header className="site-header">
          <a className="brand" href="/" aria-label="Prompt2API home">
            <span className="brand-mark" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>Prompt2API</span>
          </a>
          <div className="header-meta">
            <span className="network-pill"><i /> Base mainnet</span>
            <a className="docs-link" href="/operator">Operator</a>
            <a className="docs-link" href="https://docs.substreams.dev" target="_blank" rel="noreferrer">
              Substreams docs <span aria-hidden="true">↗</span>
            </a>
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <span>Built for ETHOnline 2026</span>
          <span className="footer-dot" />
          <span>Powered by The Graph Substreams</span>
        </footer>
      </body>
    </html>
  );
}
