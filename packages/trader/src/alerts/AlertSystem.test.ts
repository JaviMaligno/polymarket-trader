/**
 * AlertSystem Tests
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AlertSystem, type AlertRule } from './AlertSystem.js';

describe('AlertSystem', () => {
  let alertSystem: AlertSystem;

  beforeEach(() => {
    alertSystem = new AlertSystem({
      channels: ['CONSOLE'],
      minSeverity: 'INFO',
      rateLimit: {
        maxPerMinute: 10,
        maxPerHour: 100,
      },
    });
  });

  describe('createAndSend', () => {
    it('should create an alert with correct properties', async () => {
      const alert = await alertSystem.createAndSend(
        'INFO',
        'Test Alert',
        'This is a test message',
        'test-source'
      );

      expect(alert.severity).toBe('INFO');
      expect(alert.title).toBe('Test Alert');
      expect(alert.message).toBe('This is a test message');
      expect(alert.source).toBe('test-source');
      expect(alert.id).toMatch(/^alert_\d+_\d+$/);
      expect(alert.acknowledged).toBe(false);
    });

    it('should include data in alert', async () => {
      const data = { value: 123, status: 'critical' };
      const alert = await alertSystem.createAndSend(
        'WARNING',
        'Test',
        'Message',
        'source',
        data
      );

      expect(alert.data).toEqual(data);
    });
  });

  describe('severity filtering', () => {
    it('should suppress alerts below minimum severity', async () => {
      const strictSystem = new AlertSystem({
        channels: ['CONSOLE'],
        minSeverity: 'ERROR',
      });

      // INFO and WARNING should be suppressed
      let suppressed = false;
      strictSystem.on('suppressed', () => { suppressed = true; });

      await strictSystem.createAndSend('INFO', 'Test', 'Message', 'source');
      expect(suppressed).toBe(true);
    });

    it('should allow alerts at or above minimum severity', async () => {
      const strictSystem = new AlertSystem({
        channels: ['CONSOLE'],
        minSeverity: 'WARNING',
      });

      let sent = false;
      strictSystem.on('sent', () => { sent = true; });

      await strictSystem.createAndSend('ERROR', 'Test', 'Message', 'source');
      expect(sent).toBe(true);
    });
  });

  describe('rate limiting', () => {
    it('should enforce rate limits', async () => {
      const limitedSystem = new AlertSystem({
        channels: ['CONSOLE'],
        minSeverity: 'INFO',
        rateLimit: { maxPerMinute: 2, maxPerHour: 10 },
      });

      // Send 2 alerts (should succeed)
      await limitedSystem.createAndSend('INFO', 'Test 1', 'M', 'source');
      await limitedSystem.createAndSend('INFO', 'Test 2', 'M', 'source');

      // Third alert should be suppressed
      let suppressed = false;
      limitedSystem.on('suppressed', () => { suppressed = true; });
      await limitedSystem.createAndSend('INFO', 'Test 3', 'M', 'source');

      expect(suppressed).toBe(true);
    });
  });

  describe('alert rules', () => {
    it('should register and evaluate rules', async () => {
      const rule: AlertRule = {
        id: 'test-rule',
        name: 'Test Rule',
        condition: (data) => (data.value as number) > 100,
        severity: 'WARNING',
        title: 'High Value Alert',
        message: (data) => `Value is ${data.value}`,
        enabled: true,
      };

      alertSystem.registerRule(rule);

      const alerts = await alertSystem.evaluateRules({ value: 150 }, 'test');
      expect(alerts.length).toBe(1);
      expect(alerts[0].title).toBe('High Value Alert');
    });

    it('should not trigger disabled rules', async () => {
      const rule: AlertRule = {
        id: 'disabled-rule',
        name: 'Disabled Rule',
        condition: () => true,
        severity: 'INFO',
        title: 'Test',
        message: () => 'Test',
        enabled: false,
      };

      alertSystem.registerRule(rule);

      const alerts = await alertSystem.evaluateRules({}, 'test');
      expect(alerts.length).toBe(0);
    });

    it('should respect rule cooldown', async () => {
      const rule: AlertRule = {
        id: 'cooldown-rule',
        name: 'Cooldown Rule',
        condition: () => true,
        severity: 'INFO',
        title: 'Test',
        message: () => 'Test',
        cooldownMs: 1000, // 1 second cooldown
        enabled: true,
      };

      alertSystem.registerRule(rule);

      // First evaluation should trigger
      const alerts1 = await alertSystem.evaluateRules({}, 'test');
      expect(alerts1.length).toBe(1);

      // Immediate second evaluation should not trigger (cooldown)
      const alerts2 = await alertSystem.evaluateRules({}, 'test');
      expect(alerts2.length).toBe(0);
    });
  });

  describe('history', () => {
    it('should maintain alert history', async () => {
      await alertSystem.createAndSend('INFO', 'Test 1', 'M1', 'source');
      await alertSystem.createAndSend('INFO', 'Test 2', 'M2', 'source');

      const history = alertSystem.getHistory();
      expect(history.length).toBe(2);
    });

    it('should limit history size', async () => {
      // Create a system with high rate limits for this test
      const highLimitSystem = new AlertSystem({
        channels: ['CONSOLE'],
        minSeverity: 'INFO',
        rateLimit: { maxPerMinute: 2000, maxPerHour: 10000 },
      });

      // Create alerts to exceed history limit (1000)
      for (let i = 0; i < 1010; i++) {
        await highLimitSystem.createAndSend('INFO', `Test ${i}`, 'M', 'source');
      }

      const history = highLimitSystem.getHistory();
      expect(history.length).toBe(1000);
    });

    it('should clear history', async () => {
      await alertSystem.createAndSend('INFO', 'Test', 'M', 'source');
      alertSystem.clearHistory();

      const history = alertSystem.getHistory();
      expect(history.length).toBe(0);
    });
  });

  describe('default rules', () => {
    it('should register default trading rules', () => {
      alertSystem.registerDefaultRules();
      const rules = alertSystem.getRules();

      expect(rules.length).toBeGreaterThan(0);
      expect(rules.some(r => r.id === 'large_drawdown')).toBe(true);
      expect(rules.some(r => r.id === 'critical_drawdown')).toBe(true);
      expect(rules.some(r => r.id === 'daily_loss')).toBe(true);
    });
  });
});
