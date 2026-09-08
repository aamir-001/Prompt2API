import {
  normalizePipelineSpec,
  parsePipelineSpec,
  type PipelineSpec,
} from "@indexloom/contracts";
import { toEventSelector } from "viem";

export const ERC4626_EVENTS = {
  Deposit: {
    type: "event",
    name: "Deposit",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
  Withdraw: {
    type: "event",
    name: "Withdraw",
    inputs: [
      { name: "sender", type: "address", indexed: true },
      { name: "receiver", type: "address", indexed: true },
      { name: "owner", type: "address", indexed: true },
      { name: "assets", type: "uint256", indexed: false },
      { name: "shares", type: "uint256", indexed: false },
    ],
  },
} as const;

export const ERC4626_EVENT_TOPICS = {
  Deposit: toEventSelector(ERC4626_EVENTS.Deposit),
  Withdraw: toEventSelector(ERC4626_EVENTS.Withdraw),
} as const;

export interface DerivedPipelineConfig {
  pipelineId: string;
  pipelineVersion: number;
  slug: string;
  packageName: string;
  schemaName: string;
  normalizedSpec: PipelineSpec;
  eventTopics: string[];
  filter: string;
}

export interface DerivationOptions {
  pipelineId: string;
  pipelineVersion?: number;
}

function safeIdentifier(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalized || "erc4626_vault_flows";
}

function validatePipelineId(pipelineId: string): string {
  if (!/^pl_[a-z0-9]{8,32}$/.test(pipelineId)) {
    throw new Error("pipelineId must match pl_[a-z0-9]{8,32}");
  }
  return pipelineId;
}

export function derivePipelineConfig(
  input: unknown,
  options: DerivationOptions,
): DerivedPipelineConfig {
  const spec = normalizePipelineSpec(parsePipelineSpec(input));
  const pipelineId = validatePipelineId(options.pipelineId);
  const pipelineVersion = options.pipelineVersion ?? 1;
  if (!Number.isSafeInteger(pipelineVersion) || pipelineVersion < 1) {
    throw new Error("pipelineVersion must be a positive safe integer");
  }

  const slug = `${safeIdentifier(spec.displayName).replaceAll("_", "-")}-${pipelineId.slice(3)}`;
  const packageName = `${safeIdentifier(spec.displayName)}_${pipelineId.slice(3)}`;
  const schemaName = `dataset_${pipelineId}`;
  const addresses = spec.contracts.map(({ address }) => `evt_addr:${address}`);
  const eventTopics = spec.events.map((event) => ERC4626_EVENT_TOPICS[event]);
  const topics = eventTopics.map((topic) => `evt_sig:${topic}`);

  return {
    pipelineId,
    pipelineVersion,
    slug,
    packageName,
    schemaName,
    normalizedSpec: spec,
    eventTopics,
    filter: `(${addresses.join(" || ")}) &&\n(${topics.join(" || ")})`,
  };
}
