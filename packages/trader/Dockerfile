# Polymarket Trader Service
FROM node:20-alpine AS builder

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/signals/package.json ./packages/signals/
COPY packages/backtest/package.json ./packages/backtest/
COPY packages/trader/package.json ./packages/trader/

# Install dependencies
RUN pnpm install --frozen-lockfile --prod=false

# Copy source code
COPY packages/signals ./packages/signals
COPY packages/backtest ./packages/backtest
COPY packages/trader ./packages/trader
COPY tsconfig.json ./

# Build packages
RUN pnpm --filter @polymarket-trader/signals build && \
    pnpm --filter @polymarket-trader/backtest build && \
    pnpm --filter @polymarket-trader/trader build

# Production stage
FROM node:20-alpine AS production

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Copy package files for production install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/signals/package.json ./packages/signals/
COPY packages/backtest/package.json ./packages/backtest/
COPY packages/trader/package.json ./packages/trader/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy built files
COPY --from=builder /app/packages/signals/dist ./packages/signals/dist
COPY --from=builder /app/packages/backtest/dist ./packages/backtest/dist
COPY --from=builder /app/packages/trader/dist ./packages/trader/dist

# Set environment
ENV NODE_ENV=production
ENV POLYMARKET_API_URL=https://clob.polymarket.com
ENV INITIAL_CAPITAL=10000
ENV FEE_RATE=0.001
ENV MAX_DRAWDOWN=0.15
ENV MAX_DAILY_LOSS=500

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD node -e "console.log('ok')" || exit 1

# Default command - can be overridden
CMD ["node", "packages/trader/dist/index.js"]
