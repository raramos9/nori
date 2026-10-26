import { describe, expect, it } from 'vitest';
import { redactUserinfo } from './git.js';

describe('redactUserinfo', () => {
  it('hides the credentials of every URL in a message and leaves the rest alone', () => {
    expect(
      redactUserinfo(
        "fatal: unable to access 'https://x-access-token:ghs_secret@github.com/o/r.git/' and ssh://git@host:2222/o/r",
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/o/r.git/' and ssh://***@host:2222/o/r");
    expect(redactUserinfo('git@github.com:o/r.git is fine')).toBe('git@github.com:o/r.git is fine');
  });
});
