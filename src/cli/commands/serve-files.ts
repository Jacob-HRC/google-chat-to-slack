import path from 'node:path';
import type { CommandModule } from 'yargs';
import { checkHostedFiles, startFileServer } from '../../services/file-server';
import type { HostedFile } from '../../types/slack-export';
import { readJsonFile } from '../../utils/fs-atomic';

type ServeFilesArgs = {
  hostedFiles?: string;
  port: number;
  host: string;
  log?: string;
  checkOnly?: boolean;
};

const PROGRESS_INTERVAL_MS = 30_000;
const PROBLEMS_SHOWN = 10;
const HOSTED_SUFFIX = '.hosted-files.json';

function defaultLogPath(hostedFiles: string): string {
  const base = hostedFiles.endsWith(HOSTED_SUFFIX)
    ? hostedFiles.slice(0, -HOSTED_SUFFIX.length)
    : hostedFiles;
  return `${base}.served.jsonl`;
}

export const serveFilesCommand: CommandModule<object, ServeFilesArgs> = {
  command: 'serve-files',
  describe:
    'Serve the files of a hosted-strategy archive so Slack can fetch them during the import. Answers only the listed paths and logs every request.',
  builder: (yargs) =>
    yargs
      .option('hosted-files', {
        describe:
          'The <archive>.hosted-files.json written by build-slack-archive --files hosted.',
        type: 'string',
        demandOption: true,
      })
      .option('port', {
        describe: 'Local port. Put a tunnel (e.g. cloudflared) in front of it.',
        type: 'number',
        default: 8787,
      })
      .option('host', {
        describe:
          'Interface to bind. The default keeps it off the network; the tunnel connects locally.',
        type: 'string',
        default: '127.0.0.1',
      })
      .option('log', {
        describe:
          'Request log (JSON lines). Defaults to <archive>.served.jsonl beside the archive.',
        type: 'string',
      })
      .option('check-only', {
        describe: 'Check every file is on disk at the right size, then exit.',
        type: 'boolean',
        default: false,
      })
      .strict(),
  handler: async (argv) => {
    try {
      if (!argv.hostedFiles) {
        throw new Error('--hosted-files is required');
      }
      const listPath = path.resolve(argv.hostedFiles);
      const files = (await readJsonFile<HostedFile[]>(listPath)) ?? [];
      if (files.length === 0) {
        throw new Error(`${listPath} lists no files`);
      }
      const problems = await checkHostedFiles(files);
      if (problems.length > 0) {
        console.error(
          `❌ ${problems.length} of ${files.length} file(s) cannot be served. Slack would store an empty or broken file for each, so the server will not start:`
        );
        for (const { file, problem } of problems.slice(0, PROBLEMS_SHOWN)) {
          console.error(`   ${file.localPath}: ${problem}`);
        }
        process.exit(1);
      }
      console.log(
        `✅ All ${files.length} file(s) present at the expected size.`
      );
      if (argv.checkOnly) {
        return;
      }

      const logPath = path.resolve(argv.log ?? defaultLogPath(listPath));
      const running = await startFileServer({
        files,
        port: argv.port,
        host: argv.host,
        logPath,
      });
      console.log(
        `Serving ${running.progress.total} file(s) on http://${argv.host}:${argv.port}`
      );
      console.log(`Request log: ${logPath}`);
      console.log('Leave this running until the Slack import reports done.');

      const report = (): void => {
        const p = running.progress;
        console.log(
          `${new Date().toLocaleTimeString()} · ${p.served}/${p.total} files fetched · ${p.requests} requests · ${p.rejected} rejected`
        );
      };
      const timer = setInterval(report, PROGRESS_INTERVAL_MS);
      const stop = async (): Promise<void> => {
        clearInterval(timer);
        report();
        await running.close();
        process.exit(0);
      };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('serve-files failed:', message);
      process.exit(1);
    }
  },
};
