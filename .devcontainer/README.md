# IndexLoom development container

This container provides the Linux toolchain required to build and run the
IndexLoom Phase 1 Substreams pipeline:

- Substreams CLI 1.22.0
- Rust with the `wasm32-unknown-unknown` target
- Buf 1.72.0 and `protoc`
- Node.js 22 and pnpm 10
- PostgreSQL client tools

## Open the project

1. Start Docker Desktop.
2. Open this repository in VS Code.
3. Run **Dev Containers: Reopen in Container** from the command palette.
4. Wait for the toolchain checks, dependency installation, and Prisma client
   generation to complete.

The container stores `node_modules` in Docker volumes. This prevents Windows
pnpm junctions from being reused inside Linux. If dependencies were previously
installed before these mounts were added, run **Dev Containers: Rebuild
Container** once so the volumes are attached.

## Connect to PostgreSQL on Windows

Docker Desktop exposes the Windows host as `host.docker.internal`. When the
API runs inside this container, use that hostname in both database URLs:

```dotenv
DATABASE_URL=postgresql://postgres:YOUR_URL_ENCODED_PASSWORD@host.docker.internal:5432/indexloom?sslmode=disable
DATASET_DATABASE_URL=postgresql://postgres:YOUR_URL_ENCODED_PASSWORD@host.docker.internal:5432/indexloom?sslmode=disable
```

Do not commit `.env` or copy credentials into this directory.
