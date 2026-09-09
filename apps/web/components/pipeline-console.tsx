"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  api,
  ApiError,
  shortHex,
  type Pipeline,
  type Preview,
  type Run,
  type ValidationEvent,
} from "../lib/api";

const POLLED_STATES = new Set(["BUILD_QUEUED", "BUILDING", "VALIDATING", "DEPLOYING"]);
const FAILED_STATES = new Set([
  "PLAN_FAILED", "BUILD_FAILED", "VALIDATION_FAILED", "FAILED_INTERRUPTED",
  "DEPLOYMENT_FAILED", "CANCELLED",
]);

export function PipelineConsole({ pipelineId }: { pipelineId: string }) {
  const [pipeline, setPipeline] = useState<Pipeline | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api<Pipeline>(`/v1/pipelines/${pipelineId}`);
      setPipeline(next);
      if (next.versions.length > 0) {
        const logs = await api<{ runs: Run[] }>(`/v1/pipelines/${pipelineId}/logs`);
        setRuns(logs.runs);
      }
      if (
        next.status === "AWAITING_APPROVAL" ||
        next.status === "DEPLOYMENT_FAILED" ||
        next.status === "LIVE"
      ) {
        setPreview(await api<Preview>(`/v1/pipelines/${pipelineId}/preview`));
      }
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load the pipeline");
    }
  }, [pipelineId]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (pipeline === null || POLLED_STATES.has(pipeline.status)) void refresh();
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [pipeline?.status, refresh]);

  async function action(kind: "build" | "approve" | "retry" | "cancel") {
    setBusy(true);
    setError(null);
    try {
      const body =
        kind === "approve"
          ? JSON.stringify({
              configurationHash: preview?.configurationHash,
              packageHash: preview?.packageHash,
            })
          : "{}";
      await api(`/v1/pipelines/${pipelineId}/${kind}`, { method: "POST", body });
      await refresh();
    } catch (caught) {
      setError(
        caught instanceof ApiError ? `${caught.code}: ${caught.message}` :
          caught instanceof Error ? caught.message : "Action failed",
      );
    } finally {
      setBusy(false);
    }
  }

  const activeVersion = useMemo(
    () => pipeline?.versions.find(({ version }) => version === pipeline.activeVersion) ?? null,
    [pipeline],
  );

  if (pipeline === null) {
    return <main className="page-shell loading-page"><Spinner /><p>{error ?? "Loading pipeline…"}</p>{error ? <Link className="secondary-button" href="/operator">Unlock operator access</Link> : null}</main>;
  }

  const lastTransition = pipeline.transitions.at(-1);
  const validation = preview?.validation ?? activeVersion?.validationResult ?? null;

  return (
    <main className="page-shell workspace-shell">
      <div className="breadcrumb"><Link href="/">Pipelines</Link><span>/</span><strong>{pipeline.spec?.displayName ?? pipelineId}</strong></div>
      <section className="workspace-heading">
        <div>
          <div className="eyebrow"><span>Pipeline workspace</span><i /></div>
          <h1>{pipeline.spec?.displayName ?? "Pipeline request"}</h1>
          <p>{pipeline.originalPrompt}</p>
        </div>
        <StatusBadge status={pipeline.status} />
      </section>

      <Progress state={pipeline.status} />
      {error ? <div className="error-banner" role="alert"><span>!</span>{error}</div> : null}

      {pipeline.status === "NEEDS_INPUT" || pipeline.status === "UNSUPPORTED_SCOPE" ? (
        <section className="notice-card">
          <span className="notice-glyph">{pipeline.status === "NEEDS_INPUT" ? "?" : "×"}</span>
          <div>
            <small>{pipeline.status === "NEEDS_INPUT" ? "More information needed" : "Outside Phase 1 scope"}</small>
            <h2>{lastTransition?.reason ?? "The planner could not create this pipeline."}</h2>
            <p>Return to the builder and refine the request. IndexLoom will never invent unsupported configuration.</p>
            <Link className="secondary-button inline-button" href="/">← Revise request</Link>
          </div>
        </section>
      ) : null}

      {pipeline.spec && pipeline.derivedPlan ? (
        <>
          <section className="section-heading"><span>01</span><div><small>Validated interpretation</small><h2>Pipeline plan</h2></div></section>
          <div className="plan-grid">
            <section className="panel spec-panel">
              <div className="panel-title"><h3>Configuration</h3><span className="verified-pill">✓ Validated</span></div>
              <dl className="spec-list">
                <div><dt>Network</dt><dd><i className="base-orb" />Base mainnet</dd></div>
                <div><dt>Standard</dt><dd>ERC-4626</dd></div>
                <div><dt>Start block</dt><dd className="mono">{pipeline.spec.startBlock.toLocaleString()}</dd></div>
                <div><dt>Events</dt><dd className="tag-list">{pipeline.spec.events.map((event) => <span key={event}>{event}</span>)}</dd></div>
                <div className="contracts-row"><dt>Vaults</dt><dd>{pipeline.spec.contracts.map((contract) => (
                  <div className="contract" key={contract.address}>
                    <span>{contract.label ?? "ERC-4626 vault"}</span>
                    <code>{contract.address}</code>
                  </div>
                ))}</dd></div>
              </dl>
            </section>

            <section className="panel graph-panel">
              <div className="panel-title"><h3>Composed module graph</h3><span className="graph-provider">The Graph</span></div>
              <div className="module-graph">
                {pipeline.derivedPlan.modules.map((module, index) => (
                  <div className="module-step" key={module}>
                    <div className={`module-node module-${index}`}><span>{index === 0 ? "G" : index === 1 ? "↯" : "DB"}</span><div><small>{index === 0 ? "Imported" : index === 1 ? "Rust / WASM" : "SQL sink"}</small><strong>{module}</strong></div></div>
                    {index < pipeline.derivedPlan!.modules.length - 1 ? <span className="module-arrow">→</span> : null}
                  </div>
                ))}
              </div>
              <div className="package-callout"><span>◇</span><div><small>Pinned composable package</small><code>{pipeline.derivedPlan.importedPackage}</code></div><b>verified</b></div>
            </section>
          </div>

          <section className="panel filter-panel">
            <div className="panel-title"><div><small>Backend-derived · Never model generated</small><h3>Deterministic event filter</h3></div><CopyButton value={pipeline.derivedPlan.filterExpression} /></div>
            <pre>{highlightFilter(pipeline.derivedPlan.filterExpression)}</pre>
          </section>
        </>
      ) : null}

      {runs.length > 0 || POLLED_STATES.has(pipeline.status) || validation ? (
        <>
          <section className="section-heading"><span>02</span><div><small>Trusted build execution</small><h2>Build &amp; live validation</h2></div></section>
          <div className="build-grid">
            <section className="panel run-panel">
              <div className="panel-title"><h3>Execution stages</h3>{POLLED_STATES.has(pipeline.status) ? <span className="running-pill"><Spinner /> Running</span> : null}</div>
              <div className="run-list">
                {runs.map((run) => <RunRow key={run.id} run={run} />)}
                {runs.length === 0 ? <p className="empty-copy">Waiting for the build worker…</p> : null}
              </div>
            </section>
            <section className="panel validation-panel">
              <div className="panel-title"><h3>Validation checklist</h3><span>{validation?.eventCount ?? 0} events</span></div>
              {validation ? <Checklist validation={validation} /> : <div className="validation-wait"><RadarIcon /><p>Live Base checks appear here after the package builds.</p></div>}
            </section>
          </div>
        </>
      ) : null}

      {validation ? (
        <section className="panel preview-panel">
          <div className="panel-title"><div><small>Decoded from live Base blocks</small><h3>Event preview</h3></div><span className="live-source"><i /> Live provider data</span></div>
          <EventTable events={validation.preview} />
        </section>
      ) : null}

      {(pipeline.status === "AWAITING_APPROVAL" || pipeline.status === "DEPLOYMENT_FAILED") && preview?.configurationHash && preview.packageHash ? (
        <section className="approval-card">
          <div className="approval-icon">✓</div>
          <div className="approval-copy"><small>Human approval boundary</small><h2>Package validated. Ready to deploy.</h2><p>Approval binds this deployment to the exact reviewed source and package hashes.</p></div>
          <div className="hash-stack">
            <div><span>Configuration</span><code title={preview.configurationHash}>{shortHex(preview.configurationHash, 16, 10)}</code></div>
            <div><span>Package</span><code title={preview.packageHash}>{shortHex(preview.packageHash, 16, 10)}</code></div>
          </div>
          <button className="primary-button" disabled={busy} onClick={() => void action("approve")}>{busy ? <><Spinner /> Deploying…</> : <>{pipeline.status === "DEPLOYMENT_FAILED" ? "Retry deployment" : "Approve & deploy"} <span>→</span></>}</button>
        </section>
      ) : null}

      {pipeline.status === "PLAN_READY" ? (
        <section className="action-bar"><div><small>Next step</small><strong>Build the reviewed template and validate it on live Base data.</strong></div><button className="primary-button" disabled={busy} onClick={() => void action("build")}>{busy ? <><Spinner /> Queueing…</> : <>Build &amp; validate <span>→</span></>}</button></section>
      ) : null}

      {POLLED_STATES.has(pipeline.status) ? (
        <section className="action-bar subdued"><div><Spinner /><span><small>Pipeline in progress</small><strong>{lastTransition?.reason ?? "The worker is processing this pipeline."}</strong></span></div><button className="ghost-button" disabled={busy} onClick={() => void action("cancel")}>Cancel</button></section>
      ) : null}

      {FAILED_STATES.has(pipeline.status) && pipeline.status !== "DEPLOYMENT_FAILED" ? (
        <section className="action-bar failed"><div><span className="failure-mark">!</span><span><small>Pipeline stopped</small><strong>{lastTransition?.reason ?? "Review the logs before retrying."}</strong></span></div><button className="secondary-button" disabled={busy} onClick={() => void action("retry")}>Retry build</button></section>
      ) : null}

      {pipeline.status === "LIVE" && pipeline.slug ? (
        <section className="live-card"><div className="live-pulse"><i /><i /><span>✓</span></div><div><small>Deployment live</small><h2>Your reusable API is streaming.</h2><p>The sink is synchronized through PostgreSQL and resumes from its cursor.</p></div><Link className="primary-button" href={`/datasets/${pipeline.slug}`}>Open dataset <span>→</span></Link></section>
      ) : null}
    </main>
  );
}

