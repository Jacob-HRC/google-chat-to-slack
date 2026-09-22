import { describe, expect, it } from 'vitest';
import {
  buildRoomQuery,
  chunkRoomIds,
  describeVaultError,
  MAX_ROOM_IDS_PER_REQUEST,
  safeExportName,
} from '../../services/vault';

describe('chunkRoomIds', () => {
  it('keeps a small list in one request', () => {
    expect(chunkRoomIds(['a', 'b', 'c'])).toEqual([['a', 'b', 'c']]);
    expect(chunkRoomIds([])).toEqual([]);
  });

  it('splits at Vault’s 500-space limit', () => {
    const ids = Array.from({ length: 1201 }, (_, i) => `space-${i}`);
    const chunks = chunkRoomIds(ids);
    expect(chunks.map((c) => c.length)).toEqual([500, 500, 201]);
    expect(chunks.flat()).toEqual(ids);
    expect(MAX_ROOM_IDS_PER_REQUEST).toBe(500);
  });

  it('honours a smaller batch size', () => {
    expect(chunkRoomIds(['a', 'b', 'c'], 2)).toEqual([['a', 'b'], ['c']]);
  });
});

describe('buildRoomQuery', () => {
  it('addresses spaces by id rather than by member account', () => {
    expect(buildRoomQuery(['AAAA1', 'AAAA2'])).toEqual({
      corpus: 'HANGOUTS_CHAT',
      dataScope: 'ALL_DATA',
      searchMethod: 'ROOM',
      hangoutsChatInfo: { roomId: ['AAAA1', 'AAAA2'] },
      startTime: undefined,
      endTime: undefined,
      terms: undefined,
    });
  });

  it('passes through the optional time window and terms', () => {
    const query = buildRoomQuery(['AAAA1'], {
      startTime: '2024-01-01T00:00:00Z',
      endTime: '2025-01-01T00:00:00Z',
      terms: 'budget',
    });
    expect(query.startTime).toBe('2024-01-01T00:00:00Z');
    expect(query.endTime).toBe('2025-01-01T00:00:00Z');
    expect(query.terms).toBe('budget');
  });

  it('copies the id list so later mutation cannot leak in', () => {
    const ids = ['AAAA1'];
    const query = buildRoomQuery(ids);
    ids.push('AAAA2');
    expect(query.hangoutsChatInfo?.roomId).toEqual(['AAAA1']);
  });
});

describe('safeExportName', () => {
  it('strips the characters Vault rejects in export names', () => {
    expect(safeExportName("chat~!$'(),;@:/?export")).toBe(
      'chat------------export'
    );
    expect(safeExportName('orphan spaces 1')).toBe('orphan spaces 1');
  });

  it('falls back when nothing usable is left', () => {
    expect(safeExportName('   ')).toBe('chat-export');
  });
});

describe('describeVaultError', () => {
  it('explains a missing Vault scope', () => {
    expect(
      describeVaultError(new Error('unauthorized_client: not authorized'))
    ).toContain('ediscovery');
  });

  it('explains a missing Vault privilege on 403', () => {
    const error = Object.assign(new Error('Permission denied'), {
      response: { status: 403 },
    });
    expect(describeVaultError(error)).toContain('Vault privileges');
  });

  it('prefers the API error message and explains 400s', () => {
    const error = Object.assign(new Error('Request failed'), {
      response: {
        status: 400,
        data: {
          error: { message: 'Corpus type HANGOUTS_CHAT is not supported.' },
        },
      },
    });
    const described = describeVaultError(error);
    expect(described).toContain('Corpus type HANGOUTS_CHAT is not supported.');
    expect(described).toContain('500');
  });

  it('passes other errors through', () => {
    expect(describeVaultError(new Error('boom'))).toBe('boom');
  });
});
