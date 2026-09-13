#!/usr/bin/env bash

set -euo pipefail

dependency_directories=(
  node_modules
  apps/api/node_modules
  apps/consumer-agent/node_modules
  apps/web/node_modules
  packages/contracts/node_modules
  packages/dataset-service/node_modules
  packages/db/node_modules
  packages/generator/node_modules
  packages/pipeline-config/node_modules
  packages/planner/node_modules
  packages/substreams-runner/node_modules
)

sudo chown -R vscode:vscode "${dependency_directories[@]}"

rustup target add wasm32-unknown-unknown
substreams --version
rustc --version
cargo --version
buf --version
node --version
pnpm --version

pnpm install --frozen-lockfile
pnpm --filter @prompt2api/db prisma:generate
