# Continuous Trading System Design

**Date:** 2026-01-06
**Status:** Approved

## Overview

Sistema de trading continuo para Polymarket con paper trading, backtesting, aprendizaje automático de señales y monitorización de P&L.

## Prioridades

1. Paper trading en vivo con simulación de orderbook
2. Backtesting histórico
3. Aprendizaje automático de señales
4. Monitorización de P&L

## Arquitectura

```
┌─────────────────────────────────────────────────────────────────┐
│                         RENDER (Cloud)                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐  │
│  │ Dashboard    │  │ Dashboard    │  │ PostgreSQL           │  │
│  │ Frontend     │◄─┤ API          │◄─┤ (TimescaleDB)        │  │
│  │ (Static)     │  │ + Trader     │  │                      │  │
│  └──────────────┘  └──────┬───────┘  └──────────────────────┘  │
│                           │                     ▲               │
│                           │ WebSocket           │               │
│                           ▼                     │               │
│                    ┌──────────────┐             │               │
│                    │ Polymarket   │─────────────┘               │
│                    │ WebSocket    │   (prices → DB)             │
│                    └──────────────┘                             │
└─────────────────────────────────────────────────────────────────┘
```

## Nuevas Tablas de Base de Datos

### signal_predictions
Trackea cada señal generada y su resultado.

```sql
CREATE TABLE signal_predictions (
    id SERIAL,
    time TIMESTAMPTZ NOT NULL,
    market_id VARCHAR(64) NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    direction VARCHAR(4) NOT NULL,
    strength DECIMAL(5,4) NOT NULL,
    confidence DECIMAL(5,4) NOT NULL,
    price_at_signal DECIMAL(10,6) NOT NULL,
    resolved_at TIMESTAMPTZ,
    price_at_resolution DECIMAL(10,6),
    was_correct BOOLEAN,
    pnl_pct DECIMAL(10,6),
    PRIMARY KEY (time, id)
);
```

### signal_weights_history
Historial de pesos de señales para auditoría.

```sql
CREATE TABLE signal_weights_history (
    time TIMESTAMPTZ NOT NULL,
    signal_type VARCHAR(50) NOT NULL,
    weight DECIMAL(5,4) NOT NULL,
    accuracy_7d DECIMAL(5,4),
    accuracy_30d DECIMAL(5,4),
    reason VARCHAR(100),
    PRIMARY KEY (time, signal_type)
);
```

## Paper Trading con Simulación de Orderbook

### Flujo de Ejecución
1. Señal generada → OrderBookSimulator
2. Fetch orderbook real de Polymarket
3. Calcular slippage basado en liquidez
4. Simular fills parciales si necesario
5. Registrar trade con precio real simulado

### Configuración
```typescript
const tradingConfig = {
  maxPositionSize: 1000,      // $1000 max por posición
  maxSlippagePct: 2.0,        // Rechazar si slippage > 2%
  minLiquidityRatio: 0.1,     // Orden máx 10% de liquidez
  simulatePartialFills: true,
};
```

## Aprendizaje Automático de Señales

### Ciclo de Optimización (Semanal)
1. Recoger métricas de últimos 7 días
2. Calcular rendimiento por señal
3. Ejecutar BayesianOptimizer
4. Aplicar límites de cambio
5. Guardar nuevos pesos

### Reglas de Seguridad
- Cambio máximo: ±10% por semana
- Peso mínimo: 0.1
- Peso máximo: 0.9
- Mínimo 50 predicciones para optimizar

### Métricas de Entrada
- Accuracy (% predicciones correctas)
- PnL promedio por trade
- Sharpe ratio de la señal
- Drawdown máximo

## Dashboard de Monitorización

### Vista 1: P&L y Rentabilidad
- Capital inicial vs actual
- PnL total y porcentual
- Equity curve
- Drawdown máximo
- Win rate y Sharpe ratio

### Vista 2: Métricas de Señales
- Tabla de señales con peso, accuracy, PnL/trade
- Countdown a próxima optimización
- Histórico de cambios de pesos

### Vista 3: Análisis de Mercados
- Top mercados por PnL
- Mercados activos
- Posiciones abiertas
- Correlaciones

## Plan de Implementación

### Fase 1: Persistencia (2-3 horas)
- Añadir PostgreSQL en Render
- Ejecutar schema + tablas nuevas
- Conectar Dashboard API a PostgreSQL

### Fase 2: Paper Trading Persistente (2-3 horas)
- Integrar OrderBookSimulator
- Guardar trades en DB
- Guardar señales en signal_predictions

### Fase 3: Tracking de Señales (1-2 horas)
- Resolver predicciones cuando mercado se mueve
- Calcular was_correct y pnl_pct
- Endpoint API para métricas

### Fase 4: Optimizador Automático (2-3 horas)
- Cron job semanal
- Integrar BayesianOptimizer con límites
- Guardar histórico de pesos

### Fase 5: Dashboard Extendido (3-4 horas)
- Vista P&L con equity curve
- Vista métricas de señales
- Vista análisis de mercados

## Persistencia de Datos

- Retención: Ilimitada con compresión
- Compresión price_history: después de 7 días
- Compresión trades: después de 30 días
- Aggregates continuos: 5min, 1h, 1d
