import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

// Caller removes the returned directory.
export function gitFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nori-mcp-')));
  const files = {
    'package.json': JSON.stringify({ name: 'fixture', dependencies: { next: '15.0.0' } }),
    'app/page.tsx': [
      "import Link from 'next/link';",
      'export default function Page({ target }: { target: string }) {',
      '  return (',
      '    <nav>',
      '      <Link href="/about">About</Link>',
      '      <Link href={target}>Dynamic</Link>',
      '    </nav>',
      '  );',
      '}',
      '',
    ].join('\n'),
    'app/about/page.tsx': [
      "import Link from 'next/link';",
      'export default function Page() {',
      '  return <Link href="/">Home</Link>;',
      '}',
      '',
    ].join('\n'),
  };
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=nori', '-c', 'user.email=nori@example.com', ...args], { cwd: root });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');
  return root;
}
