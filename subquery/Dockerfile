# ──────────────────────────────────────────────────────────────────────────────
# TrustLend — SubQuery Soroban Indexer Dockerfile
# ──────────────────────────────────────────────────────────────────────────────
# Multi-stage build:
#   1. Install dependencies and build the SubQuery project (codegen + compile)
#   2. Run with the official @subql/node-stellar image
# ──────────────────────────────────────────────────────────────────────────────

# ── Stage 1: Builder ──────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /subquery

# Install build toolchain
RUN apk add --no-cache python3 make g++ git

# Copy SubQuery project files
COPY subquery/package.json subquery/tsconfig.json ./
COPY subquery/src/ ./src/
COPY project.yaml ./project.yaml
COPY schema.graphql ./schema.graphql

# Install dependencies
RUN npm ci --ignore-scripts

# Generate GraphQL types and compile TypeScript mappings
RUN npx subql codegen
RUN npx subql build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM onfinality/subql-node-stellar:latest AS runner

LABEL org.opencontainers.image.source="https://github.com/thisisouvik/trustlend-stellar"
LABEL org.opencontainers.image.description="TrustLend Soroban SubQuery Indexer"
LABEL org.opencontainers.image.licenses="MIT"

# Copy the built project from the builder stage
COPY --from=builder /subquery/dist/ /app/dist/
COPY --from=builder /subquery/project.yaml /app/project.yaml
COPY --from=builder /subquery/schema.graphql /app/schema.graphql

# The official subql-node-stellar image expects the project at /app
WORKDIR /app

# Default command — override via docker-compose or CLI
CMD ["-f=/app", "--db-schema=trustlend"]
