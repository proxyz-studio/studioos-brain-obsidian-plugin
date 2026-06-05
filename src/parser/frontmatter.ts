/** The brain-managed delimiter — must EXACTLY match server render.ts (PR-2 Chunk 2). */
export const BRAIN_MANAGED_DELIMITER = '<!-- ↑ Brain-managed. Edit your own notes below. ↓ -->';

export type ParsedFrontmatter = {
  hasFrontmatter: boolean;
  frontmatter: Record<string, string | number | boolean | string[]>;
  body: string;
};

/** Parse the YAML frontmatter block (between leading `---` delimiters).
 *  Narrow schema: supports scalars (string/number/bool) + flow-style lists `[a, b, c]`.
 *  Mirrors the server's hand-written serializer in PR-2 frontmatter.ts. */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const lines = content.split('\n');
  if (lines[0] !== '---') return { hasFrontmatter: false, frontmatter: {}, body: content };

  const closeIdx = lines.indexOf('---', 1);
  if (closeIdx === -1) return { hasFrontmatter: false, frontmatter: {}, body: content };

  const fmLines = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n').replace(/^\n/, ''); // trim leading newline after fm

  const frontmatter: Record<string, string | number | boolean | string[]> = {};
  for (const line of fmLines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const valueRaw = line.slice(colonIdx + 1).trim();
    frontmatter[key] = parseValue(valueRaw);
  }
  return { hasFrontmatter: true, frontmatter, body };
}

function parseValue(raw: string): string | number | boolean | string[] {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map(s => unquote(s.trim()));
  }
  return unquote(raw);
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  return s;
}

/** Strip the brain_id field from a frontmatter block in the original content.
 *  Used when writing (conflict) files — the orphan should enter as a fresh Flow B brain item. */
export function stripBrainIdFromFrontmatter(content: string): string {
  const { hasFrontmatter } = parseFrontmatter(content);
  if (!hasFrontmatter) return content;
  // Drop brain_id + other server-owned fields that would confuse the server
  const lines = content.split('\n');
  const out: string[] = [];
  let inFm = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i === 0 && line === '---') { inFm = true; out.push(line); continue; }
    if (inFm && line === '---') { inFm = false; out.push(line); continue; }
    if (inFm) {
      const key = line.slice(0, line.indexOf(':')).trim();
      if (['brain_id', 'content_hash', 'sync_version'].includes(key)) continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
