import { isFirstParty } from './ranking.js';

/**
 * What `/fastcel` shows: a model's providers, fastest first, and notes under them.
 * @typedef {object} RankingReport
 * @property {string} modelId
 * @property {number} fetchedAt When the stats were fetched, in milliseconds since the epoch.
 * @property {readonly import('./ranking.js').RankedProvider[]} ranking
 * @property {readonly string[]} notes Who served the last reply, a model with a single provider.
 */

const INDENT = '  ';
const GAP = '  ';
const BAR_CELLS = 10;
const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
/** Optional columns, in the order they give way when the line is too narrow. */
const DROPPABLE = ['bar', 'firstToken', 'uptime', 'note'];

/**
 * `togetherai · 187 tok/s`. A provider that shares its slug with the model's maker, such as
 * `deepseek` for `deepseek/…`, is the maker's own API; the label says so, since its name reads like the model's.
 * @param {string} modelId
 * @param {readonly import('./ranking.js').RankedProvider[] | undefined} ranking
 */
export function leaderText(modelId, ranking) {
  const leader = ranking?.[0];
  if (!leader) return undefined;
  const firstParty = isFirstParty(leader.provider, modelId) ? ' (first-party)' : '';
  const speed = leader.tps === undefined ? '' : ` · ${Math.round(leader.tps)} tok/s`;
  return `${leader.provider}${firstParty}${speed}`;
}

/**
 * The report as a plain-text table for clients without the web panel, at most `width` characters per line.
 * @param {RankingReport} report
 * @param {{ width?: number, now?: number }} [options]
 */
export function formatReport(report, { width = 100, now = Date.now() } = {}) {
  const { modelId, ranking } = report;
  const maxTps = Math.max(0, ...ranking.map(entry => entry.tps ?? 0));
  let columns = [
    { id: 'rank', head: '#', align: 'right', cells: ranking.map((_, index) => String(index + 1)) },
    { id: 'provider', head: 'provider', align: 'left', cells: ranking.map(entry => entry.provider) },
    { id: 'speed', head: 'speed', align: 'right', cells: ranking.map(entry => speedText(entry.tps)) },
    { id: 'bar', head: '', align: 'left', cells: ranking.map(entry => speedBar(entry.tps, maxTps)) },
    { id: 'firstToken', head: 'first token', align: 'right', cells: ranking.map(entry => firstTokenText(entry.ttftMs)) },
    { id: 'uptime', head: 'uptime', align: 'right', cells: ranking.map(entry => uptimeText(entry.uptime15m)) },
    { id: 'note', head: '', align: 'left', cells: ranking.map(entry => noteText(entry, modelId)) },
  ];
  let widths = columns.map(columnWidth);
  for (const id of DROPPABLE) {
    if (tableWidth(widths) <= width) break;
    const index = columns.findIndex(column => column.id === id);
    columns = columns.filter((_, at) => at !== index);
    widths = widths.filter((_, at) => at !== index);
  }
  const providerAt = columns.findIndex(column => column.id === 'provider');
  const overflow = tableWidth(widths) - width;
  if (overflow > 0 && providerAt >= 0) widths[providerAt] = Math.max(4, widths[providerAt] - overflow);

  const textWidth = Math.max(1, width - INDENT.length);
  const lines = [
    `${INDENT}${fit(`fastcel${GAP}${modelId}`, textWidth, 'left').trimEnd()}`,
    ...wrap(`fastest first · median over the last hour · updated ${ageText(report.fetchedAt, now)}`, textWidth).map(line => `${INDENT}${line}`),
    '',
    `${INDENT}${columns.map((column, at) => fit(column.head, widths[at], column.align)).join(GAP).trimEnd()}`,
    `${INDENT}${'─'.repeat(Math.max(0, tableWidth(widths) - INDENT.length))}`,
  ];
  for (let row = 0; row < ranking.length; row++) {
    lines.push(`${INDENT}${columns.map((column, at) => fit(column.cells[row] ?? '', widths[at], column.align)).join(GAP).trimEnd()}`);
  }
  if (report.notes.length > 0) {
    lines.push('', ...report.notes.flatMap(note => wrap(note, textWidth)).map(line => `${INDENT}${line}`));
  }
  return lines.join('\n');
}

/** @param {number | undefined} tps */
export function speedText(tps) {
  return tps === undefined ? 'no data' : `${Math.round(tps)} tok/s`;
}

/** @param {number | undefined} ms */
export function firstTokenText(ms) {
  if (ms === undefined) return '–';
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** @param {number | undefined} percent */
export function uptimeText(percent) {
  if (percent === undefined) return '–';
  return percent >= 99.95 ? '100%' : `${percent.toFixed(1)}%`;
}

/** @param {import('./ranking.js').RankedProvider} entry @param {string} modelId */
export function noteText(entry, modelId) {
  return entry.demotion ?? (isFirstParty(entry.provider, modelId) ? 'first-party' : '');
}

/** @param {number} fetchedAt @param {number} now */
export function ageText(fetchedAt, now) {
  const minutes = Math.floor((now - fetchedAt) / 60_000);
  return minutes < 1 ? 'just now' : `${minutes} min ago`;
}

/** @param {number | undefined} tps @param {number} maxTps */
function speedBar(tps, maxTps) {
  if (tps === undefined || maxTps <= 0) return '';
  const eighths = Math.round((tps / maxTps) * BAR_CELLS * 8);
  return '█'.repeat(Math.floor(eighths / 8)) + (PARTIAL_BLOCKS[eighths % 8] ?? '');
}

/** Word-wrap one-cell-per-character text to `width`, cutting words longer than a line. */
function wrap(text, width) {
  const lines = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = '';
    }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map(entry => fit(entry, width, 'left').trimEnd());
}

function columnWidth(column) {
  return Math.max(column.head.length, ...column.cells.map(cell => cell.length));
}

function tableWidth(widths) {
  return INDENT.length + widths.reduce((sum, width) => sum + width, 0) + GAP.length * Math.max(0, widths.length - 1);
}

/** Pad or cut `text` to exactly `width` cells. Every character the table draws is one cell wide. */
function fit(text, width, align) {
  if (text.length > width) return width > 1 ? `${text.slice(0, width - 1)}…` : text.slice(0, width);
  return align === 'right' ? text.padStart(width) : text.padEnd(width);
}
