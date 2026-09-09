"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

export function OperatorLogin() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/operator/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      if (!response.ok) throw new Error("The operator token was not accepted.");
      router.push("/");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to unlock operator access");
    } finally {
      setBusy(false);
    }
  }

  return <main className="page-shell operator-shell">
    <section className="operator-card">
      <span className="operator-lock">◇</span>
      <div className="eyebrow"><span>Protected control plane</span><i /></div>
      <h1>Operator access</h1>
      <p>Pipeline creation compiles and deploys infrastructure, so it is never exposed as an anonymous public action.</p>
      <form onSubmit={submit}>
        <label htmlFor="operator-token">Operator token</label>
        <input id="operator-token" type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="current-password" required placeholder="Enter OPERATOR_API_TOKEN" />
        {error ? <div className="error-banner"><span>!</span>{error}</div> : null}
        <button className="primary-button" disabled={busy}>{busy ? "Checking…" : "Unlock builder →"}</button>
      </form>
      <Link href="/">← Back to IndexLoom</Link>
    </section>
  </main>;
}
