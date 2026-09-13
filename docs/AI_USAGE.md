# AI usage disclosure

Prompt2API uses AI in two distinct contexts: Gemini is a runtime component of the product, while an AI coding assistant helped develop and review the repository. Neither is permitted to become an unvalidated code-execution path.

## Runtime AI: Gemini planner

The backend implementation in `packages/planner` uses the official `@google/genai` SDK with `gemini-3-flash-preview`. The browser never receives `GEMINI_API_KEY` and never calls Gemini directly.

Gemini receives:

- the user's natural-language request;
- prompt version `v1`; and
- a JSON Schema derived from the strict Zod `PlannerResultSchema`.

It must return exactly one structured outcome:

| Outcome | Meaning | Example request |
| --- | --- | --- |
| `ready` | All required, supported configuration is present. | “Track Deposit and Withdraw for ERC-4626 vault `0x050c…56f0` on Base from block `50999146`.” |
| `needs_clarification` | An essential vault address, start block, or event choice is missing or ambiguous. | “Track my Base ERC-4626 vault.” |
| `unsupported` | The requested chain, standard, or event type is outside Phase 1. | “Track NFT sales and governance votes.” |

The UI makes all three outcomes inspectable. A `ready` result shows the entire validated `PipelineSpec` before the build button is available. Clarification and unsupported results show the model's focused questions or reason and do not queue a build.

## Safety boundary

Gemini may propose only the small `PipelineSpec`: display name, Base chain identifier, ERC-4626 standard, one to three vault addresses, start block, Deposit/Withdraw selection, and raw/hourly output selection.

After the response, the backend:

1. parses it with strict Zod schemas that reject unknown fields;
2. normalizes and validates every address with `viem`;
3. enforces Base, ERC-4626, event, block, address-count, and prompt-length limits;
4. derives topics, filters, identifiers, paths, package parameters, and process arguments in reviewed TypeScript; and
5. renders only allowlisted files from the reviewed ERC-4626 template.

Gemini cannot return Rust, SQL, shell commands, dependencies, package names, file paths, provider endpoints, event topics, or credentials. No unvalidated model output is passed to a command or child process. Provider failures never create a default plan, and schema-valid `unsupported` results are not retried.

The default test suite uses mocked planner responses and consumes no Gemini quota. One live golden planner request is opt-in through `RUN_LIVE_GEMINI_TEST=1`.

## Development-time AI assistance

OpenAI Codex was used as a coding assistant to inspect the existing repository, implement targeted TypeScript/React/documentation changes, run tests and builds, and review the resulting diff. All executable behavior remains in version-controlled source and is subject to the same repository tests and human review.

No official sponsor-provided Substreams Skill is claimed for this implementation. The project reused the documented `ethereum-common` package, The Graph provider interface, Substreams CLI, and official SDKs directly. This disclosure avoids implying that a Skill was used merely because it exists.
