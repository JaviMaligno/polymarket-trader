import { describe, it, expect } from 'vitest';
import { InventoryBook } from './inventoryBook.js';

describe('InventoryBook', () => {
  it('round-trip completo: realized = (ask - bid) * size, posición 0', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.48, 20); // maker compra 20 @ .48
    b.applyFill('M1', 1, 0.52, 20);  // maker vende 20 @ .52
    expect(b.position('M1')).toBe(0);
    expect(b.realized('M1')).toBeCloseTo(0.04 * 20, 10);
    expect(b.cash()).toBeCloseTo(0.04 * 20, 10);
  });

  it('invariante: equity = cash + sum(pos * mid) en todo momento', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.48, 20);
    b.applyFill('M2', 1, 0.70, 10); // short 10 @ .70
    const mids = new Map([['M1', 0.50], ['M2', 0.65]]);
    // M1: compró a .48, vale .50 -> +0.4; M2: vendió a .70, vale .65 -> +0.5
    expect(b.equity(mids)).toBeCloseTo(0.4 + 0.5, 10);
    expect(b.equity(mids)).toBeCloseTo(b.cash() + b.m2m(mids), 10);
  });

  it('reducción parcial realiza proporcionalmente', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 30);
    b.applyFill('M1', 1, 0.50, 10);
    expect(b.position('M1')).toBe(20);
    expect(b.realized('M1')).toBeCloseTo(0.10 * 10, 10);
  });

  it('cruce de signo: realiza el cierre y abre el resto al nuevo precio', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 10);
    b.applyFill('M1', 1, 0.50, 25); // cierra 10 (+1.0) y abre short 15 @ .50
    expect(b.position('M1')).toBe(-15);
    expect(b.realized('M1')).toBeCloseTo(1.0, 10);
    expect(b.avgPrice('M1')).toBeCloseTo(0.50, 10);
  });

  it('inventario = suma con signo de los fills', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 10);
    b.applyFill('M1', -1, 0.42, 5);
    b.applyFill('M1', 1, 0.45, 7);
    expect(b.position('M1')).toBe(10 + 5 - 7);
  });

  it('notional usa el avg price de la posición abierta', () => {
    const b = new InventoryBook();
    b.applyFill('M1', -1, 0.40, 10);
    b.applyFill('M1', -1, 0.50, 10);
    expect(b.avgPrice('M1')).toBeCloseTo(0.45, 10);
    expect(b.notional('M1')).toBeCloseTo(0.45 * 20, 10);
    expect(b.totalNotional()).toBeCloseTo(0.45 * 20, 10);
  });
});
