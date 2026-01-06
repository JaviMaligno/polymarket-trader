# Polymarket Dashboard API Service
FROM node:20-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/signals/package.json ./packages/signals/
COPY packages/backtest/package.json ./packages/backtest/
COPY packages/trader/package.json ./packages/trader/
COPY packages/dashboard/package.json ./packages/dashboard/

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source code
COPY packages/signals ./packages/signals
COPY packages/backtest ./packages/backtest
COPY packages/trader ./packages/trader
COPY packages/dashboard ./packages/dashboard
COPY tsconfig.json ./

# Build all packages
RUN pnpm --filter @polymarket-trader/signals build && \
    pnpm --filter @polymarket-trader/backtest build && \
    pnpm --filter @polymarket-trader/trader build && \
    pnpm --filter @polymarket-trader/dashboard build

# Production stage
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files for production install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/signals/package.json ./packages/signals/
COPY packages/backtest/package.json ./packages/backtest/
COPY packages/trader/package.json ./packages/trader/
COPY packages/dashboard/package.json ./packages/dashboard/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files
COPY --from=builder /app/packages/signals/dist ./packages/signals/dist
COPY --from=builder /app/packages/backtest/dist ./packages/backtest/dist
COPY --from=builder /app/packages/trader/dist ./packages/trader/dist
COPY --from=builder /app/packages/dashboard/dist ./packages/dashboard/dist

# Set environment
ENV NODE_ENV=production
ENV PORT=3001
ENV HOST=0.0.0.0
ENV CORS_ORIGIN=*
ENV CONNECT_TRADER=true
ENV POLYMARKET_API_URL=https://clob.polymarket.com
ENV INITIAL_CAPITAL=10000
ENV FEE_RATE=0.001
ENV MAX_DRAWDOWN=0.15
ENV MAX_DAILY_LOSS=500

# Expose port
EXPOSE 3001

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3001/health || exit 1

# Start server
CMD ["node", "packages/dashboard/dist/server.js"]
