import { dirname, join } from 'node:path';
import ts from 'typescript6';
import type { SourceFile } from '../graph/source-hash.js';

const CODE_FILE = /\.(?:tsx?|jsx?|mjs|cjs)$/;
const NON_PROGRAM_FILE = /(?:\.test\.|\.spec\.|__tests__|\/e2e\/|\/playwright\/|\.stories\.|\.d\.ts$)/;

export function isProgramFile(path: string): boolean {
  return CODE_FILE.test(path) && !NON_PROGRAM_FILE.test(`/${path}`);
}

const BASE_OPTIONS: ts.CompilerOptions = {
  skipLibCheck: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
};

type MemoryFiles = {
  readonly text: (path: string) => string | undefined;
  readonly has: (path: string) => boolean;
  readonly hasDirectory: (path: string) => boolean;
};

function memoryFiles({ root, files }: { root: string; files: readonly SourceFile[] }): MemoryFiles {
  const contents = new Map<string, Uint8Array>();
  const texts = new Map<string, string>();
  const directories = new Set<string>();
  for (const file of files) {
    const path = join(root, file.path);
    contents.set(path, file.content);
    for (let dir = dirname(path); !directories.has(dir); dir = dirname(dir)) {
      directories.add(dir);
      if (dirname(dir) === dir) break;
    }
  }
  return {
    text(path) {
      const cached = texts.get(path);
      if (cached !== undefined) return cached;
      const content = contents.get(path);
      if (content === undefined) return undefined;
      const text = Buffer.from(content).toString('utf8');
      texts.set(path, text);
      return text;
    },
    has: (path) => contents.has(path),
    hasDirectory: (path) => directories.has(path),
  };
}

function compilerOptions({ root, memory }: { root: string; memory: MemoryFiles }): ts.CompilerOptions {
  const configPath = join(root, 'tsconfig.json');
  const host: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: (path) => memory.has(path) || ts.sys.fileExists(path),
    readFile: (path) => memory.text(path) ?? ts.sys.readFile(path),
  };
  const text = host.readFile(configPath);
  let options = BASE_OPTIONS;
  if (text !== undefined) {
    const { config } = ts.parseConfigFileTextToJson(configPath, text);
    const parsed = ts.parseJsonConfigFileContent(config ?? {}, host, root, undefined, configPath);
    options = { ...options, ...parsed.options };
  }
  return {
    ...options,
    noEmit: true,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    baseUrl: options.baseUrl ?? root,
    ignoreDeprecations: '6.0',
  };
}

// The bundled lib files never change within a process, and re-parsing them dominated repeated scans.
const libFiles = new Map<string, ts.SourceFile>();

// Tracked files come from memory so analysis sees exactly the content the source hash covers.
export function createProgram({ root, files }: { root: string; files: readonly SourceFile[] }): ts.Program {
  const memory = memoryFiles({ root, files });
  const options = compilerOptions({ root, memory });
  const base = ts.createCompilerHost(options, true);
  const libDir = dirname(ts.getDefaultLibFilePath(options));
  const host: ts.CompilerHost = {
    ...base,
    getCurrentDirectory: () => root,
    fileExists: (path) => memory.has(path) || base.fileExists(path),
    readFile: (path) => memory.text(path) ?? base.readFile(path),
    directoryExists: (path) => memory.hasDirectory(path) || (base.directoryExists?.(path) ?? false),
    realpath: (path) => (memory.has(path) ? path : (base.realpath?.(path) ?? path)),
    getSourceFile(fileName, languageVersion, onError, shouldCreate) {
      const text = memory.text(fileName);
      if (text !== undefined) return ts.createSourceFile(fileName, text, languageVersion, true);
      if (dirname(fileName) !== libDir) return base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
      const key = `${fileName}\0${JSON.stringify(languageVersion)}`;
      let lib = libFiles.get(key);
      if (lib === undefined) {
        lib = base.getSourceFile(fileName, languageVersion, onError, shouldCreate);
        if (lib !== undefined) libFiles.set(key, lib);
      }
      return lib;
    },
  };
  const rootNames = files.filter((file) => isProgramFile(file.path)).map((file) => join(root, file.path));
  return ts.createProgram({ rootNames, options, host });
}
