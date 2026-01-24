FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files for both backend and UI
COPY package*.json ./
COPY ui/package*.json ./ui/

# Install all dependencies (including devDependencies for build)
RUN npm ci
RUN cd ui && npm ci

# Copy source code
COPY . .

# Build TypeScript backend
RUN npm run build:ts

# Build React UI
RUN cd ui && npm run build

# Production stage
FROM node:20-alpine

# Install SSH client for tunnel management
# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache openssh-client curl python3 make g++

# Create apps user with UID 568 (matches TrueNAS apps user)
RUN addgroup -g 568 apps && adduser -u 568 -G apps -h /home/apps -D apps

WORKDIR /app

# Copy package files and install production dependencies only
# --ignore-scripts skips postinstall (which tries to cd to ui - not in prod image)
# Then rebuild better-sqlite3 which needs native compilation
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm rebuild better-sqlite3

# Remove build tools after native modules are compiled (reduce image size)
RUN apk del python3 make g++

# Copy compiled TypeScript output
COPY --from=builder /app/dist ./dist

# Copy static content
COPY --from=builder /app/content ./content
COPY --from=builder /app/public ./public

# Copy built React UI
COPY --from=builder /app/ui/dist ./ui/dist

# Change ownership to apps user
RUN chown -R apps:apps /app

# Create .ssh directory for apps user
RUN mkdir -p /home/apps/.ssh && chown -R apps:apps /home/apps/.ssh

USER apps

EXPOSE 3000 8000

CMD ["node", "dist/server.js"]
