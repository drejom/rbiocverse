FROM node:20-alpine

# Install SSH client for tunnel management
RUN apk add --no-cache openssh-client curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 3000 8000

CMD ["node", "server.js"]
