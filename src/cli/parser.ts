import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { archiveChannelsCommand } from './commands/archive-channels';
import { buildSlackArchiveCommand } from './commands/build-slack-archive';
import { channelVisibilityCommand } from './commands/channel-visibility';
import { exportCommand } from './commands/export';
import { exportWorkspaceCommand } from './commands/export-workspace';
import { findAddressesCommand } from './commands/find-addresses';
import { importCommand } from './commands/import';
import { importVaultCommand } from './commands/import-vault';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { migrateCommand } from './commands/migrate';
import { recoverNamesCommand } from './commands/recover-names';
import { restoreReactionsCommand } from './commands/restore-reactions';
import { serveFilesCommand } from './commands/serve-files';
import { slackConnectCommand } from './commands/slack-connect';
import { slackMembersCommand } from './commands/slack-members';
import { stageLargeFilesCommand } from './commands/stage-large-files';
import { transformCommand } from './commands/transform';
import { uploadFilesCommand } from './commands/upload-files';
import { usersCommand } from './commands/users';
import { vaultCommand } from './commands/vault';
import { verifyCommand } from './commands/verify';
import { verifySlackCommand } from './commands/verify-slack';

export function getParser() {
  const parser = yargs(hideBin(process.argv));

  parser.command(loginCommand);
  parser.command(logoutCommand);
  parser.command(migrateCommand);
  parser.command(exportCommand);
  parser.command(transformCommand);
  parser.command(importCommand);
  parser.command(usersCommand);
  parser.command(exportWorkspaceCommand);
  parser.command(verifyCommand);
  parser.command(vaultCommand);
  parser.command(importVaultCommand);
  parser.command(recoverNamesCommand);
  parser.command(findAddressesCommand);
  parser.command(slackMembersCommand);
  parser.command(channelVisibilityCommand);
  parser.command(buildSlackArchiveCommand);
  parser.command(serveFilesCommand);
  parser.command(stageLargeFilesCommand);
  parser.command(verifySlackCommand);
  parser.command(uploadFilesCommand);
  parser.command(slackConnectCommand);
  parser.command(restoreReactionsCommand);
  parser.command(archiveChannelsCommand);

  return parser;
}
