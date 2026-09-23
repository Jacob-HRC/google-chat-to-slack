/**
 * Finds addresses for people the Directory no longer knows, from Google's
 * audit logs (Admin SDK Reports API).
 *
 * Every audit event names its actor by email and by profile id, and the
 * profile id is the same number as the Chat user id. So a lookup by id is
 * exact: no name matching, no guessing. It reaches anyone who did something
 * in the domain (signed in, touched a shared Drive file, used Chat) within
 * the logs' retention, about six months. That includes outside people who
 * opened HRC files. People who left earlier are simply not found.
 */
import { google } from 'googleapis';
import type { StoredUser } from '../types/export-store';
import { getScopedAuthClient } from './google-auth';

export const REPORTS_SCOPES = [
  'https://www.googleapis.com/auth/admin.reports.audit.readonly',
] as const;

/** Applications whose events name their actor; most informative first. */
export const AUDIT_APPLICATIONS = [
  'chat',
  'login',
  'drive',
  'token',
  'meet',
  'calendar',
  'user_accounts',
  'admin',
] as const;

const NUMERIC_ID_REGEX = /^\d+$/;
const MISSING_STATUS = new Set([400, 404]);

export interface AuditSighting {
  email: string;
  applications: string[];
  lastSeen: string;
}

export interface AddressFinding {
  chatUserId: string;
  name?: string;
  sightings: AuditSighting[];
}

/** Profile id for a Chat user id, or undefined for ids the logs cannot hold. Pure. */
export function profileIdOf(chatUserId: string): string | undefined {
  const id = chatUserId.replace('users/', '');
  return NUMERIC_ID_REGEX.test(id) ? id : undefined;
}

interface RawEvent {
  actor?: { email?: string | null; profileId?: string | null } | null;
  id?: { time?: string | null } | null;
}

/** Folds events into one sighting per address, keeping only the person's own. Pure. */
export function collectSightings(
  profileId: string,
  eventsByApp: Record<string, RawEvent[]>
): AuditSighting[] {
  const byEmail = new Map<string, AuditSighting>();
  for (const [app, events] of Object.entries(eventsByApp)) {
    for (const event of events) {
      const email = event.actor?.email?.toLowerCase();
      if (!email || event.actor?.profileId !== profileId) {
        continue;
      }
      const sighting = byEmail.get(email) ?? {
        email,
        applications: [],
        lastSeen: '',
      };
      if (!sighting.applications.includes(app)) {
        sighting.applications.push(app);
      }
      const time = event.id?.time ?? '';
      if (time > sighting.lastSeen) {
        sighting.lastSeen = time;
      }
      byEmail.set(email, sighting);
    }
  }
  return [...byEmail.values()].sort((a, b) =>
    b.lastSeen.localeCompare(a.lastSeen)
  );
}

/** Looks each person up by profile id across the audit applications. */
export async function findAddressesInAuditLogs(
  people: StoredUser[],
  subject?: string
): Promise<AddressFinding[]> {
  const auth = await getScopedAuthClient(REPORTS_SCOPES, subject);
  const reports = google.admin({ version: 'reports_v1', auth });
  const findings: AddressFinding[] = [];
  for (const person of people) {
    const profileId = profileIdOf(person.chatUserId);
    if (!profileId) {
      continue;
    }
    const eventsByApp: Record<string, RawEvent[]> = {};
    for (const app of AUDIT_APPLICATIONS) {
      try {
        // biome-ignore lint/nursery/noAwaitInLoop: a handful of people, sequential to stay under the Reports quota.
        const res = await reports.activities.list({
          userKey: profileId,
          applicationName: app,
          maxResults: 5,
        });
        eventsByApp[app] = (res.data.items ?? []) as RawEvent[];
      } catch (error) {
        const code = (error as { code?: number }).code;
        if (!(code && MISSING_STATUS.has(code))) {
          throw error;
        }
      }
    }
    findings.push({
      chatUserId: person.chatUserId,
      name: person.fullName ?? person.placeholderName,
      sightings: collectSightings(profileId, eventsByApp),
    });
  }
  return findings;
}
