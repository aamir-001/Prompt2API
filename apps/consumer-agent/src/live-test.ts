import { consumerConfig } from "./config.js";
import { requestPaidDataset } from "./client.js";

async function main(): Promise<void> {
  if (process.env.RUN_LIVE_X402_TEST !== "1") {
    console.log("SKIP: set RUN_LIVE_X402_TEST=1 to authorize one real testnet payment");
    return;
  }
  const slug = process.argv.slice(2).find((value) => value !== "--");
  if (slug === undefined) throw new Error("Usage: pnpm test:live <dataset-slug>");
  const result = await requestPaidDataset(consumerConfig, slug, "events");
  console.log(JSON.stringify({ payment: result.payment }, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Live x402 test failed");
  process.exitCode = 1;
});
