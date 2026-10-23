import { describe, expect, it } from 'vitest';
import { parseOrigin, parsePageUrl } from '../graph/model.js';
import { parseInteractions } from './interactions.js';

const origin = parseOrigin('http://127.0.0.1:3000');
const parse = (value: unknown) => parseInteractions(origin, JSON.stringify(value));

describe('parseInteractions', () => {
  it('resolves the page against the origin and keeps fill order', () => {
    const [interaction] = parse({
      interactions: [
        { page: '/login', fill: { Email: 'a@b.c', Password: 'pw' }, click: 'Log in', allow: ['POST /api/session'] },
      ],
    });
    expect(interaction).toEqual({
      page: parsePageUrl(origin, '/login'),
      fill: [
        { label: 'Email', value: 'a@b.c' },
        { label: 'Password', value: 'pw' },
      ],
      click: 'Log in',
      allow: [{ method: 'POST', path: '/api/session' }],
    });
  });

  it('allows a click with nothing to fill', () => {
    const [interaction] = parse({ interactions: [{ page: '/p', click: 'Sign out', allow: ['DELETE /api/session'] }] });
    expect(interaction?.fill).toEqual([]);
  });

  it.each([
    ['another origin', { page: 'https://example.com/login', click: 'Go', allow: ['POST /a'] }],
    ['a GET rule', { page: '/p', click: 'Go', allow: ['GET /a'] }],
    ['a lowercase method', { page: '/p', click: 'Go', allow: ['post /a'] }],
    ['a rule with a query', { page: '/p', click: 'Go', allow: ['POST /a?x=1'] }],
    ['a rule with a full url', { page: '/p', click: 'Go', allow: ['POST http://127.0.0.1:3000/a'] }],
    ['no rules', { page: '/p', click: 'Go', allow: [] }],
    ['a missing click', { page: '/p', allow: ['POST /a'] }],
    ['an unknown key', { page: '/p', click: 'Go', allow: ['POST /a'], session: 'x' }],
    ['a non-string value', { page: '/p', fill: { A: 1 }, click: 'Go', allow: ['POST /a'] }],
  ])('rejects %s', (_name, interaction) => {
    expect(() => parse({ interactions: [interaction] })).toThrow(/--interactions/);
  });

  it('rejects text that is not the expected shape', () => {
    expect(() => parseInteractions(origin, '{')).toThrow(/not valid JSON/);
    expect(() => parse([])).toThrow(/malformed/);
  });
});
