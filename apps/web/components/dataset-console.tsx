"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, ApiError, formatRaw, shortHex, type Contract, type ValidationEvent } from "../lib/api";

interface DatasetMeta {
  dataset: string;
  version: number;
  status: "LIVE" | "SYNCING";
  indexedThroughBlock: string | null;
  amountUnit: "raw";
  chain: "base-mainnet";
  standard: "erc4626";
  contracts: Contract[];
  events: string[];
  payment:
    | { enabled: false }
    | {
        enabled: true;
        protocol: "x402";
        version: 2;
        network: "hedera:testnet";
        scheme: "exact";
        asset: "0.0.0";
        amount: string;
        unit: "tinybar";
        payTo: string;
        protectedResources: ["events", "hourlyFlows"];
      };
}

interface DatasetSchema {
  resources: Record<string, string[]>;
}

interface HourlyFlow {
  vaultAddress: string;
  hourStart: string;
  inflowAssetsRaw: string;
  outflowAssetsRaw: string;
  netAssetsRaw: string;
  depositCount: string;
  withdrawalCount: string;
  uniqueOwners: string;
}

type PaidResource = "events" | "hourly-flows";

interface DemoPurchaseResponse {
  data: { items: unknown[] };
  payment: {
    success: true;
    transaction: string;
    network: "hedera:testnet";
    amount?: string;
    payer?: string;
    hashscanUrl: string;
  };
}

