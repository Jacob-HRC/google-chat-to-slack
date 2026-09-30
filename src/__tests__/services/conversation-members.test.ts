import { describe, expect, it } from 'vitest';
import {
  type ConversationInput,
  namedSpaceMembers,
} from '../../services/slack-archive/conversations';
import type { ArchiveUserMapping } from '../../types/slack-export';

function person(id: string): ArchiveUserMapping {
  return {
    slackId: `U${id}`,
    name: id,
    status: 'active',
    placeholder: false,
    deleted: false,
    importAction: 'merge',
    guest: false,
  } as ArchiveUserMapping;
}

function space(memberIds: string[], authorIds: string[]): ConversationInput {
  return {
    space: {
      memberships: memberIds.map((id) => ({
        chatUserId: `users/${id}`,
        memberType: 'HUMAN',
      })),
    },
    messages: authorIds.map((id) => ({
      senderId: `users/${id}`,
      senderType: 'HUMAN',
    })),
    users: new Map(
      [...memberIds, ...authorIds].map((id) => [`users/${id}`, person(id)])
    ),
  } as unknown as ConversationInput;
}

describe('named Space channel members', () => {
  it('are the people in the Space now, not everyone who ever posted', () => {
    // Tracy posted, then left the Space: her messages stay, the channel doesn't.
    const members = namedSpaceMembers(
      space(['ken', 'amy'], ['ken', 'tracy', 'amy'])
    );
    expect(members.map((m) => m.mapping.name)).toEqual(['ken', 'amy']);
  });

  it('keep the posters of a Space nobody is in any more', () => {
    const members = namedSpaceMembers(space([], ['tracy', 'ken']));
    expect(members.map((m) => m.mapping.name)).toEqual(['tracy', 'ken']);
  });
});
