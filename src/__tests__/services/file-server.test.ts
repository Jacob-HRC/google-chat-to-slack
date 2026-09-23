import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAllowlist,
  checkHostedFiles,
  contentDisposition,
  normalizeUrlPath,
  type RunningFileServer,
  startFileServer,
} from '../../services/file-server';
import type { HostedFile } from '../../types/slack-export';

const BASE = 'https://files.example.com/s3cr3t';

async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000
): Promise<void> {
  const started = Date.now();
  while (!condition() && Date.now() - started < timeoutMs) {
    // biome-ignore lint/nursery/noAwaitInLoop: polling a condition.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function hosted(localPath: string, name: string, size: number): HostedFile {
  return {
    url: `${BASE}/AAAA/msg.1/${encodeURIComponent(name)}`,
    localPath,
    fileName: name,
    mimeType: 'text/plain',
    size,
    conversationName: 'general',
    ts: '1700000000.000001',
  };
}

describe('file server', () => {
  let dir: string;
  let files: HostedFile[];
  let running: RunningFileServer;
  let origin: string;
  let logPath: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'gcts-serve-'));
    const local = path.join(dir, 'Budget 2026.txt');
    await writeFile(local, 'hello budget');
    files = [hosted(local, 'Budget 2026.txt', 12)];
    logPath = path.join(dir, 'served.jsonl');
    running = await startFileServer({
      files,
      port: 0,
      host: '127.0.0.1',
      logPath,
    });
    const { port } = running.server.address() as AddressInfo;
    origin = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await running.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('keys the allowlist by decoded path', () => {
    const allowlist = buildAllowlist(files);
    expect([...allowlist.keys()]).toEqual([
      '/s3cr3t/AAAA/msg.1/Budget 2026.txt',
    ]);
    expect(normalizeUrlPath('/a%20b?x=1')).toBe('/a b');
    expect(normalizeUrlPath('/%E0%A4%A')).toBeUndefined();
  });

  it('flags files that are missing or the wrong size', async () => {
    const problems = await checkHostedFiles([
      ...files,
      hosted(path.join(dir, 'gone.txt'), 'gone.txt', 5),
      { ...files[0], size: 99 },
    ]);
    expect(problems.map((p) => p.problem)).toEqual([
      'missing on disk',
      'size on disk 12, archive says 99',
    ]);
  });

  it('serves a listed file with its name and type', async () => {
    const response = await fetch(
      `${origin}/s3cr3t/AAAA/msg.1/Budget%202026.txt`
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello budget');
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-disposition')).toContain(
      "filename*=UTF-8''Budget%202026.txt"
    );
    // The server counts a file once its response has finished, which can
    // land a moment after the client has read the body.
    await waitFor(() => running.progress.served === 1);
    expect(running.progress.served).toBe(1);
  });

  it('answers nothing else, with no body to be mistaken for a file', async () => {
    for (const probe of [
      '/s3cr3t/AAAA/msg.1/',
      '/s3cr3t/../../etc/passwd',
      '/AAAA/msg.1/Budget%202026.txt',
    ]) {
      // biome-ignore lint/nursery/noAwaitInLoop: a few sequential probes.
      const response = await fetch(`${origin}${probe}`);
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('');
    }
    const post = await fetch(`${origin}/s3cr3t/AAAA/msg.1/Budget%202026.txt`, {
      method: 'POST',
    });
    expect(post.status).toBe(405);
  });

  it('logs every request', async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = (await readFile(logPath, 'utf-8')).trim().split('\n');
    const entries = lines.map((line) => JSON.parse(line));
    expect(entries.some((e) => e.status === 200 && e.bytes === 12)).toBe(true);
    expect(entries.filter((e) => e.status === 404).length).toBeGreaterThan(0);
  });

  it('escapes awkward file names in headers', () => {
    expect(contentDisposition('Café "plan".pdf')).toBe(
      `attachment; filename="Caf_ _plan_.pdf"; filename*=UTF-8''Caf%C3%A9%20%22plan%22.pdf`
    );
  });
});
