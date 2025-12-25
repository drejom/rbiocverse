FROM node:20-alpine

# Install SSH client for tunnel management
RUN apk add --no-cache openssh-client curl

# Create apps user with UID 568 (matches TrueNAS apps user)
RUN addgroup -g 568 apps && adduser -u 568 -G apps -h /home/apps -D apps

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Change ownership to apps user
RUN chown -R apps:apps /app

# Create .ssh directory for apps user
RUN mkdir -p /home/apps/.ssh && chown -R apps:apps /home/apps/.ssh

USER apps

EXPOSE 3000 8000

CMD ["node", "server.js"]