export function DatasetConsole({ slug }: { slug: string }) {
  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [schema, setSchema] = useState<DatasetSchema | null>(null);
  const [events, setEvents] = useState<ValidationEvent[]>([]);
  const [flows, setFlows] = useState<HourlyFlow[]>([]);
  const [tab, setTab] = useState<"events" | "flows" | "schema">("events");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState<PaidResource | null>(null);
  const [purchasedResources, setPurchasedResources] = useState<Set<PaidResource>>(() => new Set());
  const [receipt, setReceipt] = useState<(DemoPurchaseResponse["payment"] & { resource: PaidResource }) | null>(null);

  const load = useCallback(async () => {
    try {
      const nextMeta = await api<DatasetMeta>(`/v1/datasets/${slug}/meta`);
      setMeta(nextMeta);
      setSchema(await api<DatasetSchema>(`/v1/datasets/${slug}/schema`));
      if (nextMeta.status === "LIVE" && !nextMeta.payment.enabled) {
        const [eventPage, flowPage] = await Promise.all([
          api<{ items: ValidationEvent[] }>(`/v1/datasets/${slug}/events?limit=25`),
          api<{ items: HourlyFlow[] }>(`/v1/datasets/${slug}/flows/hourly?limit=25`),
        ]);
        setEvents(eventPage.items);
        setFlows(flowPage.items);
      }
      setError(null);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "DATASET_SYNCING") return;
      setError(caught instanceof Error ? caught.message : "Unable to load dataset");
    }
  }, [slug]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), meta?.status === "LIVE" ? 10_000 : 1_500);
    return () => window.clearInterval(timer);
  }, [load, meta?.status]);

  const apiPath = `/v1/datasets/${slug}/events?limit=25`;
  const examples = useMemo(() => ({
    curl: `curl "http://localhost:4000${apiPath}"`,
    agent: `pnpm --filter @prompt2api/consumer-agent dev -- ${slug} events`,
  }), [apiPath]);

  function copy(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1_500);
  }

  async function purchase(resource: PaidResource) {
    if (!meta?.payment.enabled || purchasing !== null) return;
    const label = resource === "events" ? "raw events" : "hourly flows";
    if (!window.confirm(`Spend ${formatHbar(meta.payment.amount)} testnet HBAR to load ${label}?`)) return;
    setPurchasing(resource);
    setError(null);
    try {
      const response = await fetch(`/demo-purchase/${encodeURIComponent(slug)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ resource }),
        cache: "no-store",
      });
      const result = await response.json().catch(() => null) as
        | DemoPurchaseResponse
        | { error?: { code?: string; message?: string } }
        | null;
      if (!response.ok || result === null || !("payment" in result)) {
        const failure = result as { error?: { code?: string; message?: string } } | null;
        throw new Error(failure?.error?.message ?? `Demo purchase failed (${response.status})`);
      }
      if (resource === "events") {
        setEvents(result.data.items as ValidationEvent[]);
      } else {
        setFlows(result.data.items as HourlyFlow[]);
      }
      setPurchasedResources((current) => new Set(current).add(resource));
      setReceipt({ ...result.payment, resource });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to complete demo payment");
    } finally {
      setPurchasing(null);
    }
  }

  if (meta === null) {
    return <main className="page-shell loading-page"><span className="spinner" /><p>{error ?? "Connecting to dataset…"}</p></main>;
  }

  return (
    <main className="page-shell dataset-shell">
      <div className="breadcrumb"><Link href="/">Pipelines</Link><span>/</span><strong>{slug}</strong></div>
      <section className="dataset-heading">
        <div><div className="eyebrow"><span>Reusable data product</span><i /></div><h1>{slug}</h1><p>Normalized ERC-4626 vault activity, continuously streamed from Base.</p></div>
        <span className={`status-badge ${meta.status === "LIVE" ? "live" : "active"}`}><i />{meta.status}</span>
      </section>

      {error ? <div className="error-banner"><span>!</span><span>{error}{error.includes("Demo purchasing is not available") ? <> · <Link href="/operator">Unlock operator access</Link></> : null}</span></div> : null}

      <section className="metric-grid">
        <div className="metric-card"><small>Network</small><strong><i className="base-orb" />Base mainnet</strong><span>Chain ID 8453</span></div>
        <div className="metric-card"><small>Indexed through</small><strong>{meta.indexedThroughBlock ? Number(meta.indexedThroughBlock).toLocaleString() : "Syncing…"}</strong><span>Block cursor</span></div>
        <div className="metric-card"><small>Vault contracts</small><strong>{meta.contracts.length}</strong><span>{meta.events.join(" + ")}</span></div>
        <div className="metric-card accent"><small>{meta.payment.enabled ? "x402 price" : "Dataset version"}</small><strong>{meta.payment.enabled ? `${formatHbar(meta.payment.amount)} HBAR` : `v${meta.version}`}</strong><span>{meta.payment.enabled ? "Per data request · Hedera testnet" : "Raw integer units"}</span></div>
      </section>

      <div className="dataset-layout">
        <section className="dataset-main">
          {receipt !== null ? (
            <section className="payment-receipt" aria-live="polite">
              <span className="receipt-check">✓</span>
              <div>
                <small>x402 payment settled</small>
                <strong>{receipt.resource === "events" ? "Raw events loaded" : "Hourly flows loaded"}</strong>
                <p>{formatHbar(receipt.amount ?? (meta.payment.enabled ? meta.payment.amount : "100000"))} HBAR on Hedera testnet</p>
              </div>
              <code title={receipt.transaction}>{shortHex(receipt.transaction, 14, 12)}</code>
              <a href={receipt.hashscanUrl} target="_blank" rel="noreferrer">View on HashScan ↗</a>
            </section>
          ) : null}
          <div className="dataset-tabs" role="tablist">
            <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>Raw events <span>{events.length}</span></button>
            <button className={tab === "flows" ? "active" : ""} onClick={() => setTab("flows")}>Hourly flows <span>{flows.length}</span></button>
            <button className={tab === "schema" ? "active" : ""} onClick={() => setTab("schema")}>API schema</button>
          </div>

          <div className="panel dataset-table-panel">
            {tab === "events" ? <EventsTable events={events} syncing={meta.status !== "LIVE"} locked={meta.payment.enabled && !purchasedResources.has("events")} purchasing={purchasing === "events"} onPurchase={() => void purchase("events")} /> : null}
            {tab === "flows" ? <FlowsTable flows={flows} syncing={meta.status !== "LIVE"} locked={meta.payment.enabled && !purchasedResources.has("hourly-flows")} purchasing={purchasing === "hourly-flows"} onPurchase={() => void purchase("hourly-flows")} /> : null}
            {tab === "schema" ? <SchemaView schema={schema} /> : null}
          </div>
        </section>

        <aside className="dataset-aside">
          <section className="panel endpoint-card">
            <div className="panel-title"><div><small>{meta.payment.enabled ? "x402 paid endpoint" : "HTTP endpoint"}</small><h3>{meta.payment.enabled ? "Pay with an agent" : "Start querying"}</h3></div><span className="method-pill">GET</span></div>
            <code className="endpoint-path">{apiPath}</code>
            <div className="example-tabs"><span>cURL</span></div>
            <pre>{examples.curl}</pre>
            <button className="copy-wide" onClick={() => copy("curl", examples.curl)}>{copied === "curl" ? "✓ Copied" : "Copy cURL"}</button>
            <div className="example-tabs"><span>Consumer agent</span></div>
            <pre>{examples.agent}</pre>
            <button className="copy-wide" onClick={() => copy("agent", examples.agent)}>{copied === "agent" ? "✓ Copied" : "Copy agent command"}</button>
          </section>

          <section className="panel vault-list">
            <div className="panel-title"><h3>Included vaults</h3><span>{meta.contracts.length}</span></div>
            {meta.contracts.map((contract) => <div key={contract.address}><i /><span><strong>{contract.label ?? "ERC-4626 vault"}</strong><code title={contract.address}>{shortHex(contract.address, 10, 8)}</code></span></div>)}
          </section>

          <section className="phase-two-card"><span>02</span><div><small>Phase 2 active</small><strong>x402 access on Hedera.</strong><p>Metadata stays free. Raw events and hourly flows settle through Blocky402.</p></div></section>
        </aside>
      </div>
    </main>
  );
}

function EventsTable({ events, syncing, locked, purchasing, onPurchase }: { events: ValidationEvent[]; syncing: boolean; locked: boolean; purchasing: boolean; onPurchase: () => void }) {
  if (events.length === 0) return <EmptyState syncing={syncing} locked={locked} label="events" purchasing={purchasing} onPurchase={onPurchase} />;
  return <div className="table-scroll"><table><thead><tr><th>Event</th><th>Vault</th><th>Owner</th><th>Assets (raw)</th><th>Shares (raw)</th><th>Block / time</th></tr></thead><tbody>{events.map((event) => <tr key={event.eventId}><td><span className={`event-chip ${event.eventType.toLowerCase()}`}>{event.eventType}</span></td><td><code title={event.vaultAddress}>{shortHex(event.vaultAddress)}</code></td><td><code title={event.ownerAddress}>{shortHex(event.ownerAddress)}</code></td><td className="amount" title={event.assetsRaw}>{formatRaw(event.assetsRaw)}</td><td className="amount" title={event.sharesRaw}>{formatRaw(event.sharesRaw)}</td><td><strong>{Number(event.blockNumber).toLocaleString()}</strong><small>{new Date(event.blockTime).toLocaleString()}</small></td></tr>)}</tbody></table></div>;
}

function FlowsTable({ flows, syncing, locked, purchasing, onPurchase }: { flows: HourlyFlow[]; syncing: boolean; locked: boolean; purchasing: boolean; onPurchase: () => void }) {
  if (flows.length === 0) return <EmptyState syncing={syncing} locked={locked} label="hourly flow rows" purchasing={purchasing} onPurchase={onPurchase} />;
  return <div className="table-scroll"><table><thead><tr><th>Hour</th><th>Vault</th><th>Inflow (raw)</th><th>Outflow (raw)</th><th>Net (raw)</th><th>Events</th><th>Owners</th></tr></thead><tbody>{flows.map((flow) => <tr key={`${flow.vaultAddress}:${flow.hourStart}`}><td><strong>{new Date(flow.hourStart).toLocaleDateString()}</strong><small>{new Date(flow.hourStart).toLocaleTimeString()}</small></td><td><code>{shortHex(flow.vaultAddress)}</code></td><td className="positive">+{formatRaw(flow.inflowAssetsRaw)}</td><td className="negative">−{formatRaw(flow.outflowAssetsRaw)}</td><td className="amount">{formatRaw(flow.netAssetsRaw)}</td><td>{Number(flow.depositCount) + Number(flow.withdrawalCount)}</td><td>{flow.uniqueOwners}</td></tr>)}</tbody></table></div>;
}

function EmptyState({ syncing, locked = false, label, purchasing = false, onPurchase }: { syncing: boolean; locked?: boolean; label: string; purchasing?: boolean; onPurchase?: () => void }) {
  if (locked) return <div className="empty-state"><span>402</span><strong>Payment required</strong><small>Pay 0.001 testnet HBAR with the isolated demo agent and display these {label} here.</small><button className="primary-button demo-pay-button" type="button" disabled={purchasing} onClick={onPurchase}>{purchasing ? <><i className="spinner" /> Settling payment…</> : <>Pay 0.001 HBAR & load data <b>→</b></>}</button><em>One click creates one testnet payment.</em></div>;
  return <div className="empty-state"><span>{syncing ? "◌" : "◇"}</span><strong>{syncing ? "Dataset is synchronizing" : `No ${label} yet`}</strong><small>{syncing ? "The Substreams sink is advancing from the configured start block." : "New matching Base activity will appear here automatically."}</small></div>;
}

function SchemaView({ schema }: { schema: DatasetSchema | null }) {
  if (schema === null) return <EmptyState syncing label="schema" />;
  return <div className="schema-view">{Object.entries(schema.resources).map(([resource, fields]) => <section className="schema-resource" key={resource}><h3>/{resource}</h3><div className="schema-fields">{fields.map((field) => <code key={field}>{field}</code>)}</div></section>)}</div>;
}

function formatHbar(tinybars: string): string {
  const padded = tinybars.padStart(9, "0");
  const whole = padded.slice(0, -8);
  const fractional = padded.slice(-8).replace(/0+$/, "");
  return fractional.length === 0 ? whole : `${whole}.${fractional}`;
}
