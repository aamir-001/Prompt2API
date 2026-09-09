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

export function DatasetConsole({ slug }: { slug: string }) {
  const [meta, setMeta] = useState<DatasetMeta | null>(null);
  const [schema, setSchema] = useState<DatasetSchema | null>(null);
  const [events, setEvents] = useState<ValidationEvent[]>([]);
  const [flows, setFlows] = useState<HourlyFlow[]>([]);
  const [tab, setTab] = useState<"events" | "flows" | "schema">("events");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const nextMeta = await api<DatasetMeta>(`/v1/datasets/${slug}/meta`);
      setMeta(nextMeta);
      setSchema(await api<DatasetSchema>(`/v1/datasets/${slug}/schema`));
      if (nextMeta.status === "LIVE") {
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
    typescript: `const response = await fetch("http://localhost:4000${apiPath}");\nconst page = await response.json();\nconsole.log(page.items);`,
  }), [apiPath]);

  function copy(key: string, value: string) {
    void navigator.clipboard.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied(null), 1_500);
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

      {error ? <div className="error-banner"><span>!</span>{error}</div> : null}

      <section className="metric-grid">
        <div className="metric-card"><small>Network</small><strong><i className="base-orb" />Base mainnet</strong><span>Chain ID 8453</span></div>
        <div className="metric-card"><small>Indexed through</small><strong>{meta.indexedThroughBlock ? Number(meta.indexedThroughBlock).toLocaleString() : "Syncing…"}</strong><span>Block cursor</span></div>
        <div className="metric-card"><small>Vault contracts</small><strong>{meta.contracts.length}</strong><span>{meta.events.join(" + ")}</span></div>
        <div className="metric-card accent"><small>Dataset version</small><strong>v{meta.version}</strong><span>Raw integer units</span></div>
      </section>

      <div className="dataset-layout">
        <section className="dataset-main">
          <div className="dataset-tabs" role="tablist">
            <button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}>Raw events <span>{events.length}</span></button>
            <button className={tab === "flows" ? "active" : ""} onClick={() => setTab("flows")}>Hourly flows <span>{flows.length}</span></button>
            <button className={tab === "schema" ? "active" : ""} onClick={() => setTab("schema")}>API schema</button>
          </div>

          <div className="panel dataset-table-panel">
            {tab === "events" ? <EventsTable events={events} syncing={meta.status !== "LIVE"} /> : null}
            {tab === "flows" ? <FlowsTable flows={flows} syncing={meta.status !== "LIVE"} /> : null}
            {tab === "schema" ? <SchemaView schema={schema} /> : null}
          </div>
        </section>

        <aside className="dataset-aside">
          <section className="panel endpoint-card">
            <div className="panel-title"><div><small>HTTP endpoint</small><h3>Start querying</h3></div><span className="method-pill">GET</span></div>
            <code className="endpoint-path">{apiPath}</code>
            <div className="example-tabs"><span>cURL</span></div>
            <pre>{examples.curl}</pre>
            <button className="copy-wide" onClick={() => copy("curl", examples.curl)}>{copied === "curl" ? "✓ Copied" : "Copy cURL"}</button>
            <div className="example-tabs"><span>TypeScript</span></div>
            <pre>{examples.typescript}</pre>
            <button className="copy-wide" onClick={() => copy("ts", examples.typescript)}>{copied === "ts" ? "✓ Copied" : "Copy TypeScript"}</button>
          </section>

          <section className="panel vault-list">
            <div className="panel-title"><h3>Included vaults</h3><span>{meta.contracts.length}</span></div>
            {meta.contracts.map((contract) => <div key={contract.address}><i /><span><strong>{contract.label ?? "ERC-4626 vault"}</strong><code title={contract.address}>{shortHex(contract.address, 10, 8)}</code></span></div>)}
          </section>

          <section className="phase-two-card"><span>02</span><div><small>Next phase</small><strong>Paid access coming next.</strong><p>x402 metering on Hedera will wrap these same data routes.</p></div></section>
        </aside>
      </div>
    </main>
  );
}

function EventsTable({ events, syncing }: { events: ValidationEvent[]; syncing: boolean }) {
  if (events.length === 0) return <EmptyState syncing={syncing} label="events" />;
  return <div className="table-scroll"><table><thead><tr><th>Event</th><th>Vault</th><th>Owner</th><th>Assets (raw)</th><th>Shares (raw)</th><th>Block / time</th></tr></thead><tbody>{events.map((event) => <tr key={event.eventId}><td><span className={`event-chip ${event.eventType.toLowerCase()}`}>{event.eventType}</span></td><td><code title={event.vaultAddress}>{shortHex(event.vaultAddress)}</code></td><td><code title={event.ownerAddress}>{shortHex(event.ownerAddress)}</code></td><td className="amount" title={event.assetsRaw}>{formatRaw(event.assetsRaw)}</td><td className="amount" title={event.sharesRaw}>{formatRaw(event.sharesRaw)}</td><td><strong>{Number(event.blockNumber).toLocaleString()}</strong><small>{new Date(event.blockTime).toLocaleString()}</small></td></tr>)}</tbody></table></div>;
}

function FlowsTable({ flows, syncing }: { flows: HourlyFlow[]; syncing: boolean }) {
  if (flows.length === 0) return <EmptyState syncing={syncing} label="hourly flow rows" />;
  return <div className="table-scroll"><table><thead><tr><th>Hour</th><th>Vault</th><th>Inflow (raw)</th><th>Outflow (raw)</th><th>Net (raw)</th><th>Events</th><th>Owners</th></tr></thead><tbody>{flows.map((flow) => <tr key={`${flow.vaultAddress}:${flow.hourStart}`}><td><strong>{new Date(flow.hourStart).toLocaleDateString()}</strong><small>{new Date(flow.hourStart).toLocaleTimeString()}</small></td><td><code>{shortHex(flow.vaultAddress)}</code></td><td className="positive">+{formatRaw(flow.inflowAssetsRaw)}</td><td className="negative">−{formatRaw(flow.outflowAssetsRaw)}</td><td className="amount">{formatRaw(flow.netAssetsRaw)}</td><td>{Number(flow.depositCount) + Number(flow.withdrawalCount)}</td><td>{flow.uniqueOwners}</td></tr>)}</tbody></table></div>;
}

function EmptyState({ syncing, label }: { syncing: boolean; label: string }) {
  return <div className="empty-state"><span>{syncing ? "◌" : "◇"}</span><strong>{syncing ? "Dataset is synchronizing" : `No ${label} yet`}</strong><small>{syncing ? "The Substreams sink is advancing from the configured start block." : "New matching Base activity will appear here automatically."}</small></div>;
}

function SchemaView({ schema }: { schema: DatasetSchema | null }) {
  if (schema === null) return <EmptyState syncing label="schema" />;
  return <div className="schema-view">{Object.entries(schema.resources).map(([resource, fields]) => <section className="schema-resource" key={resource}><h3>/{resource}</h3><div className="schema-fields">{fields.map((field) => <code key={field}>{field}</code>)}</div></section>)}</div>;
}
