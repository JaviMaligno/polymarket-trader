# H-MM-3 Nivel 1 — fill-sim reactivo a cola + universo 3 tipos

**Fecha:** 2026-06-09
**Estado:** diseño aprobado (pendiente de plan de implementación)
**Contexto:** [[project_next_levers_and_automation]], [[project_market_making_idea]], [[project_trades_collection_corrupt_2026-06-06]]

## Problema

El validador H-MM-3 (`scripts/edge-research/validators/mm_fine.py`) mide el spread
retenido por un maker pasivo asumiendo que **se llena el 100% de las veces** que un
trade cruza el tope del libro. Eso sobreestima la tasa de ejecución: en un CLOB real
cada nivel de precio es una cola FIFO, y que la orden del maker se llene depende de su
posición en la cola y del tamaño del flujo agresivo. El recorder
(`packages/mm-recorder`) hoy guarda solo `best_bid`/`best_ask`/`mid` en
`mm_book_events` — `bestOf()` (parser.ts:23) descarta los tamaños por nivel que el feed
CLOB sí trae.

Además el recorder solo cubre `event_financial` (15 mercados), dejando fuera
`event_long` y `event_short`, que hoy también tienen libros estrechos (datos VM
2026-06-09: spread medio event_long 0.0194 con 13 mercados ≤0.05; event_short 0.0227
con 3; crypto sin libro). H-MM-1 vio edge en event_financial (+0.37%) y event_long
(+0.19%).

## Objetivo

1. Modelar la ejecución del maker de forma **reactiva a la cola**: un maker que cotiza
   el tope se llena solo cuando el volumen agresivo adverso acumulado supera el tamaño
   que tenía por delante. Reportar **cotas front/back** (mejor/peor caso de posición en
   cola).
2. Persistir el tamaño del tope (`best_bid_size`/`best_ask_size`) reconstruyendo el
   libro L2 en el recorder.
3. Ampliar el universo del recorder a `event_financial` + `event_long` + `event_short`.

No-objetivos (YAGNI; se añaden si hacen falta): posición exacta en cola (inobservable
sin órdenes reales — eso es el Nivel 3 / quoting en vivo); profundidad más allá del
tope; inventario; rewards (H-MM-2); cripto (sin libro hoy).

## Decisiones tomadas (brainstorm 2026-06-09)

- **Captura del tamaño de cola: (A) reconstrucción de libro.** El recorder mantiene el
  libro L2 por token y persiste `best_bid_size`/`best_ask_size` en cada fila. Más
  correcto que "solo observado", a cambio de estado en el recorder; la deriva queda
  acotada por reconexiones y autoverificada (ver §Componente 1).
- **Modelo de fill: quoting continuo con re-colocación.** Walk cronológico por token;
  cota front = tamaño-por-delante 0 (≈ modelo actual 100%), cota back = tamaño del tope
  al colocar.
- **Universo: los tres tipos con libro quoteable hoy** (event_financial + event_long +
  event_short), manteniendo el filtro de liquidez `spread ≤ 0.05`.
- **Cohortes: mantener el split de tamaño** → `cohorte × horizonte × tamaño{all,large} ×
  cota{front,back}`.

## Arquitectura por componentes

### Componente 1 — Recorder: reconstrucción L2 + tamaño del tope

`packages/mm-recorder`.

- **`types.ts`**: `BookEvent` gana `bestBidSize: number | null`, `bestAskSize: number |
  null`. Internamente el parseo de `price_change` debe conservar `price`/`size`/`side`
  por nivel (hoy se descartan).
- **Estado por token** (nuevo módulo, p.ej. `bookState.ts`): un `Map<price, size>` por
  lado. 
  - Frame `book`: reconstruir la escalera completa desde `bids`/`asks`.
  - Entrada `price_change`: upsert del nivel — `size` se interpreta como el **nuevo
    tamaño absoluto** en ese precio; `size === 0` ⇒ borrar el nivel. Recomputar mejor
    precio y su tamaño por lado.
- **Cross-check (autoverificación gratis):** cada `price_change` trae también
  `best_bid`/`best_ask`. Tras aplicar el delta, comprobar `best reconstruido === best
  reportado`. Si no casa (mensaje perdido / deriva): registrar en `mm_capture_gaps`
  (reason = `book_resync`) y adoptar el best reportado por el feed; el tamaño de ese
  tope queda `null` hasta el próximo frame `book` que reconstruya la escalera. Este
  cross-check también valida en vivo el supuesto "size absoluto vs delta".
- **`schema.sql`** y `ensureRuntimeSchema` (runtimeSchema.ts): `ALTER TABLE
  mm_book_events ADD COLUMN IF NOT EXISTS best_bid_size DOUBLE PRECISION, ADD COLUMN IF
  NOT EXISTS best_ask_size DOUBLE PRECISION`. (Las filas ya capturadas quedan con
  `NULL`.)
- **`sink.ts`**: incluir `best_bid_size`, `best_ask_size` en el INSERT de
  `mm_book_events` (tupla pasa de 7 a 9 columnas).

### Componente 2 — Universo (selectUniverse)

`packages/mm-recorder/src/selectUniverse.sql` y `.ts`.

- `WHERE m.market_type IN ('event_financial','event_long','event_short')` (parametrizado
  o lista literal). Mantener `tracking_status='active'` y `avg_spread <= 0.05` (el gate
  de calidad real; selecciona solo libros quoteable independientemente del tipo).
