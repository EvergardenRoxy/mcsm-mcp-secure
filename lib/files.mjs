// Rules for instance file paths and for text that may be saved back to the panel.
import { McsmError } from './panel.mjs';

// Keep writes well below the daemon's 5 MB read limit.
export const MAX_WRITE_BYTES = 1024 * 1024;

const BINARY_EXTENSION =
  /\.(gz|zip|jar|7z|rar|tar|xz|bz2|png|jpe?g|gif|webp|ico|dat|dat_old|mca|mcr|nbt|schem|schematic|litematic|class|db|sqlite|exe|dll|so|dylib)$/i;

export const isBinaryPath = (path) => BINARY_EXTENSION.test(path);

/** Rejects path traversal and returns the path with a leading slash. */
export function normalizePath(path) {
  if (path.includes('\0') || path.split(/[\\/]+/).includes('..')) throw new McsmError('路径不能包含 ".."');
  return path.startsWith('/') ? path : '/' + path;
}

/** Text is editable when it is valid UTF-8 (the daemon decodes binary as NUL / U+FFFD) within the size limit. */
export function assertEditableText(text) {
  if (/[\0\uFFFD]/.test(text)) throw new McsmError('文件内容包含 NUL 或无效 UTF-8 字符，拒绝修改可能的二进制文件');
  if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_BYTES) throw new McsmError('文本文件修改上限为 1 MiB（按 UTF-8 字节计算）');
  return text;
}
