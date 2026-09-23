/**
 * Serves the files a hosted-strategy archive points at, so Slack's importer
 * can fetch them while the import runs.
 *
 * The importer downloads each file's `url_private_download` and stores
 * whatever comes back, error pages included, so this server is deliberately
 * narrow: it answers only the exact paths listed in `hosted-files.json`,
 * refuses to start if any of those files is missing or the wrong size, and
 * never returns a body for anything else. Every request is logged, which is
 * also how the pilot proves whether Slack fetched the files at all.
 */
import { createReadStream } from 'node:fs';
import { appendFile, stat } from 'node:fs/promises';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { HostedFile } from '../types/slack-export';

// Anything outside printable ASCII, plus quote and backslash.
const UNSAFE_HEADER_CHARS_REGEX = /[^\x20-\x7e]|["\\]/g;

export interface AllowedFile {
  file: HostedFile;
  /** Decoded URL path, the lookup key. */
  path: string;
}

export interface FileProblem {
  file: HostedFile;
  problem: string;
}

export interface ServeProgress {
  total: number;
  /** Distinct files fetched in full at least once. */
  served: number;
  requests: number;
  rejected: number;
}

/** Decodes a URL path so `%20` and a literal space compare equal. */
export function normalizeUrlPath(rawPath: string): string | undefined {
  const withoutQuery = rawPath.split('?')[0];
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return;
  }
}

/** Every hosted file keyed by its decoded URL path. Pure. */
export function buildAllowlist(files: HostedFile[]): Map<string, AllowedFile> {
  const allowlist = new Map<string, AllowedFile>();
  for (const file of files) {
    const key = normalizeUrlPath(new URL(file.url).pathname);
    if (key) {
      allowlist.set(key, { file, path: key });
    }
  }
  return allowlist;
}

/** Checks every file exists on disk at the size the archive declared. */
export async function checkHostedFiles(
  files: HostedFile[]
): Promise<FileProblem[]> {
  const problems: FileProblem[] = [];
  for (const file of files) {
    try {
      // biome-ignore lint/nursery/noAwaitInLoop: a sequential stat pass is cheap and keeps disk load low.
      const info = await stat(file.localPath);
      if (!info.isFile()) {
        problems.push({ file, problem: 'not a regular file' });
      } else if (file.size > 0 && info.size !== file.size) {
        problems.push({
          file,
          problem: `size on disk ${info.size}, archive says ${file.size}`,
        });
      }
    } catch {
      problems.push({ file, problem: 'missing on disk' });
    }
  }
  return problems;
}

/** RFC 6266 filename, with an ASCII fallback for old clients. */
export function contentDisposition(fileName: string): string {
  const ascii = fileName.replace(UNSAFE_HEADER_CHARS_REGEX, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

export interface FileServerOptions {
  files: HostedFile[];
  port: number;
  host: string;
  logPath: string;
}

export interface RunningFileServer {
  server: Server;
  progress: ServeProgress;
  close: () => Promise<void>;
}

function clientAddress(req: IncomingMessage): string {
  const forwarded =
    req.headers['cf-connecting-ip'] ?? req.headers['x-forwarded-for'];
  return String(forwarded ?? req.socket.remoteAddress ?? '');
}

export async function startFileServer(
  options: FileServerOptions
): Promise<RunningFileServer> {
  const allowlist = buildAllowlist(options.files);
  const progress: ServeProgress = {
    total: allowlist.size,
    served: 0,
    requests: 0,
    rejected: 0,
  };
  const servedPaths = new Set<string>();

  const log = (entry: Record<string, unknown>): void => {
    appendFile(
      options.logPath,
      `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`
    ).catch((error: Error) => {
      // The log is the evidence of what Slack fetched; say so if it breaks.
      console.error(`request log write failed: ${error.message}`);
    });
  };

  const reject = (
    req: IncomingMessage,
    res: ServerResponse,
    status: number
  ): void => {
    progress.rejected += 1;
    res.writeHead(status, {
      'Content-Length': '0',
      'Cache-Control': 'no-store',
    });
    res.end();
    log({
      ip: clientAddress(req),
      ua: req.headers['user-agent'],
      method: req.method,
      path: req.url,
      status,
    });
  };

  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    progress.requests += 1;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      reject(req, res, 405);
      return;
    }
    const key = normalizeUrlPath(req.url ?? '');
    const allowed = key ? allowlist.get(key) : undefined;
    if (!allowed) {
      reject(req, res, 404);
      return;
    }
    const { file } = allowed;
    stat(file.localPath)
      .then((info) => {
        res.writeHead(200, {
          'Content-Type': file.mimeType || 'application/octet-stream',
          'Content-Length': String(info.size),
          'Content-Disposition': contentDisposition(file.fileName),
          'Cache-Control': 'no-store',
        });
        if (req.method === 'HEAD') {
          res.end();
          return;
        }
        const stream = createReadStream(file.localPath);
        stream.on('error', () => res.destroy());
        res.on('finish', () => {
          if (!servedPaths.has(allowed.path)) {
            servedPaths.add(allowed.path);
            progress.served = servedPaths.size;
          }
          log({
            ip: clientAddress(req),
            ua: req.headers['user-agent'],
            method: req.method,
            path: allowed.path,
            status: 200,
            bytes: info.size,
            conversation: file.conversationName,
            ts: file.ts,
          });
        });
        stream.pipe(res);
      })
      .catch(() => reject(req, res, 404));
  };

  const server = createServer(handle);
  await new Promise<void>((resolve, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(options.port, options.host, () => resolve());
  });
  return {
    server,
    progress,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
