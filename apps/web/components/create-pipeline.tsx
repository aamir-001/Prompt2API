"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { api, ApiError, type Pipeline } from "../lib/api";

const EXAMPLE = "Track Deposit and Withdraw events for ERC-4626 vault 0x050ce30b927da55177a4914ec73480238bad56f0 on Base starting at block 50999146. Normalize the events and expose raw records and hourly net flows.";

export function CreatePipeline() {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [showOverrides, setShowOverrides] = useState(false);
  const [addresses, setAddresses] = useState(["", "", ""]);
  const [startBlock, setStartBlock] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const contracts = addresses
        .map((address) => address.trim())
        .filter(Boolean)
        .map((address, index) => ({ address, label: `Vault ${index + 1}` }));
      const overrides = {
        ...(contracts.length > 0 ? { contracts } : {}),
        ...(startBlock.trim() ? { startBlock: Number(startBlock) } : {}),
      };
      const pipeline = await api<Pipeline>("/v1/pipelines/plan", {
        method: "POST",
        acceptedStatuses: [422],
        body: JSON.stringify({
          prompt,
          ...(Object.keys(overrides).length > 0 ? { overrides } : {}),
        }),
      });
      router.push(`/pipelines/${pipeline.pipelineId}`);
    } catch (caught) {
      setError(
        caught instanceof ApiError
          ? `${caught.code}: ${caught.message}`
          : caught instanceof Error
            ? caught.message
            : "Unable to generate the plan",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="composer-card">
      <div className="scope-strip">
        <span className="scope-icon" aria-hidden="true">◆</span>
        <p><strong>Phase 1 scope</strong> Base mainnet · ERC-4626 · Deposit &amp; Withdraw · 1–3 vaults</p>
        <span className="scope-badge">Focused</span>
      </div>
      <form onSubmit={submit}>
        <label className="field-label" htmlFor="pipeline-prompt">
          Describe your data pipeline <span>Natural language</span>
        </label>
        <div className="prompt-wrap">
          <textarea
            id="pipeline-prompt"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="e.g. Track Deposit and Withdraw events for these ERC-4626 vaults on Base…"
            minLength={1}
            maxLength={4_000}
            required
          />
          <div className="prompt-tools">
            <button type="button" className="text-button" onClick={() => setPrompt(EXAMPLE)}>
              <SparkIcon /> Use example
            </button>
            <span>{prompt.length.toLocaleString()} / 4,000</span>
          </div>
        </div>

        <button
          className="override-toggle"
          type="button"
          onClick={() => setShowOverrides((visible) => !visible)}
          aria-expanded={showOverrides}
        >
          <span><SlidersIcon /> Structured overrides <small>Optional recovery controls</small></span>
          <i className={showOverrides ? "chevron open" : "chevron"}>⌄</i>
        </button>

        {showOverrides ? (
          <div className="override-panel">
            <div className="address-grid">
              {addresses.map((address, index) => (
                <label key={index}>
                  Vault address {index + 1}
                  <input
                    value={address}
                    onChange={(event) => {
                      const next = [...addresses];
                      next[index] = event.target.value;
                      setAddresses(next);
                    }}
                    placeholder="0x…"
                    spellCheck={false}
                  />
                </label>
              ))}
            </div>
            <label className="block-field">
              Start block
              <input
                type="number"
                min="0"
                step="1"
                value={startBlock}
                onChange={(event) => setStartBlock(event.target.value)}
                placeholder="e.g. 50999146"
              />
            </label>
          </div>
        ) : null}

        {error ? <div className="error-banner" role="alert"><span>!</span><span>{error}{error.startsWith("OPERATOR_AUTH_REQUIRED") ? <> · <a href="/operator">Unlock operator access</a></> : null}</span></div> : null}

        <div className="composer-footer">
          <p><ShieldIcon /> Gemini extracts configuration only. It never writes or executes code.</p>
          <button className="primary-button" type="submit" disabled={submitting || !prompt.trim()}>
            {submitting ? <><Spinner /> Planning…</> : <>Generate plan <span>→</span></>}
          </button>
        </div>
      </form>
    </section>
  );
}

function SparkIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2l1.5 5.2L19 9l-5.5 1.8L12 16l-1.5-5.2L5 9l5.5-1.8L12 2Z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z" /></svg>;
}

function SlidersIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6" /></svg>;
}

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.6 2.9 8.2 7 10 4.1-1.8 7-5.4 7-10V6l-7-3Z" /><path d="m9 12 2 2 4-5" /></svg>;
}

function Spinner() {
  return <span className="spinner" aria-hidden="true" />;
}