- Subir `LIMIT` para cubrir los ~41 mercados quoteable actuales (financial 25 + long 13
  + short 3). Emite YES+NO → ~80 tokens; RAM holgada frente al límite 120M (hoy ~16M con
  30 tokens).

### Componente 3 — Export (mm_fine_fills.sql)

`scripts/edge-research/mm_fine_fills.sql`.

- Añadir `best_bid_size`, `best_ask_size` al SELECT, tomados asof el book event previo al
  trade (misma lateral que `mid_before`). Python necesita el tamaño de cola en cada
  trade para el walk.
- Conservar los arreglos ya mergeados: join `markets m ON m.condition_id = w.market_id`
  y `format='ISO8601'` en el loader.

### Componente 4 — Validador: walk reactivo a cola (mm_fine.py)

`scripts/edge-research/validators/mm_fine.py`.

- Sustituir la media vectorizada por un **walk cronológico por token**:
  - Maker a dos lados, cotizando el tope (best bid y best ask) continuamente.
  - Estado por lado: `size_ahead`. Al (re)colocar, `size_ahead =` tamaño del tope de ese
    lado en ese instante (back) o `0` (front).
  - Por cada trade en orden temporal: determinar el lado adverso (`price < mid_before` ⇒
    pega al bid; `price > mid_before` ⇒ al ask). Restar `trade.size` a `size_ahead` de
    ese lado. Si `size_ahead <= 0` ⇒ **fill**: registrar `retained = maker_sign *
    (maker_price − mid_horizonte)` y **re-colocar** al final de la nueva cola del tope
    (resetear `size_ahead`). El sobrante de volumen tras un fill no se arrastra (orden
    pequeña, un fill consume la orden).
  - Tamaño del maker: despreciable (se llena por completo en el trade que lo alcanza); no
    se parametriza.
- **Cotas:** correr el walk dos veces por token — `front` (`size_ahead`≡0, ≈ modelo
  actual 100%, se conserva como referencia optimista) y `back` (`size_ahead` = tamaño del
  tope al colocar).
- **Cohortes emitidas:** para cada `(cohorte ∈ {headline:tradeable, event_financial,
  event_long, event_short}) × (horizonte ∈ {10s,60s,300s}) × (tamaño ∈ {all, large≥p75})
  × (cota ∈ {front,back})`. `tradeable = market_type != 'event_long'` (mantiene la
  semántica actual; event_long es shadow-only en ALLOWED_MARKET_TYPES).
- **Estadística:** bootstrap CI sobre el array de retained de los fills de cada cohorte.
  `n` = nº de fills (la cota back produce **menos** fills que front → su `n` cruza el
  floor 200 más tarde). `status = pass` si `edge>0 and lo>0`. Caveat actualizado: ya no
  "fill = trade crossed the touch"; ahora "fill reactivo a cola (front/back bounds),
  posición exacta inobservable; excluye inventario + rewards (H-MM-2)".

### Componente 5 — Tests

- **Recorder** (`packages/mm-recorder`): reconstrucción — aplicar `book` + secuencia de
  `price_change` y aseverar best precio + best size por lado; borrado de nivel en
  `size 0`; mismatch reconstruido≠reportado ⇒ fila en `mm_capture_gaps` + resync. Parser
  conserva price/size/side por nivel. Sink inserta las 2 columnas nuevas.
- **Validador** (`tests/test_mm_fine.py`): secuencias sintéticas — front llena ≥ que
  back; una secuencia conocida produce el conjunto de fills esperado y el retained
  esperado; re-colocación tras fill; lado adverso correcto.
- **Loader** (`tests/test_data.py`): el export con `best_bid_size`/`best_ask_size` carga
  (ya hay regresión de timestamps mixtos).

### Componente 6 — Deploy + re-captura

- CI construye la imagen del recorder, push a GHCR, restart del servicio compose
  `capture`. `ensureRuntimeSchema` añade las columnas al arrancar.
- Las filas `mm_book_events` ya capturadas **no tienen tamaños** → la cota **back**
  arranca limpia desde el deploy (~3-5 días a n≥200 en las cohortes headline a ~2k
  fills/día). La cota **front** sigue computable sobre todo el histórico.
- Re-etiquetar el veredicto: la primera lectura back-bound usable cae ~3-5 días tras el
  deploy; el cron weekly (lunes) la recoge automáticamente. Recordar que H-MM-3 lleva
  caveat estructural ⇒ aunque pase no dispara el alert clean-pass del cron (se lee del
  `scoreboard.md`).

## Riesgos / supuestos

- **`price_change.size` absoluto vs delta:** asumido absoluto (convención CLOB). El
  cross-check con `best_bid`/`best_ask` lo valida en vivo; si saltan muchos
  `book_resync`, revisar la interpretación.
- **Deriva por mensajes perdidos:** acotada por reconexiones (Polymarket reenvía `book`
  al re-suscribir) y registrada en `mm_capture_gaps`.
- **Explosión de cohortes:** 4×3×2×2 = 48 celdas; la mayoría inconclusive al principio.
  Las headline (tradeable, all, ambas cotas) son las accionables. Se puede recortar
  después.
- **RAM e2-micro:** ~80 tokens vs 30 hoy; monitorizar `docker stats` del servicio
  `capture` tras el deploy (límite 120M).
