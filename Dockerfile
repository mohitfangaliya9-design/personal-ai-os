# syntax=docker/dockerfile:1

##############################################
# Build stage
##############################################
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies first so this layer is cached unless manifests change.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
        npm ci; \
    else \
        npm install; \
    fi

# Bring in the rest of the repository.
COPY . .

# The repository currently keeps TypeScript sources and frontend assets at
# the project root, while the build expects sources under src/. Prepare
# that layout deterministically without clobbering a real src/ directory
# if one already exists, and fail clearly if the expected files are missing.
RUN set -eu; \
    if [ -d src ] && [ -n "$(find src -maxdepth 1 -name '*.ts' 2>/dev/null)" ]; then \
        echo "Existing src/ directory with TypeScript sources detected; leaving it as-is."; \
    else \
        root_ts_files=$(find . -maxdepth 1 -name '*.ts'); \
        if [ -z "$root_ts_files" ]; then \
            echo "ERROR: no root-level .ts files found and no existing src/ with sources." >&2; \
            exit 1; \
        fi; \
        mkdir -p src; \
        cp $root_ts_files src/; \
    fi; \
    for asset in index.html app.js styles.css; do \
        if [ ! -f "$asset" ]; then \
            echo "ERROR: expected frontend asset '$asset' not found at project root." >&2; \
            exit 1; \
        fi; \
    done; \
    mkdir -p public; \
    cp index.html app.js styles.css public/

RUN npm run build

##############################################
# Production runtime stage
##############################################
FROM node:20-alpine

WORKDIR /app

# Install only production dependencies, reproducibly when a lockfile exists.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
        npm ci --omit=dev; \
    else \
        npm install --omit=dev; \
    fi \
    && npm cache clean --force

# Bring in only the compiled output and static assets — no source, no
# build caches, no development dependencies, no repository metadata.
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

# Run as the non-root user built into the official Node image.
RUN chown -R node:node /app
USER node

# Documentation only: the application reads the runtime-provided PORT
# (e.g. from Railway) and must not have it overridden here.
EXPOSE 3000

# Exec-form CMD so Node receives signals directly, preserving the
# application's graceful shutdown handling.
CMD ["node", "dist/server.js"]
