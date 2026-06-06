import { stripBrainIdFromFrontmatter } from '../parser/frontmatter';

/** Build the path + content for a (conflict) companion file.
 *  Pattern from spec: `05-BRAIN/{filename} (conflict YYYY-MM-DD HHMM).md`
 *  Strips brain_id from frontmatter so the conflict copy enters as a fresh brain item. */
export function buildConflictFile(args: {
  originalPath: string;
  loserContent: string;
  now: Date;
}): { conflictPath: string; conflictContent: string } {
  const lastDot = args.originalPath.lastIndexOf('.');
  const base = lastDot === -1 ? args.originalPath : args.originalPath.slice(0, lastDot);
  const ext = lastDot === -1 ? '' : args.originalPath.slice(lastDot);
  const stamp = formatStamp(args.now);
  const conflictPath = `${base} (conflict ${stamp})${ext}`;
  const conflictContent = stripBrainIdFromFrontmatter(args.loserContent);
  return { conflictPath, conflictContent };
}

function formatStamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
}
