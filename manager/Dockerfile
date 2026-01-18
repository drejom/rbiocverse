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

# Build React UI
RUN cd ui && npm run build

# Production stage
FROM node:20-alpine

# Install SSH client for tunnel management
RUN apk add --no-cache openssh-client curl

# Create apps user with UID 568 (matches TrueNAS apps user)
RUN addgroup -g 568 apps && adduser -u 568 -G apps -h /home/apps -D apps

WORKDIR /app

# Copy package files and install production dependencies only
# --ignore-scripts skips postinstall (which installs ui deps - not needed in prod)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy backend source (explicit list, not wildcard)
COPY --from=builder /app/server.js ./
COPY --from=builder /app/config ./config
COPY --from=builder /app/content ./content
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/routes ./routes
COPY --from=builder /app/services ./services
COPY --from=builder /app/public ./public

# Copy built React UI
COPY --from=builder /app/ui/dist ./ui/dist

# Change ownership to apps user
RUN chown -R apps:apps /app

# Create .ssh directory for apps user
RUN mkdir -p /home/apps/.ssh && chown -R apps:apps /home/apps/.ssh

USER apps

EXPOSE 3000 8000

CMD ["node", "server.js"]