function StatusBadge({ status }: { status: Pipeline["status"] }) {
  const active = POLLED_STATES.has(status);
  const failed = FAILED_STATES.has(status) || status === "UNSUPPORTED_SCOPE";
  return <span className={`status-badge ${active ? "active" : failed ? "failed" : status === "LIVE" ? "live" : ""}`}><i />{status.replaceAll("_", " ")}</span>;
}

function Progress({ state }: { state: Pipeline["status"] }) {
  const steps = ["Plan", "Build", "Validate", "Approve", "Live"];
  const positions: Partial<Record<Pipeline["status"], number>> = {
    DRAFT: 0, PLANNING: 0, PLAN_READY: 1, BUILD_QUEUED: 1, BUILDING: 1,
    VALIDATING: 2, AWAITING_APPROVAL: 3, DEPLOYING: 4, LIVE: 5,
  };
  const position = positions[state] ?? 0;
  return <nav className="progress" aria-label="Pipeline progress">{steps.map((step, index) => <div className={index < position ? "done" : index === position ? "current" : ""} key={step}><span>{index < position ? "✓" : index + 1}</span><small>{step}</small>{index < steps.length - 1 ? <i /> : null}</div>)}</nav>;
}

function RunRow({ run }: { run: Run }) {
  const successful = run.status === "SUCCEEDED";
  return <details className="run-row"><summary><span className={successful ? "run-check" : run.status === "RUNNING" ? "run-active" : "run-failed"}>{successful ? "✓" : run.status === "RUNNING" ? "•" : "!"}</span><div><strong>{run.stage}</strong><small>{run.commandLabel ?? "Trusted runner stage"}</small></div><time>{run.durationMs === null ? "—" : `${run.durationMs} ms`}</time><b>{run.status}</b></summary>{run.stdout || run.stderr || run.errorMessage ? <pre>{[run.stdout, run.stderr, run.errorMessage].filter(Boolean).join("\n")}</pre> : null}</details>;
}

