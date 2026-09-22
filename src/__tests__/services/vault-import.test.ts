import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assignAttachments,
  decodeEntities,
  parseVaultHtml,
  parseVaultTimestamp,
} from '../../services/vault-import/html';
import {
  messageKey,
  syntheticUserId,
} from '../../services/vault-import/importer';
import { SEPARATOR } from '../../services/vault-import/mbox';
import {
  parseVaultMetadata,
  summarizeSpaces,
} from '../../services/vault-import/metadata';
import {
  decodeQuotedPrintable,
  parseMimeDocument,
  splitOnBoundary,
} from '../../services/vault-import/mime';

const MESSAGE_ID_REGEX = /^[A-Za-z0-9_-]+$/;
const VAULT_TIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000000Z$/;
const SYNTHETIC_ID_REGEX = /^users\/vault-[0-9a-f]{16}$/;

const FIXTURE = path.join(
  __dirname,
  '..',
  'fixtures',
  'vault-document.mbox.txt'
);

async function loadFixture(): Promise<string> {
  const raw = await readFile(FIXTURE, 'utf-8');
  // Drop the mbox separator line, as the streamer does.
  return raw.split('\n').slice(1).join('\n');
}

describe('mbox separator', () => {
  it('recognises Vault separators and extracts the space id', () => {
    const match = SEPARATOR.exec(
      'From AAAAA6HZ1qY-MBI-FLAT:2022-09-25T20:23:36.246289@xxx Mon Sep 26 03:23:36 2022'
    );
    expect(match?.[1]).toBe('AAAAA6HZ1qY');
  });

  it('ignores a plain "From " line inside a message body', () => {
    expect(SEPARATOR.exec('From the desk of Ken')).toBeNull();
    expect(SEPARATOR.exec('From: ken@hrc.email')).toBeNull();
  });
});

describe('quoted-printable', () => {
  it('joins soft line breaks and decodes UTF-8 escapes', () => {
    expect(decodeQuotedPrintable('a=\nb')).toBe('ab');
    expect(decodeQuotedPrintable('Caf=C3=A9')).toBe('Café');
    expect(decodeQuotedPrintable('=E2=80=AF')).toBe(' ');
  });

  it('leaves a lone equals sign alone', () => {
    expect(decodeQuotedPrintable('1 = 1')).toBe('1 = 1');
  });
});

describe('splitOnBoundary', () => {
  it('drops the preamble and the closing marker', () => {
    const body = 'preamble\n--B\npart one\n--B\npart two\n--B--\nepilogue';
    expect(splitOnBoundary(body, 'B')).toEqual(['part one\n', 'part two\n']);
  });
});

describe('parseVaultTimestamp', () => {
  it('reads Vault’s rendered timestamps as UTC', () => {
    expect(parseVaultTimestamp('September 28, 2022 at 1:01:10 PM UTC')).toBe(
      '2022-09-28T13:01:10.000000Z'
    );
    expect(parseVaultTimestamp('January 3, 2024 at 12:05:09 AM UTC')).toBe(
      '2024-01-03T00:05:09.000000Z'
    );
    expect(parseVaultTimestamp('July 7, 2023 at 12:30:00 PM UTC')).toBe(
      '2023-07-07T12:30:00.000000Z'
    );
  });

  it('tolerates the narrow no-break space Google emits', () => {
    expect(parseVaultTimestamp('March 1, 2024 at 9:00:00 AM UTC')).toBe(
      '2024-03-01T09:00:00.000000Z'
    );
  });

  it('returns nothing for text that is not a timestamp', () => {
    expect(parseVaultTimestamp('no date here')).toBeUndefined();
  });
});

describe('decodeEntities', () => {
  it('handles named and numeric entities', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &#39;d&#39; &#x41;')).toBe(
      "a & b <c> 'd' A"
    );
  });
});

