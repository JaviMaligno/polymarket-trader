import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { act, createElement, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { AutomationPanel } from '../src/components/AutomationPanel';
import { useWebSocket } from '../src/hooks/useWebSocket';

let dom;
let root;
let container;
let current;

class Socket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];
  readyState = 0;
  sent = [];
  constructor(url) {
    this.url = url;
    Socket.instances.push(this);
  }
  open() { this.readyState = 1; this.onopen?.({}); }
  close() { this.readyState = 3; this.onclose?.({}); }
  send(data) { this.sent.push(JSON.parse(data)); }
}

function Probe({ options }) {
  current = useWebSocket(options);
  return createElement('span', null, String(current.isConnected));
}

async function render(element) { await act(async () => root.render(element)); }
async function tick(ms) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }

beforeEach(() => {
  dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://offline.invalid' });
  vi.stubGlobal('window', dom.window);
  vi.stubGlobal('document', dom.window.document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
  Socket.instances = [];
  vi.useFakeTimers();
  // Browser timers use the same controlled clock as the test, never real I/O.
  vi.spyOn(dom.window, 'setTimeout').mockImplementation((...args) => setTimeout(...args));
  vi.spyOn(dom.window, 'clearTimeout').mockImplementation((id) => clearTimeout(id));
  container = document.getElementById('root');
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  dom.window.close();
});

describe('actual WebSocket hook lifecycle without network', () => {
  it('connects, forwards messages/subscriptions and reconnects after remote close', async () => {
    const onMessage = vi.fn();
    const onConnect = vi.fn();
    const onDisconnect = vi.fn();
    await render(createElement(Probe, { options: { onMessage, onConnect, onDisconnect } }));
    const first = Socket.instances[0];
    await act(async () => first.open());
    expect(container.textContent).toBe('true');
    expect(onConnect).toHaveBeenCalledTimes(1);
    first.onmessage({ data: JSON.stringify({ type: 'status', payload: 7 }) });
    expect(onMessage).toHaveBeenCalledWith({ type: 'status', payload: 7 });
    current.subscribe('prices');
    current.unsubscribe('prices');
    expect(first.sent.map(({ type, channel }) => ({ type, channel }))).toEqual([
      { type: 'subscribe', channel: 'prices' }, { type: 'unsubscribe', channel: 'prices' },
    ]);
    await act(async () => first.close());
    expect(onDisconnect).toHaveBeenCalledTimes(1);
    await tick(4999);
    expect(Socket.instances).toHaveLength(1);
    await tick(1);
    expect(Socket.instances).toHaveLength(2);
  });

  it('manual disconnect cancels reconnect even when close emits synchronously', async () => {
    const onDisconnect = vi.fn();
    await render(createElement(Probe, { options: { onDisconnect } }));
    await act(async () => current.disconnect());
    await tick(10000);
    expect(Socket.instances).toHaveLength(1);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });

  it('unmount clears pending reconnect and detaches closed socket handlers', async () => {
    await render(createElement(Probe, { options: {} }));
    const socket = Socket.instances[0];
    await act(async () => socket.close());
    await render(null);
    await tick(10000);
    expect(Socket.instances).toHaveLength(1);
    expect(socket.onclose).toBeNull();
    expect(socket.onmessage).toBeNull();
  });

  it('avoids duplicate connections while connecting and supports manual connect', async () => {
    await render(createElement(Probe, { options: { autoConnect: false } }));
    expect(Socket.instances).toHaveLength(0);
    await act(async () => { current.connect(); current.connect(); });
    expect(Socket.instances).toHaveLength(1);
  });

  it('replaces callbacks and interval without leaving the old socket reconnecting', async () => {
    const oldMessage = vi.fn();
    const newMessage = vi.fn();
    await render(createElement(Probe, { options: { onMessage: oldMessage } }));
    const old = Socket.instances[0];
    await render(createElement(Probe, { options: { onMessage: newMessage, reconnectInterval: 250 } }));
    const active = Socket.instances.at(-1);
    expect(old.onmessage).toBeNull();
    active.onmessage({ data: '{"type":"status","payload":1}' });
    expect(newMessage).toHaveBeenCalledTimes(1);
    expect(oldMessage).not.toHaveBeenCalled();
    await act(async () => active.close());
    await tick(250);
    expect(Socket.instances).toHaveLength(3);
    await tick(5000);
    expect(Socket.instances).toHaveLength(3);
  });

  it('survives StrictMode setup/cleanup with exactly one active socket', async () => {
    await render(createElement(StrictMode, null, createElement(Probe, { options: {} })));
    await tick(10000);
    expect(Socket.instances.filter((socket) => socket.readyState !== 3)).toHaveLength(1);
  });
});

describe('actual automation panel read-only status lifecycle', () => {
  function mockStatus() {
    fetch.mockImplementation(async (url, options) => {
      expect(options?.method ?? 'GET').toBe('GET');
      expect(['/api/automation/status', '/api/signals/status', '/api/polymarket/status']).toContain(url);
      const data = url === '/api/automation/status'
        ? { isRunning: false, executor: { dailyTrades: 7 }, collector: {}, learning: {}, risk: {} }
        : { isRunning: false };
      return { ok: true, json: async () => ({ data }) };
    });
  }

  it('loads initially, polls only every 10 seconds, and stops after unmount', async () => {
    mockStatus();
    await render(createElement(AutomationPanel));
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(container.textContent).toContain('Trades today: 7');
    await tick(9999);
    expect(fetch).toHaveBeenCalledTimes(3);
    await tick(1);
    expect(fetch).toHaveBeenCalledTimes(6);
    await render(null);
    await tick(30000);
    expect(fetch).toHaveBeenCalledTimes(6);
  });

  it('settles failed status reads and refreshes through the existing read-only control', async () => {
    fetch.mockRejectedValue(new Error('Offline status'));
    await render(createElement(AutomationPanel));
    expect(container.textContent).toContain('Trades today: 0');
    mockStatus();
    const refresh = [...container.querySelectorAll('button')].find((button) => button.textContent.includes('Refresh'));
    expect(refresh).toBeDefined();
    await act(async () => refresh.click());
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(container.textContent).toContain('Trades today: 7');
  });

  it('ignores late responses from the cleaned-up StrictMode polling subscription', async () => {
    const pending = [];
    mockStatus();
    const response = fetch.getMockImplementation();
    for (let i = 0; i < 3; i++) {
      fetch.mockImplementationOnce((url) => new Promise((resolve) => pending.push({ url, resolve })));
    }
    await render(createElement(StrictMode, null, createElement(AutomationPanel)));
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(container.textContent).toContain('Trades today: 7');
    await act(async () => {
      for (const { url, resolve } of pending) {
        const old = await response(url);
        const payload = await old.json();
        if (url === '/api/automation/status') payload.data.executor.dailyTrades = 99;
        resolve({ ok: true, json: async () => payload });
      }
    });
    expect(container.textContent).toContain('Trades today: 7');
    expect(container.textContent).not.toContain('Trades today: 99');
  });
});
