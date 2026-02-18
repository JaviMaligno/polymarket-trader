/**
 * Cleanup script for positions in inactive/resolved markets
 *
 * This script:
 * 1. Finds all open positions
 * 2. Checks if the market is active/resolved
 * 3. Closes positions in inactive markets and returns capital
 */

const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function cleanupInactivePositions() {
  console.log('=== CLEANUP: Posiciones en mercados inactivos ===\n');

  try {
    // Find all open positions with market status
    const positions = await pool.query(`
      SELECT
        pp.id,
        pp.market_id,
        pp.token_id,
        pp.side,
        pp.size,
        pp.avg_entry_price,
        pp.opened_at,
        m.is_active,
        m.is_resolved,
        m.resolution_outcome,
        m.question,
        m.current_price_yes,
        m.current_price_no
      FROM paper_positions pp
      LEFT JOIN markets m ON pp.market_id = m.id
      WHERE pp.closed_at IS NULL
      ORDER BY pp.opened_at
    `);

    console.log(`Total posiciones abiertas: ${positions.rows.length}\n`);

    let totalRecovered = 0;
    let positionsClosed = 0;

    for (const pos of positions.rows) {
      const invested = parseFloat(pos.size) * parseFloat(pos.avg_entry_price);
      const isInactive = !pos.is_active;
      const isResolved = pos.is_resolved;

      console.log(`Market: ${(pos.question || pos.market_id).substring(0, 50)}...`);
      console.log(`  ID: ${pos.id} | Invertido: $${invested.toFixed(2)}`);
      console.log(`  Activo: ${pos.is_active ? 'Sí' : 'NO'} | Resuelto: ${pos.is_resolved ? 'Sí' : 'No'}`);

      if (isInactive || isResolved) {
        // Calculate exit value
        let exitPrice = parseFloat(pos.avg_entry_price); // Default to entry price
        let pnl = 0;

        if (isResolved) {
          // If resolved, check outcome
          // YES resolved = Yes tokens worth $1, No tokens worth $0
          // NO resolved = Yes tokens worth $0, No tokens worth $1
          const outcome = pos.resolution_outcome;
          if (outcome === 'Yes') {
            // Yes won - if we had Yes position, we get $1 per share
            exitPrice = pos.side === 'long' ? 1.0 : 0.0;
          } else if (outcome === 'No') {
            // No won - if we had Yes position (long), we get $0
            exitPrice = pos.side === 'long' ? 0.0 : 1.0;
          }
        } else if (isInactive) {
          // Not resolved but inactive - use current market price or entry price
          exitPrice = pos.current_price_yes ? parseFloat(pos.current_price_yes) : parseFloat(pos.avg_entry_price);
        }

        const exitValue = parseFloat(pos.size) * exitPrice;
        pnl = exitValue - invested;

        console.log(`  >> CERRANDO: Exit price $${exitPrice.toFixed(4)} | PnL: $${pnl.toFixed(2)}`);

        // Close the position
        await pool.query(`
          UPDATE paper_positions SET
            closed_at = NOW(),
            realized_pnl = $1,
            current_price = $2,
            size = 0
          WHERE id = $3
        `, [pnl, exitPrice, pos.id]);

        // Update paper account
        await pool.query(`
          UPDATE paper_account SET
            current_capital = current_capital + $1,
            available_capital = available_capital + $1,
            total_realized_pnl = total_realized_pnl + $2,
            winning_trades = winning_trades + CASE WHEN $2 > 0 THEN 1 ELSE 0 END,
            losing_trades = losing_trades + CASE WHEN $2 < 0 THEN 1 ELSE 0 END,
            updated_at = NOW()
          WHERE id = 1
        `, [exitValue, pnl]);

        // Record a "close" trade for tracking
        await pool.query(`
          INSERT INTO paper_trades (time, market_id, token_id, side, requested_size, executed_size,
            requested_price, executed_price, fee, value_usd, signal_type, order_type, fill_type)
          VALUES (NOW(), $1, $2, 'sell', $3, $3, $4, $4, 0, $5, 'cleanup_inactive', 'market', 'full')
        `, [pos.market_id, pos.token_id, pos.size, exitPrice, exitValue]);

        totalRecovered += exitValue;
        positionsClosed++;
        console.log('  >> CERRADA\n');
      } else {
        console.log('  (Activa - no se cierra)\n');
      }
    }

    console.log('=== RESUMEN ===');
    console.log(`Posiciones cerradas: ${positionsClosed}`);
    console.log(`Capital recuperado: $${totalRecovered.toFixed(2)}`);

    // Show final account status
    const account = await pool.query('SELECT * FROM paper_account LIMIT 1');
    const a = account.rows[0];
    console.log('\n=== ESTADO FINAL DE LA CUENTA ===');
    console.log(`Capital actual: $${parseFloat(a.current_capital).toFixed(2)}`);
    console.log(`Capital disponible: $${parseFloat(a.available_capital).toFixed(2)}`);
    console.log(`PnL realizado: $${parseFloat(a.total_realized_pnl).toFixed(2)}`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

cleanupInactivePositions();
