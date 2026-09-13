import express from "express";
import type { FacilitatorClient } from "@x402/core/server";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import type {
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  SupportedResponse,
  VerifyResponse,
} from "@x402/core/types";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createDatasetPaymentGate, type DatasetPaymentConfiguration } from "./payment.js";

const config: DatasetPaymentConfiguration = {
  enabled: true,
  network: "hedera:testnet",
  scheme: "exact",
  asset: "0.0.0",
  amount: "100000",
  payTo: "0.0.10442846",
  facilitatorUrl: "https://facilitator.invalid",
  maxTimeoutSeconds: 300,
  facilitatorTimeoutMs: 1_000,
};

class FakeFacilitator implements FacilitatorClient {
  readonly settledTransactions = new Set<string>();
  verifyCalls = 0;
  settleCalls = 0;

  async getSupported(): Promise<SupportedResponse> {
    return {
      kinds: [{
        x402Version: 2,
        scheme: "exact",
        network: "hedera:testnet",
        extra: { feePayer: "0.0.9876" },
      }],
      extensions: [],
      signers: { "hedera:testnet": ["0.0.9876"] },
    };
  }

  async verify(payload: PaymentPayload): Promise<VerifyResponse> {
    this.verifyCalls += 1;
    const transaction = (payload.payload as { transaction?: unknown }).transaction;
    if (typeof transaction !== "string" || this.settledTransactions.has(transaction)) {
      return { isValid: false, invalidReason: "payment_already_settled" };
    }
    return { isValid: true, payer: "0.0.1111" };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    this.settleCalls += 1;
    const transaction = (payload.payload as { transaction: string }).transaction;
    this.settledTransactions.add(transaction);
    return {
      success: true,
      payer: "0.0.1111",
      transaction: "0.0.9876@1788900000.000000001",
      network: requirements.network,
      amount: requirements.amount,
    };
  }
}

describe("Hedera x402 dataset gate", () => {
  it("keeps metadata free and challenges data routes with v2 requirements", async () => {
    const facilitator = new FakeFacilitator();
    const gate = createDatasetPaymentGate(config, {
      facilitator,
      syncFacilitatorOnStart: false,
    })!;
    await gate.ready;
    const app = express();
    app.use(gate.middleware);
    app.get("/v1/datasets/:slug/meta", (_req, res) => res.json({ status: "LIVE" }));
    app.get("/v1/datasets/:slug/events", (_req, res) => res.json({ items: [] }));

    await request(app).get("/v1/datasets/demo/meta").expect(200);
    expect(facilitator.verifyCalls).toBe(0);

    const unpaid = await request(app)
      .get("/v1/datasets/demo/events")
      .set("accept", "application/json")
      .expect(402);
    const header = unpaid.headers["payment-required"] as string;
    const required = decodePaymentRequiredHeader(header);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toEqual([
      expect.objectContaining({
        scheme: "exact",
        network: "hedera:testnet",
        asset: "0.0.0",
        amount: "100000",
        payTo: "0.0.10442846",
        extra: expect.objectContaining({ feePayer: "0.0.9876" }),
      }),
    ]);
  });

  it("settles a valid payload once and rejects replay", async () => {
    const facilitator = new FakeFacilitator();
    const gate = createDatasetPaymentGate(config, {
      facilitator,
      syncFacilitatorOnStart: false,
    })!;
    await gate.ready;
    const app = express();
    app.use(gate.middleware);
    app.get("/v1/datasets/:slug/events", (_req, res) => res.json({ items: ["paid"] }));

    const unpaid = await request(app)
      .get("/v1/datasets/demo/events")
      .set("accept", "application/json")
      .expect(402);
    const required = decodePaymentRequiredHeader(
      unpaid.headers["payment-required"] as string,
    );
    const payload: PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0]!,
      payload: { transaction: "dGVzdC10cmFuc2FjdGlvbg==" },
      extensions: {},
    };
    const signature = encodePaymentSignatureHeader(payload);

    const paid = await request(app)
      .get("/v1/datasets/demo/events")
      .set("accept", "application/json")
      .set("payment-signature", signature)
      .expect(200);
    expect(paid.body.items).toEqual(["paid"]);
    const receipt = decodePaymentResponseHeader(
      paid.headers["payment-response"] as string,
    );
    expect(receipt).toEqual(expect.objectContaining({
      success: true,
      amount: "100000",
      network: "hedera:testnet",
    }));
    expect(facilitator.settleCalls).toBe(1);

    await request(app)
      .get("/v1/datasets/demo/events")
      .set("accept", "application/json")
      .set("payment-signature", signature)
      .expect(402);
    expect(facilitator.settleCalls).toBe(1);
  });
});