describe('parsing a real exported document', () => {
  it('splits the MIME document into HTML and attachments', async () => {
    const document = parseMimeDocument(await loadFixture());
    expect(document.messageId).toBe(
      'AAAAA6HZ1qY-MBI-FLAT:2022-09-25T20:23:36.246289'
    );
    expect(document.headers.from).toBe('ken@hrc.email');
    expect(document.html).toContain('data-id=');
    expect(document.attachments.length).toBeGreaterThan(0);
    expect(document.attachments[0].filename).toBeTruthy();
  });

  it('recovers messages with sender, timestamp and text', async () => {
    const document = parseMimeDocument(await loadFixture());
    const messages = parseVaultHtml(document.html as string);
    expect(messages.length).toBeGreaterThan(5);

    const first = messages[0];
    expect(first.messageId).toMatch(MESSAGE_ID_REGEX);
    expect(first.senderEmail).toContain('@');
    expect(first.createTime).toMatch(VAULT_TIME_REGEX);
    expect(messages.every((m) => m.messageId)).toBe(true);

    // Every message Vault renders should carry a usable timestamp.
    expect(messages.filter((m) => !m.createTime)).toEqual([]);
  });

  it('separates an app-relayed post from its text', async () => {
    const document = parseMimeDocument(await loadFixture());
    const messages = parseVaultHtml(document.html as string);
    const relayed = messages.find((m) => m.viaUser);
    if (relayed) {
      expect(relayed.viaUser).toBeTruthy();
      expect(relayed.text.startsWith('* Via User')).toBe(false);
    }
  });

  it('ties rendered filenames to the message that shared them', async () => {
    const document = parseMimeDocument(await loadFixture());
    const messages = parseVaultHtml(document.html as string);
    const partNames = document.attachments.map((p) => p.filename ?? '');
    const assigned = assignAttachments(messages, partNames);
    const owners = [...assigned.keys()];
    expect(owners.length).toBeGreaterThan(0);
    for (const owner of owners) {
      expect(messages.some((m) => m.messageId === owner)).toBe(true);
    }
  });
});

describe('threaded messages', () => {
  it('reads past the "N Replies" marker to find the header', () => {
    const html =
      '<div data-id="z1" style="s"><div style="s">' +
      '<div style="s"><span>2 Replies</span></div>' +
      '<div><span style="s">ken@hrc.email </span>September 30, 2022 at 2:22:12 PM UTC</div>' +
      '<div style="s">Okay thanks!</div>' +
      '</div></div>';
    const [message] = parseVaultHtml(html);
    expect(message).toMatchObject({
      messageId: 'z1',
      senderEmail: 'ken@hrc.email',
      createTime: '2022-09-30T14:22:12.000000Z',
      text: 'Okay thanks!',
      replyCount: 2,
    });
    expect(message.attachmentNames).toEqual([]);
  });

  it('treats a plain message as having no reply count', () => {
    const html =
      '<div data-id="p1" style="s"><div style="s">' +
      '<div><span style="s">ken@hrc.email </span>September 30, 2022 at 2:22:12 PM UTC</div>' +
      '<div style="s">hello</div>' +
      '<div style="s"><div>report.pdf</div></div>' +
      '</div></div>';
    const [message] = parseVaultHtml(html);
    expect(message.replyCount).toBeUndefined();
    expect(message.text).toBe('hello');
    expect(message.attachmentNames).toEqual(['report.pdf']);
  });

  it('ignores a link preview card as an attachment', () => {
    const html =
      '<div data-id="l1" style="s"><div style="s">' +
      '<div><span style="s">ken@hrc.email </span>September 30, 2022 at 2:22:12 PM UTC</div>' +
      '<div style="s">see <a href="https://example.com">this</a></div>' +
      '<div style="s"><div><a href="https://example.com">https://example.com</a></div></div>' +
      '</div></div>';
    const [message] = parseVaultHtml(html);
    expect(message.attachmentNames).toEqual([]);
    expect(message.text).toContain('see');
  });
});

