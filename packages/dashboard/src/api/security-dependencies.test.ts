import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';

vi.hoisted(() => {
  process.env.API_KEY = 'synthetic-contract-key';
  process.env.NODE_ENV = 'production';
});

// Keep actual HTTP authentication, plugin registration and WebSocket handler.
// Business routes and automation factories must never reach providers or data.
vi.mock('./routes.js', () => ({
  registerRoutes: async (app: import('fastify').FastifyInstance) => {
    app.get('/health', async () => ({ status: 'ok' }));
    app.get('/api/security-fixture', async () => ({ success: true }));
    app.post('/api/security-fixture', async (request) => ({ success: true, data: request.body }));
  },
}));
vi.mock('../services/TradingAutomation.js', () => ({ getTradingAutomation: vi.fn(() => { throw Error('Forbidden automation'); }) }));
vi.mock('../services/SignalEngine.js', () => ({ getSignalEngine: vi.fn(() => { throw Error('Forbidden signal engine'); }) }));
vi.mock('../services/PolymarketService.js', () => ({ getPolymarketService: vi.fn(() => { throw Error('Forbidden market API'); }) }));
vi.mock('../services/RiskManager.js', () => ({ getRiskManager: vi.fn(() => { throw Error('Forbidden live risk service'); }) }));

import { DashboardServer } from './server.js';

describe('Dashboard dependency contracts without server startup', () => {
  let server: DashboardServer;

  beforeEach(async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw Error('Forbidden external fetch'); }));
    server = new DashboardServer({
      port: 0,
      host: '127.0.0.1',
      cors: { origin: 'https://fixture.example' },
      staticDir: resolve('packages/dashboard/src/api/security-fixtures'),
    });
    // Exercise the application's real startup registration path, but prevent
    // TCP binding, periodic broadcasts and automation subscriptions entirely.
    vi.spyOn(server.getServer(), 'listen').mockResolvedValue(undefined);
    vi.spyOn(server.getWebSocketHandler(), 'start').mockImplementation(() => {});
    await server.start();
    await server.getServer().ready();
    expect(server.getServer().server.listening).toBe(false);
  });

  afterEach(async () => {
    await server?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves mutating-route API-key checks and the read-only route contract', async () => {
    const app = server.getServer();
    expect((await app.inject({ method: 'POST', url: '/api/security-fixture', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/security-fixture', headers: { 'x-api-key': 'wrong' }, payload: {} })).statusCode).toBe(401);
    const accepted = await app.inject({ method: 'POST', url: '/api/security-fixture', headers: { 'x-api-key': 'synthetic-contract-key' }, payload: { synthetic: true } });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ success: true, data: { synthetic: true } });
    expect((await app.inject('/api/security-fixture')).statusCode).toBe(200);
  });

  it('preserves credentialed CORS and confines static file access to the configured directory', async () => {
    const app = server.getServer();
    const response = await app.inject({ method: 'GET', url: '/index.html', headers: { origin: 'https://fixture.example' } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('synthetic-static-contract');
    expect(response.headers['access-control-allow-origin']).toBe('https://fixture.example');
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    const traversal = await app.inject('/%2e%2e/security-fixtures-outside.txt');
    expect(traversal.body).not.toContain('synthetic-outside-static-root');
    expect(traversal.statusCode).not.toBe(200);
  });

  it('passes the upgraded plugin socket to the real handler and sends the existing welcome payload', async () => {
    const messages: Array<Record<string, unknown>> = [];
    const socket = await server.getServer().injectWS('/ws', {}, {
      onInit: (ws) => ws.on('message', (data) => messages.push(JSON.parse(data.toString()))),
    });
    try {
      await vi.waitFor(() => expect(messages.length).toBeGreaterThan(0));
      expect(messages[0]).toMatchObject({ type: 'state_update', payload: { equity: 0, cash: 0, positions: [], openOrders: 0 } });
    } finally {
      socket.close();
    }
  });
});
