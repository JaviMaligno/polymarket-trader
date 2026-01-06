/**
 * CLI Display Utilities
 *
 * Formatting and display helpers for the CLI.
 */

import Table from 'cli-table3';

// ============================================
// Color Helpers (ANSI codes for compatibility)
// ============================================

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
};

export function red(text: string): string {
  return `${colors.red}${text}${colors.reset}`;
}

export function green(text: string): string {
  return `${colors.green}${text}${colors.reset}`;
}

export function yellow(text: string): string {
  return `${colors.yellow}${text}${colors.reset}`;
}

export function blue(text: string): string {
  return `${colors.blue}${text}${colors.reset}`;
}

export function cyan(text: string): string {
  return `${colors.cyan}${text}${colors.reset}`;
}

export function magenta(text: string): string {
  return `${colors.magenta}${text}${colors.reset}`;
}

export function bold(text: string): string {
  return `${colors.bright}${text}${colors.reset}`;
}

export function dim(text: string): string {
  return `${colors.dim}${text}${colors.reset}`;
}

// ============================================
// Formatting Helpers
// ============================================

export function formatCurrency(value: number): string {
  const formatted = Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  if (value < 0) {
    return red(`-$${formatted}`);
  } else if (value > 0) {
    return green(`+$${formatted}`);
  }
  return `$${formatted}`;
}

export function formatPercent(value: number): string {
  const pct = (value * 100).toFixed(2);
  if (value < 0) {
    return red(`${pct}%`);
  } else if (value > 0) {
    return green(`+${pct}%`);
  }
  return `${pct}%`;
}

export function formatNumber(value: number, decimals: number = 2): string {
  return value.toFixed(decimals);
}

export function formatDate(date: Date): string {
  return date.toLocaleString();
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

// ============================================
// Status Helpers
// ============================================

export function statusBadge(status: string): string {
  switch (status.toUpperCase()) {
    case 'CONNECTED':
    case 'RUNNING':
    case 'FILLED':
    case 'PASSED':
    case 'GO':
    case 'OK':
      return green(`[${status}]`);
    case 'DISCONNECTED':
    case 'STOPPED':
    case 'CANCELLED':
    case 'FAILED':
    case 'NO_GO':
    case 'BREACH':
      return red(`[${status}]`);
    case 'CONNECTING':
    case 'PENDING':
    case 'PARTIAL':
    case 'CONDITIONAL':
    case 'WARNING':
      return yellow(`[${status}]`);
    default:
      return `[${status}]`;
  }
}

export function pnlColor(value: number): string {
  if (value > 0) return green(formatCurrency(value));
  if (value < 0) return red(formatCurrency(value));
  return formatCurrency(value);
}

// ============================================
// Table Helpers
// ============================================

export function createTable(headers: string[]): Table.Table {
  return new Table({
    head: headers.map(h => cyan(h)),
    style: { head: [], border: [] },
    chars: {
      'top': '─', 'top-mid': '┬', 'top-left': '┌', 'top-right': '┐',
      'bottom': '─', 'bottom-mid': '┴', 'bottom-left': '└', 'bottom-right': '┘',
      'left': '│', 'left-mid': '├', 'mid': '─', 'mid-mid': '┼',
      'right': '│', 'right-mid': '┤', 'middle': '│',
    },
  });
}

export function createCompactTable(headers: string[]): Table.Table {
  return new Table({
    head: headers.map(h => cyan(h)),
    style: { head: [], border: [], compact: true },
  });
}

// ============================================
// Box Drawing
// ============================================

export function box(title: string, content: string): string {
  const lines = content.split('\n');
  const maxLength = Math.max(title.length + 2, ...lines.map(l => stripAnsi(l).length));
  const width = maxLength + 2;

  let result = '';
  result += `┌${'─'.repeat(width)}┐\n`;
  result += `│ ${bold(title)}${' '.repeat(width - title.length - 1)}│\n`;
  result += `├${'─'.repeat(width)}┤\n`;

  for (const line of lines) {
    const padding = width - stripAnsi(line).length - 1;
    result += `│ ${line}${' '.repeat(Math.max(0, padding))}│\n`;
  }

  result += `└${'─'.repeat(width)}┘`;
  return result;
}

export function divider(char: string = '─', length: number = 50): string {
  return dim(char.repeat(length));
}

// ============================================
// Helpers
// ============================================

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

export function clearScreen(): void {
  process.stdout.write('\x1b[2J\x1b[H');
}

export function moveCursor(row: number, col: number): void {
  process.stdout.write(`\x1b[${row};${col}H`);
}

// ============================================
// Spinners and Progress
// ============================================

export function spinner(frames: string[] = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']): {
  start: (text: string) => void;
  stop: (text?: string) => void;
  update: (text: string) => void;
} {
  let interval: NodeJS.Timeout | null = null;
  let frameIndex = 0;
  let currentText = '';

  return {
    start(text: string) {
      currentText = text;
      interval = setInterval(() => {
        process.stdout.write(`\r${cyan(frames[frameIndex])} ${currentText}`);
        frameIndex = (frameIndex + 1) % frames.length;
      }, 80);
    },
    stop(text?: string) {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      if (text) {
        process.stdout.write(`\r${green('✓')} ${text}\n`);
      } else {
        process.stdout.write('\r' + ' '.repeat(currentText.length + 3) + '\r');
      }
    },
    update(text: string) {
      currentText = text;
    },
  };
}

// ============================================
// Keyboard Input
// ============================================

export function enableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
}

export function disableRawMode(): void {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
}
