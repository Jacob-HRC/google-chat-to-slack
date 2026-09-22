import { describe, expect, it } from 'vitest';
import {
  extractLinks,
  extractLinksFromAnnotations,
  extractLinksFromText,
} from '../../utils/links';
import { MSG_WITH_ATTACHMENTS } from '../fixtures/chat-api';

describe('extractLinksFromText', () => {
  it('recognises Docs, Sheets, Slides, Forms and Drive URLs', () => {
    const text = [
      'doc https://docs.google.com/document/d/DOC_1/edit',
      'sheet https://docs.google.com/spreadsheets/d/SHEET_1/edit#gid=0',
      'slides https://docs.google.com/presentation/d/SLIDE_1/edit?usp=sharing',
      'form https://docs.google.com/forms/d/FORM_1/viewform',
      'file https://drive.google.com/file/d/FILE_1/view?usp=drive_link',
      'open https://drive.google.com/open?id=FILE_2',
      'folder https://drive.google.com/drive/u/0/folders/FOLDER_1',
    ].join('\n');
    const links = extractLinksFromText(text);
    expect(links.map((l) => [l.kind, l.driveFileId])).toEqual([
      ['docs', 'DOC_1'],
      ['sheets', 'SHEET_1'],
      ['slides', 'SLIDE_1'],
      ['forms', 'FORM_1'],
      ['drive', 'FILE_1'],
      ['drive', 'FILE_2'],
      ['drive-folder', 'FOLDER_1'],
    ]);
    expect(links[1].url).toBe(
      'https://docs.google.com/spreadsheets/d/SHEET_1/edit#gid=0'
    );
  });

  it('stops at Chat link markup and recognises Chat, Meet and Calendar links', () => {
    const text =
      'See <https://docs.google.com/document/d/DOC_9/edit|the doc> and https://chat.google.com/room/AAAAxyz?cls=1 plus https://meet.google.com/abc-defg-hij and https://calendar.google.com/calendar/event?eid=1';
    const links = extractLinksFromText(text);
    expect(links[0]).toMatchObject({
      kind: 'docs',
      driveFileId: 'DOC_9',
      url: 'https://docs.google.com/document/d/DOC_9/edit',
    });
    expect(links[1]).toMatchObject({
      kind: 'chat-space',
      spaceName: 'spaces/AAAAxyz',
    });
    expect(links[2].kind).toBe('meet');
    expect(links[3].kind).toBe('calendar');
  });

  it('returns nothing for plain text', () => {
    expect(extractLinksFromText('no links here')).toEqual([]);
    expect(extractLinksFromText(undefined)).toEqual([]);
  });
});

describe('extractLinksFromAnnotations', () => {
  it('reads Drive rich links with their MIME type', () => {
    const links = extractLinksFromAnnotations(MSG_WITH_ATTACHMENTS.annotations);
    expect(links).toEqual([
      {
        url: 'https://docs.google.com/spreadsheets/d/1SHEETID123/edit#gid=0',
        kind: 'sheets',
        driveFileId: '1SHEETID123',
        driveMimeType: 'application/vnd.google-apps.spreadsheet',
        source: 'annotation',
      },
    ]);
  });

  it('classifies other rich link types', () => {
    const links = extractLinksFromAnnotations([
      {
        type: 'RICH_LINK',
        richLinkMetadata: {
          richLinkType: 'CHAT_SPACE',
          uri: 'https://chat.google.com/room/AAAA1',
          chatSpaceLinkData: { space: 'spaces/AAAA1' },
        },
      },
      {
        type: 'RICH_LINK',
        richLinkMetadata: {
          richLinkType: 'MEET_SPACE',
          uri: 'https://meet.google.com/x',
        },
      },
      { type: 'USER_MENTION' },
    ]);
    expect(links.map((l) => l.kind)).toEqual(['chat-space', 'meet']);
    expect(links[0].spaceName).toBe('spaces/AAAA1');
  });
});

describe('extractLinks', () => {
  it('merges annotation and text links and dedupes by Drive id', () => {
    const links = extractLinks(MSG_WITH_ATTACHMENTS);
    expect(links.map((l) => [l.kind, l.driveFileId, l.source])).toEqual([
      ['sheets', '1SHEETID123', 'annotation'],
      ['drive-folder', '1FOLDERID', 'text'],
    ]);
  });
});
