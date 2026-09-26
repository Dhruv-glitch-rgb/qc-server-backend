FROM node:20-alpine

# Set working directory
WORKDIR /app

# Install curl for container health check
RUN apk add --no-cache curl

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application source
COPY . .

# Ensure data and uploads directories exist with proper permissions
RUN mkdir -p /app/data /app/uploads && chown -R node:node /app

# Switch to unprivileged node user
USER node

# Expose server port
EXPOSE 4000

ENV PORT=4000 \
    NODE_ENV=production

# Container healthcheck
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:${PORT}/api/health || exit 1

CMD ["node", "server.js"]
