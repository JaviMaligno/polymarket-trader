# mm-recorder — VM capture campaign

Run only AFTER the local taster + a preliminary H-MM-3 read justify a 1-2 week capture.
The recorder runs as a SEPARATE, on-demand container on the e2-micro and is removed when
the campaign ends. It is not added to the always-on stack.

```bash
# build image (or reuse a node image + bind-mount the repo)
gcloud compute ssh polymarket-vm --zone=us-east1-b

# inside the VM, in the repo dir, apply schema once:
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading \
  -f - < packages/mm-recorder/src/schema.sql

# run as a throwaway container with a hard memory cap, env to the local TS DB:
docker run -d --name mm-recorder --memory=80m --restart=unless-stopped \
  -e DATABASE_URL="postgres://polymarket:polymarket_prod@timescaledb:5432/polymarket_trading?sslmode=disable" \
  -e MM_UNIVERSE_N=15 \
  --network <compose-network> \
  <node-image> sh -c "cd /app/packages/mm-recorder && pnpm start"

# monitor
docker stats --no-stream mm-recorder       # expect low tens of MB
docker logs -f mm-recorder

# end the campaign
docker rm -f mm-recorder
```

Daily health check during the campaign:
```sql
SELECT date_trunc('hour', time) h, count(*) FROM mm_book_events
WHERE time > now() - interval '24h' GROUP BY 1 ORDER BY 1 DESC LIMIT 6;
SELECT count(*) FROM mm_capture_gaps WHERE gap_start > now() - interval '24h';
```

When done, export + run B2 for the robust verdict:
```bash
docker exec polymarket-timescaledb psql -U polymarket -d polymarket_trading \
  -f /tmp/mm_fine_fills.sql > C:/Users/Usuario/edge-datasets/mm_fine_fills.csv
python scripts/edge-research/run.py --datasets-dir C:/Users/Usuario/edge-datasets \
  --out scripts/edge-research/out --computed-at <ts>
grep H-MM-3 scripts/edge-research/out/scoreboard.md
```
Verdict: positive + bootstrap-significant on `headline:tradeable:60s:all` with a `:large`
that does NOT collapse → market-making edge survives realistic fills → proceed to B3
(rewards) / B4 (quoting engine). Otherwise → market-making closed.
