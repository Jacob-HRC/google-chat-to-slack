/**
 * Streams documents out of a Vault Chat mbox.
 *
 * The file runs to several gigabytes, so it is read in chunks and split on the
 * `From ` separator rather than loaded whole. Vault's separator always carries
 * the space id and a timestamp (`From <spaceId>-MBI-FLAT:<time>@xxx …`), which
 * is specific enough to avoid splitting on a `From ` that appears inside a
 * message body.
 */
import { createReadStream } from 'node:fs';

const SEPARATOR = /^From ([A-Za-z0-9_-]+)-MBI-[A-Z]+:(\S+)@/;

export interface MboxDocument {
  /** Chat space id taken from the separator line. */
  spaceId: string;
  /** Raw document text, headers included, separator line excluded. */
  raw: string;
}

const CHUNK_BYTES = 4 * 1024 * 1024;

/**
 * Yields each document in the mbox, in file order.
 *
 * Reads in chunks and keeps at most one document in memory. An earlier
 * line-array version allocated millions of short strings for the largest
 * documents (the biggest here is 200 MB) and exhausted the heap.
 */
export async function* streamMboxDocuments(
  filePath: string
): AsyncGenerator<MboxDocument> {
  const stream = createReadStream(filePath, {
    encoding: 'utf-8',
    highWaterMark: CHUNK_BYTES,
  });

  let pending = '';
  let spaceId: string | undefined;
  let documentStart = 0;

  const scan = function* (upTo: number): Generator<MboxDocument> {
    let searchFrom = documentStart;
    while (searchFrom < upTo) {
      const lineEnd = pending.indexOf('\n', searchFrom);
      if (lineEnd < 0 || lineEnd >= upTo) {
        break;
      }
      const line = pending.slice(searchFrom, lineEnd);
      const match = SEPARATOR.exec(line);
      if (match) {
        if (spaceId) {
          yield { spaceId, raw: pending.slice(documentStart, searchFrom) };
        }
        spaceId = match[1];
        documentStart = lineEnd + 1;
        // Drop everything already emitted so the buffer does not grow.
        pending = pending.slice(documentStart);
        searchFrom = 0;
        documentStart = 0;
        continue;
      }
      searchFrom = lineEnd + 1;
    }
    return;
  };

  for await (const chunk of stream) {
    pending += chunk as string;
    // Only scan complete lines; the tail may be a partial separator.
    const lastNewline = pending.lastIndexOf('\n');
    if (lastNewline < 0) {
      continue;
    }
    yield* scan(lastNewline + 1);
  }
  yield* scan(pending.length);
  if (spaceId) {
    yield { spaceId, raw: pending.slice(documentStart) };
  }
}

export { SEPARATOR };
