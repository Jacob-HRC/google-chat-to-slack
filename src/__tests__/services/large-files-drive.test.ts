import { describe, expect, it } from 'vitest';
import {
  audienceFor,
  DRIVE_THRESHOLD_BYTES,
  receivedUpTo,
  selectLargeFiles,
} from '../../services/large-files';
import type { AttachmentRecord } from '../../types/export-store';

function rec(
  key: string,
  spaceId: string,
  size: number,
  sha256: string,
  status: AttachmentRecord['status'] = 'downloaded'
): AttachmentRecord {
  return {
    key,
    spaceId,
    kind: 'UPLOADED_CONTENT',
    messageName: `spaces/${spaceId}/messages/m.m`,
    index: 0,
    status,
    attempts: 1,
    policy: 'download',
    fileName: `${key}.mp4`,
    contentType: 'video/mp4',
    localPath: `/files/${key}.mp4`,
    size,
    sha256,
  } as AttachmentRecord;
}

const BIG = DRIVE_THRESHOLD_BYTES + 1;

describe('files too large for Slack', () => {
  it('picks downloaded files over the threshold, once per distinct file', () => {
    const files = selectLargeFiles({
      a: rec('a', 'S1', BIG, 'sha-video'),
      b: rec('b', 'S2', BIG, 'sha-video'),
      c: rec('c', 'S1', BIG * 2, 'sha-other'),
      d: rec('d', 'S1', 1000, 'sha-small'),
      e: rec('e', 'S1', BIG, 'sha-failed', 'failed'),
    });
    expect(files.map((f) => f.sha256)).toEqual(['sha-video', 'sha-other']);
    expect(files[0]).toMatchObject({
      keys: ['a', 'b'],
      spaceIds: ['S1', 'S2'],
    });
  });

  it('shares with the domain only when a conversation was public', () => {
    const participants = (id: string) =>
      id === 'DM' ? ['Pat@hrc.email', 'ken@hrc.email'] : ['sam@hrc.email'];
    expect(
      audienceFor(['DM', 'GROUP'], () => false, participants, 'hrc.email')
    ).toEqual({
      kind: 'people',
      emails: ['ken@hrc.email', 'pat@hrc.email', 'sam@hrc.email'],
    });
    expect(
      audienceFor(
        ['DM', 'PUB'],
        (id) => id === 'PUB',
        participants,
        'hrc.email'
      )
    ).toEqual({ kind: 'domain', domain: 'hrc.email' });
  });
});

describe('resumable upload bookkeeping', () => {
  const res = (range: string | null) => ({
    headers: { get: (name: string) => (name === 'range' ? range : null) },
  });
  it('resumes after the last byte the session reports, or from 0 if none', () => {
    expect(receivedUpTo(res('bytes=0-67108863'))).toBe(67_108_864);
    expect(receivedUpTo(res(null))).toBe(0);
  });
});
