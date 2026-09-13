import { CreatePipeline } from "../components/create-pipeline";

export default function HomePage() {
  return (
    <main className="page-shell create-shell landing-page">
      <section className="hero">
        <div className="eyebrow"><span>AI pipeline factory</span><i /></div>
        <h1>Turn intent into <em>indexed data.</em></h1>
        <p>
          Describe the vault data you need. Prompt2API plans, builds, validates,
          and deploys a live Substreams-powered API.
        </p>
      </section>
      <CreatePipeline />
      <section className="trust-row" aria-label="Pipeline guarantees">
        <div><span>01</span><strong>Constrained AI</strong><small>Structured plans only</small></div>
        <div><span>02</span><strong>Reviewed code</strong><small>Trusted ERC-4626 template</small></div>
        <div><span>03</span><strong>Live validation</strong><small>Real Base network data</small></div>
        <div><span>04</span><strong>Your approval</strong><small>Hash-bound deployment</small></div>
      </section>
    </main>
  );
}
