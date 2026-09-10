/** Split by a nearby newline where possible; never break a UTF-16 surrogate pair. */
export function splitText(text: string, max = 3500): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let end = rest.lastIndexOf('\n', max);
    if (end < max / 2) end = max;
    if (/[\uD800-\uDBFF]/.test(rest[end - 1])) end--;
    parts.push(rest.slice(0, end)); rest = rest.slice(end);
  }
  if (rest) parts.push(rest);
  return parts;
}

export function previewText(text: string, max = 160): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  if (compact.length <= max) return compact;
  const end = /[\uD800-\uDBFF]/.test(compact[max - 1]) ? max - 1 : max;
  return compact.slice(0, end) + '…';
}
