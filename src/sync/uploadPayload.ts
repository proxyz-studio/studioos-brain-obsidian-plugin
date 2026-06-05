import { sha256Hex } from './contentHash';
import { parseFrontmatter } from '../parser/frontmatter';
import { splitBodyAtDelimiter } from '../parser/bodySplit';
import type { UploadFlowB, UploadFlowC } from '../api/types';

export type UploadDecision =
  | { kind: 'flowB'; payload: UploadFlowB }
  | { kind: 'flowC'; payload: UploadFlowC }
  | { kind: 'skip'; reason: string };

/** Decide which upload flow applies to a vault file + build the payload.
 *  Caller provides the file path + raw content + a request UUID for Flow B idempotency
 *  + the last_known_server_hash from local state (the previous content_hash the plugin saw). */
export async function buildUploadPayload(args: {
  path: string;
  content: string;
  requestUuid: string;
  lastKnownServerHash: string | null;
}): Promise<UploadDecision> {
  const { frontmatter, body } = parseFrontmatter(args.content);
  const brainId = typeof frontmatter.brain_id === 'string' ? frontmatter.brain_id : null;

  if (!brainId) {
    // Flow B — new file, server creates a fresh row
    return {
      kind: 'flowB',
      payload: {
        path: args.path,
        content: args.content,
        source_type: 'note',
        request_uuid: args.requestUuid,
      },
    };
  }

  // Flow C — extract user-notes section, compute hash over JUST that section
  const { userNotes } = splitBodyAtDelimiter(body);

  if (args.lastKnownServerHash === null) {
    return {
      kind: 'skip',
      reason: 'last_known_server_hash unknown — cannot do Flow C upload safely. Wait for next /changes sync.',
    };
  }

  const contentHash = await sha256Hex(userNotes);

  return {
    kind: 'flowC',
    payload: {
      brain_id: brainId,
      content: userNotes,
      content_hash: contentHash,
      last_known_server_hash: args.lastKnownServerHash,
    },
  };
}
