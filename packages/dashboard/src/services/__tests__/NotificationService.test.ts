import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationService } from '../NotificationService.js';

describe('NotificationService', () => {
  let service: NotificationService;

  beforeEach(() => {
    vi.restoreAllMocks();
    global.fetch = vi.fn().mockResolvedValue({ ok: true });
    service = new NotificationService('https://hooks.slack.com/test');
  });

  it('sends funds_warning notification', async () => {
    await service.notify('funds_warning', { balance: 85, threshold: 100 });

    expect(global.fetch).toHaveBeenCalledWith(
      'https://hooks.slack.com/test',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.text).toContain('Warning');
    expect(body.text).toContain('85');
  });

  it('sends funds_low notification with mode change', async () => {
    await service.notify('funds_low', { balance: 23, threshold: 50 });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.text).toContain('paper');
    expect(body.text).toContain('23');
  });

  it('sends mode_change notification', async () => {
    await service.notify('mode_change', { from: 'paper', to: 'real', by: 'user' });

    const body = JSON.parse((global.fetch as any).mock.calls[0][1].body);
    expect(body.text).toContain('real');
  });

  it('does not throw if webhook URL is not configured', async () => {
    const noWebhook = new NotificationService('');
    await expect(noWebhook.notify('funds_warning', { balance: 10 })).resolves.not.toThrow();
  });

  it('does not throw if fetch fails', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network'));
    await expect(service.notify('funds_warning', { balance: 10 })).resolves.not.toThrow();
  });
});
