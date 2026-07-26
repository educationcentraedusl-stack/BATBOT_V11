# ==========================================
# BATBOT_V11 MULTI-STAGE PRODUCTION DOCKERFILE
# ==========================================

# STAGE 1: Build Stage (Rust N-API Native Compilation + TypeScript Compilation)
FROM node:22-slim AS builder

# Install System Dependencies & Rust Toolchain
RUN apt-get update && apt-get install -y \
    curl \
    build-essential \
    python3 \
    pkg-config \
    libssl-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust Compiler & Cargo
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/root/.cargo/bin:${PATH}"

WORKDIR /app

# Copy Manifest Files
COPY package.json package-lock.json* ./
COPY Cargo.toml Cargo.lock build.rs ./

# Install Dependencies
RUN npm ci || npm install

# Copy Source Code
COPY src ./src
COPY index.js index.d.ts ./

# Build Native Rust Module and TypeScript Artifacts
RUN npm run build:rust
RUN npm run build:ts

# Prune devDependencies
RUN npm prune --production

# ==========================================
# STAGE 2: Production Runtime Stage
# ==========================================
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy Built Artifacts and Production Dependencies
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/index.js ./
COPY --from=builder /app/index.d.ts ./
COPY --from=builder /app/*.node ./

# Expose Telemetry WebSocket Port & System API Port
EXPOSE 8080 5000

# Healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "process.exit(0)"

# Default Command
CMD ["node", "dist/index.js"]
