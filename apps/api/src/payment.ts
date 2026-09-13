import type { RequestHandler } from "express";
import type { FacilitatorClient, RoutesConfig } from "@x402/core/server";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactHederaScheme } from "@x402/hedera/exact/server";

export interface DatasetPaymentConfiguration {
  enabled: boolean;
  network: "hedera:testnet";
  scheme: "exact";
  asset: "0.0.0";
  amount: string;
  payTo: string;
  facilitatorUrl: string;
  maxTimeoutSeconds: number;
  facilitatorTimeoutMs: number;
}

export interface DatasetPaymentMetadata {
  enabled: true;
  protocol: "x402";
  version: 2;
  network: "hedera:testnet";
  scheme: "exact";
  asset: "0.0.0";
  amount: string;
  unit: "tinybar";
  payTo: string;
  protectedResources: readonly ["events", "hourlyFlows"];
}

export interface DatasetPaymentGate {
  middleware: RequestHandler;
  metadata: DatasetPaymentMetadata;
  ready: Promise<void>;
}

interface CreateDatasetPaymentGateOptions {
  facilitator?: FacilitatorClient;
  syncFacilitatorOnStart?: boolean;
}

export function createDatasetPaymentGate(
  config: DatasetPaymentConfiguration,
  options: CreateDatasetPaymentGateOptions = {},
): DatasetPaymentGate | undefined {
  if (!config.enabled) return undefined;

  const facilitator = options.facilitator ?? new HTTPFacilitatorClient({
    url: config.facilitatorUrl,
    timeoutMs: config.facilitatorTimeoutMs,
  });
  const resourceServer = new x402ResourceServer(facilitator).register(
    config.network,
    new ExactHederaScheme(),
  );
  const accepts = {
    scheme: config.scheme,
    payTo: config.payTo,
    price: { asset: config.asset, amount: config.amount },
    network: config.network,
    maxTimeoutSeconds: config.maxTimeoutSeconds,
  } as const;
  const unpaidResponseBody = () => ({
    contentType: "application/json",
    body: {
      error: {
        code: "PAYMENT_REQUIRED",
        message: "This dataset route requires an x402 payment on Hedera testnet",
      },
    },
  });
  const settlementFailedResponseBody = () => ({
    contentType: "application/json",
    body: {
      error: {
        code: "PAYMENT_SETTLEMENT_FAILED",
        message: "The Hedera payment could not be settled",
      },
    },
  });
  const routes: RoutesConfig = {
    "GET /v1/datasets/*/events": {
      accepts,
      description: "Prompt2API ERC-4626 raw events",
      mimeType: "application/json",
      serviceName: "Prompt2API",
      unpaidResponseBody,
      settlementFailedResponseBody,
    },
    "GET /v1/datasets/*/flows/hourly": {
      accepts,
      description: "Prompt2API ERC-4626 hourly vault flows",
      mimeType: "application/json",
      serviceName: "Prompt2API",
      unpaidResponseBody,
      settlementFailedResponseBody,
    },
  };
  const ready = resourceServer.initialize();

  return {
    middleware: paymentMiddleware(
      routes,
      resourceServer,
      undefined,
      undefined,
      options.syncFacilitatorOnStart ?? false,
    ),
    ready,
    metadata: {
      enabled: true,
      protocol: "x402",
      version: 2,
      network: config.network,
      scheme: config.scheme,
      asset: config.asset,
      amount: config.amount,
      unit: "tinybar",
      payTo: config.payTo,
      protectedResources: ["events", "hourlyFlows"],
    },
  };
}
