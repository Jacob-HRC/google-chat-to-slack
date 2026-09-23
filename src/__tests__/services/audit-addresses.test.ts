import { describe, expect, it } from 'vitest';
import {
  judgeFinding,
  type VerifyContext,
} from '../../cli/commands/find-addresses';
import { collectSightings, profileIdOf } from '../../services/audit-addresses';

const ID = '117628975304902436856';

describe('audit address lookup', () => {
  it('only numeric Chat ids can be looked up', () => {
    expect(profileIdOf(`users/${ID}`)).toBe(ID);
    expect(profileIdOf('users/vault-641e54ff3bc3a6ac')).toBeUndefined();
  });

  it("keeps only the person's own events, one sighting per address", () => {
    const sightings = collectSightings(ID, {
      chat: [
        {
          actor: { email: 'Kortny.Pendergrass@hrc.email', profileId: ID },
          id: { time: '2026-09-11T10:00:00Z' },
        },
      ],
      drive: [
        {
          actor: { email: 'kortny.pendergrass@hrc.email', profileId: ID },
          id: { time: '2026-09-01T10:00:00Z' },
        },
        // Someone else acting on her file is not her.
        {
          actor: { email: 'jacob@hrc.email', profileId: '100' },
          id: { time: '2026-09-20T10:00:00Z' },
        },
      ],
    });
    expect(sightings).toEqual([
      {
        email: 'kortny.pendergrass@hrc.email',
        applications: ['chat', 'drive'],
        lastSeen: '2026-09-11T10:00:00Z',
      },
    ]);
  });

  const ctx: VerifyContext = {
    directoryHolders: new Map([
      ['jonathan@hrc.email', '102925895828495864194'],
    ]),
    slackEmails: new Set(['ken@hrc.email']),
    storeEmails: new Map([['pat@hrc.email', 'users/1']]),
  };
  const finding = (email: string) => ({
    chatUserId: `users/${ID}`,
    sightings: [{ email, applications: ['drive'], lastSeen: '' }],
  });

  it('accepts an address nobody else holds', () => {
    expect(judgeFinding(finding('kortny.pendergrass@hrc.email'), ctx)).toEqual({
      ok: true,
      email: 'kortny.pendergrass@hrc.email',
    });
  });

  it('refuses addresses that would land on someone else', () => {
    expect(judgeFinding(finding('jonathan@hrc.email'), ctx)).toMatchObject({
      ok: false,
      reason: 'now belongs to another Google account',
    });
    expect(judgeFinding(finding('ken@hrc.email'), ctx)).toMatchObject({
      ok: false,
    });
    expect(judgeFinding(finding('pat@hrc.email'), ctx)).toMatchObject({
      ok: false,
    });
    expect(
      judgeFinding(
        {
          chatUserId: `users/${ID}`,
          sightings: [
            { email: 'a@x.com', applications: [], lastSeen: '' },
            { email: 'b@x.com', applications: [], lastSeen: '' },
          ],
        },
        ctx
      ).ok
    ).toBe(false);
  });
});
