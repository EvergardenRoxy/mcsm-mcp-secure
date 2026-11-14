// Shaping of panel text before it is returned to the model.

const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g;

/** Removes terminal colour codes and normalises line endings to \n. */
export const stripAnsi = (text) => text.replace(ANSI_ESCAPE, '').replace(/\r\n?/g, '\n');

/** Cuts text to maxChars, keeping its end ('tail') or its start ('head'), and says so. */
export function truncate(text, maxChars, keep = 'tail') {
  if (text.length <= maxChars) return text;
  if (keep === 'head') return text.slice(0, maxChars) + `\n…（已截断，仅显示开头 ${maxChars} 字符）`;
  return `…（已截断，仅显示末尾 ${maxChars} 字符）\n` + text.slice(-maxChars);
}

/**
 * Returns what a log gained between two snapshots, or null when the snapshots cannot be aligned
 * (the panel only returns the last N KB, so the older snapshot may have scrolled out).
 */
export function outputAddedSince(before, after) {
  if (after.startsWith(before)) return after.slice(before.length);
  const anchor = before.slice(-300);
  const anchorAt = anchor ? after.lastIndexOf(anchor) : -1;
  return anchorAt === -1 ? null : after.slice(anchorAt + anchor.length);
}
