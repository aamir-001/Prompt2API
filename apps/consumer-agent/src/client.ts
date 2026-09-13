import { x402Client } from "@x402/core/client";
import type { PaymentPolicy } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import { wrapFetchWithPayment, decodePaymentResponseHeader } from "@x402/fetch";
import {
  createClientHederaSigner,
  PrivateKey,
} from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { ConsumerConfig } from "./config.js";

const DATASET_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HEDERA_ENTITY_ID = /^0\.0\.[1-9]\d*$/;

export type PaidResource = "events" | "hourly-flows";

export interface PaidDatasetResult {
  data: unknown;
  payment: {
    success: boolean;
    transaction: string;
    network: string;
    amount?: string | undefined;
    payer?: string | undefined;
    hashscanUrl: string;
  };
}

export function buildDatasetUrl(
  apiUrl: string,
  slug: string,
  resource: PaidResource,
): string {
  if (!DATASET_SLUG.test(slug)) throw new Error("Invalid dataset slug");
  const path = resource === "events" ? "events" : "flows/hourly";
  return `${apiUrl.replace(/\/$/, "")}/v1/datasets/${slug}/${path}?limit=25`;
}

export function createRequirementPolicy(
  config: Pick<ConsumerConfig, "network" | "asset" | "maxAmount" | "expectedPayTo">,
): PaymentPolicy {
  return (version, requirements) => {
    if (version !== 2) throw new Error("Prompt2API only accepts x402 v2 requirements");
    const accepted = requirements.filter((requirement) =>
      isAllowedRequirement(requirement, config),
    );
    if (accepted.length === 0) {
      throw new Error(
        "Payment requirements failed the network, scheme, asset, recipient, fee-payer, or amount policy",
      );
    }
    return accepted;
  };
}

function isAllowedRequirement(
  requirement: PaymentRequirements,
  config: Pick<ConsumerConfig, "network" | "asset" | "maxAmount" | "expectedPayTo">,
): boolean {
  if (
    requirement.network !== config.network ||
    requirement.scheme !== "exact" ||
    requirement.asset !== config.asset ||
    requirement.payTo !== config.expectedPayTo ||
    !/^[1-9]\d*$/.test(requirement.amount) ||
    BigInt(requirement.amount) > BigInt(config.maxAmount)
  ) {
    return false;
  }
  const feePayer = requirement.extra.feePayer;
  return typeof feePayer === "string" && HEDERA_ENTITY_ID.test(feePayer);
}

export function createPaidFetch(config: ConsumerConfig): typeof globalThis.fetch {
  const signer = createClientHederaSigner(
    config.payerAccountId,
    PrivateKey.fromStringECDSA(config.payerPrivateKey),
    { network: config.network },
  );
  const client = new x402Client()
    .register(config.network, new ExactHederaScheme(signer))
    .setSpendControls({
      maxAmountPerPayment: false,
      allowedAssets: [{
        network: config.network,
        asset: config.asset,
        maxAmountPerPayment: config.maxAmount,
      }],
    })
    .registerPolicy(createRequirementPolicy(config));
  return wrapFetchWithPayment(globalThis.fetch, client);
}

export async function requestPaidDataset(
  config: ConsumerConfig,
  slug: string,
  resource: PaidResource,
): Promise<PaidDatasetResult> {
  const response = await createPaidFetch(config)(
    buildDatasetUrl(config.apiUrl, slug, resource),
    { headers: { accept: "application/json" } },
  );
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    throw new Error(`Paid dataset request failed (${response.status}): ${JSON.stringify(body)}`);
  }
  const paymentHeader = response.headers.get("payment-response");
  if (paymentHeader === null) {
    throw new Error("Paid response did not include a PAYMENT-RESPONSE receipt");
  }
  const settlement = decodePaymentResponseHeader(paymentHeader);
  if (!settlement.success || settlement.network !== config.network) {
    throw new Error("Facilitator returned an unsuccessful or unexpected settlement receipt");
  }
  return {
    data: body,
    payment: {
      success: settlement.success,
      transaction: settlement.transaction,
      network: settlement.network,
      ...(settlement.amount === undefined ? {} : { amount: settlement.amount }),
      ...(settlement.payer === undefined ? {} : { payer: settlement.payer }),
      hashscanUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(settlement.transaction)}`,
    },
  };
}
