import { z } from "zod";
import { consumerConfig } from "./config.js";
import { requestPaidDataset } from "./client.js";

const ArgumentsSchema = z.tuple([
  z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  z.enum(["events", "hourly-flows"]).default("events"),
]);

async function main(): Promise<void> {
  const argumentsAfterSeparator = process.argv.slice(2).filter((value) => value !== "--");
  const [slug, resource] = ArgumentsSchema.parse([
    argumentsAfterSeparator[0],
    argumentsAfterSeparator[1] ?? "events",
  ]);
  const result = await requestPaidDataset(consumerConfig, slug, resource);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Paid request failed");
  process.exitCode = 1;
});
