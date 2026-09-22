import { describe, expect, it } from 'vitest';
import {
  describeGoogleError,
  GOOGLE_AUTH_MODES,
  GOOGLE_SCOPES,
  parseServiceAccountKey,
  resolveAuthMode,
} from '../../services/google-auth';

const validKey = JSON.stringify({
  type: 'service_account',
  project_id: 'hrc-chat-migration',
  client_email: 'migrator@hrc-chat-migration.iam.gserviceaccount.com',
  client_id: '1234567890',
  private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n',
});

describe('resolveAuthMode', () => {
  it('prefers the service account when both are configured', () => {
    expect(
      resolveAuthMode({ hasServiceAccount: true, hasOAuthToken: true })
    ).toBe(GOOGLE_AUTH_MODES.SERVICE_ACCOUNT);
  });

  it('uses OAuth when only a refresh token exists', () => {
    expect(
      resolveAuthMode({ hasServiceAccount: false, hasOAuthToken: true })
    ).toBe(GOOGLE_AUTH_MODES.OAUTH);
  });

  it('honours an explicit request', () => {
    expect(
      resolveAuthMode({
        hasServiceAccount: true,
        hasOAuthToken: true,
        requested: 'oauth',
      })
    ).toBe(GOOGLE_AUTH_MODES.OAUTH);
  });

  it('fails when the requested mode is not configured', () => {
    expect(() =>
      resolveAuthMode({
        hasServiceAccount: false,
        hasOAuthToken: true,
        requested: 'service-account',
      })
    ).toThrow('no service account is configured');
    expect(() =>
      resolveAuthMode({
        hasServiceAccount: true,
        hasOAuthToken: false,
        requested: 'oauth',
      })
    ).toThrow('login google');
  });

  it('fails with guidance when nothing is configured', () => {
    expect(() =>
      resolveAuthMode({ hasServiceAccount: false, hasOAuthToken: false })
    ).toThrow('--service-account');
  });
});

describe('parseServiceAccountKey', () => {
  it('accepts a real key file shape', () => {
    const key = parseServiceAccountKey(validKey);
    expect(key.client_email).toBe(
      'migrator@hrc-chat-migration.iam.gserviceaccount.com'
    );
    expect(key.client_id).toBe('1234567890');
  });

  it('rejects malformed JSON', () => {
    expect(() => parseServiceAccountKey('{not json')).toThrow('not valid JSON');
  });

  it('rejects OAuth client files and keys with missing fields', () => {
    expect(() =>
      parseServiceAccountKey(JSON.stringify({ installed: { client_id: 'x' } }))
    ).toThrow('type');
    expect(() =>
      parseServiceAccountKey(
        JSON.stringify({ type: 'service_account', client_email: 'a@b.c' })
      )
    ).toThrow('private_key');
  });
});

describe('GOOGLE_SCOPES', () => {
  it('covers spaces, messages, memberships, drive and directory', () => {
    expect(GOOGLE_SCOPES).toEqual([
      'https://www.googleapis.com/auth/chat.spaces.readonly',
      'https://www.googleapis.com/auth/chat.messages.readonly',
      'https://www.googleapis.com/auth/chat.memberships.readonly',
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
    ]);
  });
});

describe('describeGoogleError', () => {
  it('explains unauthorized_client as a delegation scope problem', () => {
    expect(
      describeGoogleError(
        new Error('unauthorized_client: Client is unauthorized')
      )
    ).toMatch('Domain-wide delegation');
  });

  it('explains invalid_grant as a bad subject', () => {
    expect(
      describeGoogleError(new Error('invalid_grant: Invalid email'))
    ).toMatch('impersonated user');
  });

  it('adds permission hints for 403 responses', () => {
    const error = Object.assign(
      new Error('Not Authorized to access this resource/api'),
      {
        response: { status: 403 },
      }
    );
    expect(describeGoogleError(error)).toMatch('Workspace admin');
  });

  it('passes other errors through', () => {
    expect(describeGoogleError(new Error('boom'))).toBe('boom');
    expect(describeGoogleError('string error')).toBe('string error');
  });
});
