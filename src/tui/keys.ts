/**
 * 统一按键解析：把原始 stdin 字节序列翻译成语义键名。
 * 覆盖标准 CSI 方向键、Kitty 键盘协议 / modifyOtherKeys 扩展格式与常用控制键。
 */
export function parseKeyName(data: string): string {
  if (data === '\r' || data === '\n') return 'enter';
  // 标准方向键：\x1b[A/B/C/D
  if (data === '\x1b[D') return 'left';
  if (data === '\x1b[C') return 'right';
  if (data === '\x1b[A') return 'up';
  if (data === '\x1b[B') return 'down';
  // 翻页键：PgUp / PgDn
  if (data === '\x1b[5~') return 'pageup';
  if (data === '\x1b[6~') return 'pagedown';
  // Kitty 键盘协议 / modifyOtherKeys 扩展格式：\x1b[1;<mod>:<base>A 等，
  // 实测某些终端（如用户环境）发 \x1b[1;1:1B —— 尾字母即方向，
  // modifier 为 1（无修饰）时视作普通方向键。
  const extArrow = /^\x1b\[1;\d+[:;]\d+([ABCD])$/.exec(data);
  if (extArrow) {
    const map: Record<string, string> = { A: 'up', B: 'down', C: 'right', D: 'left' };
    return map[extArrow[1]!] || data;
  }
  // Kitty/modifyOtherKeys 的 Esc：\x1b[27u / \x1b[27;<mod>u
  if (/^\x1b\[27(;\d+)?u$/.test(data)) return 'escape';
  if (data === '\x1b') return 'escape';
  if (data === '\x03') return 'ctrl+c';
  return data.length === 1 ? data.toLowerCase() : data;
}