describe('assignAttachments', () => {
  const message = (id: string, names: string[]) => ({
    messageId: id,
    text: '',
    attachmentNames: names,
  });

  it('claims each MIME part at most once when a name repeats', () => {
    const messages = [
      message('m1', ['report.pdf']),
      message('m2', ['report.pdf']),
    ];
    const assigned = assignAttachments(messages, ['report.pdf', 'report.pdf']);
    expect(assigned.get('m1')).toEqual([0]);
    expect(assigned.get('m2')).toEqual([1]);
  });

  it('ignores a rendered name with no matching part', () => {
    const assigned = assignAttachments([message('m1', ['missing.pdf'])], []);
    expect(assigned.size).toBe(0);
  });
});

describe('metadata sidecar', () => {
  const xml = `<?xml version='1.0'?>
<Root><Batch><Documents>
  <Document DocID='abc'>
    <Tags>
      <Tag TagName='RoomID' TagDataType='Text' TagValue='AAAAA6HZ1qY'/>
      <Tag TagName='RoomName' TagDataType='Text' TagValue='dept-it-internal-chat'/>
      <Tag TagName='ConversationType' TagDataType='Text' TagValue='Room'/>
      <Tag TagName='Participants' TagDataType='LongText' TagValue='ken@hrc.email,jacob@hrc.email'/>
      <Tag TagName='#DateFirstMessageSent' TagDataType='DateTime' TagValue='2022-09-20T18:31:18.656Z'/>
    </Tags>
    <Files><File FileType='Native'>
      <ExternalFile FileName='AAAAA6HZ1qY-MBI-FLAT:2022-09-19T23:31:18.656498' FileSize='20449'/>
    </File></Files>
  </Document>
  <Document DocID='def'>
    <Tags>
      <Tag TagName='RoomID' TagDataType='Text' TagValue='AAAAA6HZ1qY'/>
      <Tag TagName='RoomName' TagDataType='Text' TagValue='dept-it-internal-chat'/>
      <Tag TagName='Participants' TagDataType='LongText' TagValue='chris@hrc.email'/>
    </Tags>
    <Files><File FileType='Native'>
      <ExternalFile FileName='AAAAA6HZ1qY-MBI-FLAT:2022-09-25T20:23:36.246289'/>
    </File></Files>
  </Document>
</Documents></Batch></Root>`;

  it('keys documents by their native file name', () => {
    const parsed = parseVaultMetadata(xml);
    expect(parsed.size).toBe(2);
    const first = parsed.get('AAAAA6HZ1qY-MBI-FLAT:2022-09-19T23:31:18.656498');
    expect(first).toMatchObject({
      roomId: 'AAAAA6HZ1qY',
      roomName: 'dept-it-internal-chat',
      conversationType: 'Room',
      dateFirstMessage: '2022-09-20T18:31:18.656Z',
    });
    expect(first?.participants).toEqual(['ken@hrc.email', 'jacob@hrc.email']);
  });

  it('merges participants across every document of a space', () => {
    const spaces = summarizeSpaces(parseVaultMetadata(xml).values());
    const space = spaces.get('AAAAA6HZ1qY');
    expect(space?.roomName).toBe('dept-it-internal-chat');
    expect([...(space?.participants ?? [])].sort()).toEqual([
      'chris@hrc.email',
      'jacob@hrc.email',
      'ken@hrc.email',
    ]);
  });
});

describe('identity helpers', () => {
  it('collapses API and Vault message ids to the same key', () => {
    expect(messageKey('spaces/AAAA/messages/nQXfDwWUN5s.nQXfDwWUN5s')).toBe(
      'nQXfDwWUN5s'
    );
    expect(messageKey('nQXfDwWUN5s')).toBe('nQXfDwWUN5s');
    expect(messageKey('spaces/AAAA/messages/nQXfDwWUN5s')).toBe('nQXfDwWUN5s');
  });

  it('derives a stable id for someone known only by email', () => {
    const id = syntheticUserId('Ken@HRC.email');
    expect(id).toBe(syntheticUserId('ken@hrc.email'));
    expect(id).toMatch(SYNTHETIC_ID_REGEX);
    expect(id).not.toBe(syntheticUserId('other@hrc.email'));
  });
});
