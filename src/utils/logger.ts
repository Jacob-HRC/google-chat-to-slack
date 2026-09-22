import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'error' | 'warning';
export type LogType =
  | 'attachment_download'
  | 'user_fetch'
  | 'avatar_download'
  | 'file_copy'
  | 'file_upload'
  | 'message_post'
  | 'reaction_add'
  | 'space_list'
  | 'membership_list'
  | 'message_list'
  | 'reaction_list'
  | 'drive_metadata'
  | 'drive_download'
  | 'user_resolve'
  | 'admin_search'
  | 'store'
  | 'verify';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  type: LogType;
  identifier: string;
  message: string;
  details?: string;
}

export class Logger {
  private entries: LogEntry[] = [];
  private context: string;

  constructor(context = 'Export') {
    this.context = context;
  }

  addError(
    type: LogType,
    identifier: string,
    message: string,
    details?: string
  ): void {
    this.addEntry('error', type, identifier, message, details);
  }

  addWarning(
    type: LogType,
    identifier: string,
    message: string,
    details?: string
  ): void {
    this.addEntry('warning', type, identifier, message, details);
  }

  addPermissionWarning(
    type: LogType,
    identifier: string,
    resourceType: string
  ): void {
    this.addWarning(
      type,
      identifier,
      `Access denied to ${resourceType}. The resource may be private or you may lack permission to access it.`
    );
  }

  private addEntry(
    level: LogLevel,
    type: LogType,
    identifier: string,
    message: string,
    details?: string
  ): void {
    this.entries.push({
      timestamp: new Date().toISOString(),
      level,
      type,
      identifier,
      message,
      details,
    });
  }

  getEntries(): readonly LogEntry[] {
    return this.entries;
  }

  hasErrors(): boolean {
    return this.getErrorCount() > 0;
  }

  hasWarnings(): boolean {
    return this.getWarningCount() > 0;
  }

  hasIssues(): boolean {
    return this.entries.length > 0;
  }

  getErrorCount(): number {
    return this.entries.filter((entry) => entry.level === 'error').length;
  }

  getWarningCount(): number {
    return this.entries.filter((entry) => entry.level === 'warning').length;
  }

  getTotalCount(): number {
    return this.entries.length;
  }

  private countByType(level: LogLevel): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const entry of this.entries) {
      if (entry.level === level) {
        counts[entry.type] = (counts[entry.type] ?? 0) + 1;
      }
    }
    return counts;
  }

  getErrorsByType(): Record<string, number> {
    return this.countByType('error');
  }

  getWarningsByType(): Record<string, number> {
    return this.countByType('warning');
  }

  /**
   * Writes the log. With `baseDir` the file goes to `<baseDir>/logs/<name>`;
   * without it, to `data/logs/output.log` relative to the working directory.
   */
  async writeLog(baseDir?: string, fileName = 'output.log'): Promise<string> {
    if (!this.hasIssues()) {
      return '';
    }

    const logsDir = baseDir
      ? path.join(baseDir, 'logs')
      : path.resolve('data/logs');
    const logPath = path.join(logsDir, fileName);
    const logContent = this.formatLog();

    await mkdir(logsDir, { recursive: true });
    await writeFile(logPath, logContent, 'utf-8');
    return logPath;
  }

  private formatLog(): string {
    const errors = this.entries.filter((entry) => entry.level === 'error');
    const warnings = this.entries.filter((entry) => entry.level === 'warning');

    const header = `${this.context} Log
Generated: ${new Date().toISOString()}
Total Issues: ${this.getTotalCount()} (${errors.length} errors, ${warnings.length} warnings)

${'='.repeat(80)}

`;

    let content = header;

    if (errors.length > 0) {
      content += `ERRORS (${errors.length})\n`;
      content += `${'='.repeat(20)}\n\n`;

      content += errors
        .map((entry, index) => this.formatEntry(entry, index + 1, 'ERROR'))
        .join('\n\n');

      content += '\n\n';
    }

    if (warnings.length > 0) {
      content += `WARNINGS (${warnings.length})\n`;
      content += `${'='.repeat(20)}\n\n`;

      content += warnings
        .map((entry, index) => this.formatEntry(entry, index + 1, 'WARNING'))
        .join('\n\n');

      content += '\n';
    }

    return content;
  }

  private formatEntry(
    entry: LogEntry,
    index: number,
    levelLabel: string
  ): string {
    const baseEntry = `[${index}] ${entry.timestamp}
Level: ${levelLabel}
Type: ${entry.type.replace('_', ' ').toUpperCase()}
Item: ${entry.identifier}
Message: ${entry.message}`;

    return entry.details
      ? `${baseEntry}
Details: ${entry.details}`
      : baseEntry;
  }
}
