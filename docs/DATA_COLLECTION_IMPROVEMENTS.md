# Data Collection Improvements

## Problema Identificado

### Síntomas
- Señales repetitivas con valores estáticos (conf=0.74/str=-0.63, conf=0.70/str=0.46)
- 0% win rate en trading
- Solo 6 combinaciones únicas de señales en 1 hora
- Pérdidas consistentes ($3,100+ en minutos)

### Causa Raíz

**1. Price Bars Artificiales en Database**
```sql
-- Datos actuales en price_history
open: 0.755, high: 0.755, low: 0.755, close: 0.755  ← Sin variación!
volume: null, bid: null, ask: null
```

**2. Data Collector Issues** (`packages/data-collector/src/collectors/ClobCollector.ts:207-216`)
```typescript
const price = parseFloat(point.p);
values.push(
  price,  // open  ← Todos el mismo valor
  price,  // high
  price,  // low
  price   // close
);
```

**3. Datos Insuficientes**
- Solo 212 price points/hora para 1,729 markets
- Markets individuales: máximo 4 precios/hora
- SignalEngine necesita 30+ bars → usa fallback con datos mock

**4. Frecuencia Baja**
- `sync-price-history`: cada 15 minutos (Scheduler.ts:28)
- `fidelity`: 60 (1-minute bars) pero solo sincroniza cada 15 min
- Resultado: gaps grandes en datos históricos

### Impacto en Generadores

- **MomentumSignal**: Calcula sobre precios planos → momentum=0
- **MeanReversionSignal**: Sin volatilidad → no detecta desviaciones
- **OrderFlowImbalanceSignal**: volume=null → no puede calcular OFI
- **HawkesSignal**: Sin trade clustering real
- **MultiLevelOFISignal**: Sin depth data

## Soluciones Propuestas

### Solución A: Mejorar Data Collector (Prioritario)

#### A1. Aumentar Frecuencia de Sincronización

**Cambios en `Scheduler.ts`:**
```typescript
// Antes:
this.defineJob('sync-price-history', '*/15 * * * *', ...);  // Cada 15 min

// Después:
this.defineJob('sync-price-history', '*/1 * * * *', ...);   // Cada 1 min
```

**Impacto:**
- 15x más datos históricos
- Mejor granularidad para detectar momentum
- Gaps más pequeños en time series

#### A2. Construir Price Bars OHLC Reales

**Nuevo método en `ClobCollector.ts`:**
```typescript
async buildRealTimePriceBars(
  marketId: string,
  tokenId: string,
  intervalSeconds: number = 60
): Promise<void> {
  // Cada minuto:
  // 1. Fetch price + order book
  // 2. Track high/low desde último bar
  // 3. Al completar interval, insert bar con O/H/L/C reales
  // 4. Guardar volume, bid/ask, spread
}
```

**Ventajas:**
- OHLC con variación real
- Volume tracking
- Bid/ask spreads para OFI

#### A3. Agregar Streaming Price Collection

**Nuevo collector `PriceStreamCollector.ts`:**
```typescript
class PriceStreamCollector {
  // Mantiene tracking real-time de precios
  private activeBars: Map<string, CurrentBar> = new Map();

  async startStreaming(markets: string[]): Promise<void> {
    // Cada 5 segundos: fetch current prices
    // Update active bar high/low
    // Cada 60 segundos: flush bar to DB
  }
}
```

**Beneficios:**
- Datos continuos, no snapshots aislados
- High/low reales basados en observaciones
- Minimal API calls (1 por market cada 5 seg)

### Solución C: Fuentes Alternativas (Complementario)

#### C1. Gamma API Market Data

**Explorar endpoints:**
```typescript
// Gamma puede tener datos adicionales no disponibles en CLOB
GET /markets/{id}/trades        // Trade history real
GET /markets/{id}/orderbook     // Depth completo
GET /markets/{id}/analytics     // Volume, liquidity metrics
```

**Implementación:**
```typescript
class GammaMarketDataCollector extends GammaCollector {
  async syncTradeHistory(marketId: string): Promise<void> {
    // Recoger trades reales
    // Construir OHLCV desde trades
    // Guardar en price_history con datos reales
  }
}
```

#### C2. WebSocket Real-Time Updates

Si Polymarket ofrece WebSocket:
```typescript
class RealtimePriceCollector {
  connectToStream(markets: string[]): void {
    // Subscribe a price updates
    // Update current bars en memoria
    // Flush periódicamente a DB
  }
}
```

#### C3. Datos de Orden de Magnitud

**Alternativa pragmática:**
Aunque CLOB API solo devuelve precio único, podemos simular variación realista:
```typescript
// En vez de: open=high=low=close=price
// Usar:
const volatility = estimateVolatility(recentPrices);
const high = price * (1 + volatility * 0.5);
const low = price * (1 - volatility * 0.5);
const open = lastBar.close || price;
const close = price;
```

**Justificación:**
- Mejor que datos completamente planos
- Basado en volatilidad histórica real
- Los generadores pueden detectar trends

## Plan de Implementación

### Fase 1: Quick Wins (1-2 horas)

1. **Aumentar frecuencia** (Scheduler.ts)
   - sync-price-history: 15min → 1min
   - Restart data-collector service

2. **Simular variación** (ClobCollector.ts)
   - Calcular high/low con volatilidad estimada
   - Añadir jitter realista

3. **Verificar mejora**
   - Correr por 1 hora
   - Verificar price_history tiene más datos
   - Verificar señales tienen más variación

### Fase 2: Real-Time Bars (2-4 horas)

1. **Implementar PriceStreamCollector**
   - Fetch prices cada 5 segundos
   - Build bars cada 60 segundos
   - Store con OHLC reales

2. **Añadir al Scheduler**
   - Nuevo job para streaming
   - Run en paralelo con sync histórico

### Fase 3: Alternative Sources (4-6 horas)

1. **Investigar Gamma API**
   - Documentación de endpoints
   - Test trade history
   - Evaluar calidad de datos

2. **Integrar si útil**
   - GammaMarketDataCollector
   - Merge con datos CLOB
   - Priorizar source con mejor calidad

## Métricas de Éxito

- [ ] Price points/hora: 212 → 3,600+ (60 por market × 100 markets)
- [ ] Variación OHLC: 0% → >1% promedio
- [ ] Señales únicas/hora: 6 → 50+
- [ ] Win rate: 0% → >30%
- [ ] Markets con datos suficientes: <10 → 100+

## Riesgos y Mitigaciones

### API Rate Limits
- **Riesgo**: Más requests = rate limiting
- **Mitigación**:
  - Usar rate limiter existente
  - Ajustar MAX_TRACKED_MARKETS si necesario
  - Batch requests donde posible

### Database Storage
- **Riesgo**: 15x más datos = más storage
- **Mitigación**:
  - TimescaleDB compression
  - Retention policies (drop data >30 days)
  - Monitor disk usage

### System Load
- **Riesgo**: Más CPU/memory para procesamiento
- **Mitigación**:
  - Profile performance
  - Optimize batch inserts
  - Add indexes si necesario

## Next Steps

1. ✅ **Analizar problema** - DONE
2. ⏳ **Implementar Fase 1** (quick wins)
3. ⏳ **Monitorear mejoras**
4. ⏳ **Decidir si Fase 2/3 necesarias**