function Checklist({ validation }: { validation: NonNullable<Preview["validation"]> }) {
  const labels: Record<string, string> = { hasEvents: "Matching events found", uniqueEventIds: "Unique deterministic event IDs", allowlistedVaultsOnly: "Allowlisted vaults only", validEventTypes: "Deposit / Withdraw types only", unsignedRawAmounts: "Unsigned raw integer amounts", requiredMetadataPresent: "Required chain metadata present" };
  return <ul className="checklist">{Object.entries(validation.checklist).map(([key, passed]) => <li key={key}><span>{passed ? "✓" : "×"}</span>{labels[key] ?? key}</li>)}</ul>;
}

function EventTable({ events }: { events: ValidationEvent[] }) {
  return <div className="table-scroll"><table><thead><tr><th>Type</th><th>Vault</th><th>Owner</th><th>Assets (raw)</th><th>Block</th><th>Transaction</th></tr></thead><tbody>{events.map((event) => <tr key={event.eventId}><td><span className={`event-chip ${event.eventType.toLowerCase()}`}>{event.eventType}</span></td><td><code title={event.vaultAddress}>{shortHex(event.vaultAddress)}</code></td><td><code title={event.ownerAddress}>{shortHex(event.ownerAddress)}</code></td><td className="amount">{event.assetsRaw}</td><td>{Number(event.blockNumber).toLocaleString()}</td><td><code title={event.transactionHash}>{shortHex(event.transactionHash)}</code></td></tr>)}</tbody></table></div>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return <button className="copy-button" onClick={() => { void navigator.clipboard.writeText(value); setCopied(true); window.setTimeout(() => setCopied(false), 1_500); }}>{copied ? "Copied" : "Copy"}</button>;
}

function highlightFilter(value: string) {
  return value.split(/(evt_(?:addr|sig):0x[0-9a-f]+)/gi).map((part, index) => part.startsWith("evt_") ? <mark key={index}>{part}</mark> : part);
}

function Spinner() { return <span className="spinner" aria-hidden="true" />; }
function RadarIcon() { return <svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="28"/><circle cx="40" cy="40" r="17"/><circle cx="40" cy="40" r="5"/><path d="M40 40 62 22"/></svg>; }
