import { BRAIN_MANAGED_DELIMITER } from './frontmatter';

export type BodySplit = {
  /** Content above the delimiter (brain-managed section). */
  brainManaged: string;
  /** Content below the delimiter (user notes). */
  userNotes: string;
  /** True if the delimiter was found. False = no split, the whole body is treated as user notes. */
  hasDelimiter: boolean;
};

/** Split a file body at the BRAIN_MANAGED_DELIMITER.
 *  For Flow C uploads, the plugin sends only `userNotes` (not the full file).
 *  When no delimiter: the file is a fresh user-authored note (Flow B); the whole content is "user notes".
 *  Excludes the delimiter line itself + the "## My notes" header that follows on the user-notes side. */
export function splitBodyAtDelimiter(body: string): BodySplit {
  const idx = body.indexOf(BRAIN_MANAGED_DELIMITER);
  if (idx === -1) {
    return { brainManaged: '', userNotes: body.trim(), hasDelimiter: false };
  }
  const brainManaged = body.slice(0, idx).trimEnd();
  let userNotes = body.slice(idx + BRAIN_MANAGED_DELIMITER.length);
  // Strip leading blank lines + the "## My notes" header that the server's render emits
  userNotes = userNotes.replace(/^\s*\n/, '');
  userNotes = userNotes.replace(/^##\s+My notes\s*\n?/, '');
  return { brainManaged, userNotes: userNotes.trim(), hasDelimiter: true };
}
