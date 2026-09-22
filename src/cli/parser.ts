import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { buildSlackArchiveCommand } from './commands/build-slack-archive';
import { exportCommand } from './commands/export';
import { exportWorkspaceCommand } from './commands/export-workspace';
import { importCommand } from './commands/import';
import { importVaultCommand } from './commands/import-vault';
import { loginCommand } from './commands/login';
import { logoutCommand } from './commands/logout';
import { migrateCommand } from './commands/migrate';
import { recoverNamesCommand } from './commands/recover-names';
import { transformCommand } from './commands/transform';
import { usersCommand } from './commands/users';
import { vaultCommand } from './commands/vault';
import { verifyCommand } from './commands/verify';

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
  parser.command(buildSlackArchiveCommand);

  return parser;
}
