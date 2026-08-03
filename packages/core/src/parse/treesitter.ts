import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import type { CallEdge, ImportEdge, IndexedSymbol, SymbolKind } from '../types.js';
import { tokenizeIdentifier } from '../tokenize.js';
import { parseFile as parseFileFallback, type ParseResult } from './extract.js';

const require = createRequire(import.meta.url);

const GRAMMAR_VERSION = '0.1.13';
const CDN = `https://cdn.jsdelivr.net/npm/tree-sitter-wasms@${GRAMMAR_VERSION}/out`;

const LANG_FILES: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  go: 'tree-sitter-go.wasm',
};

interface TsNode {
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  namedChildren: TsNode[];
  childForFieldName(fieldName: string): TsNode | null;
  descendantsOfType(types: string | string[]): TsNode[];
}

type LanguageLoader = { load: (path: string) => Promise<unknown> };

let parserPromise: Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Parser: any;
  languages: Map<string, unknown>;
}> | null = null;

function grammarDir(): string {
  const override = process.env.FASTPATH_GRAMMAR_DIR?.trim();
  if (override) return override;
  return join(homedir(), '.fastpath', 'grammars');
}

function languageKey(path: string): string | null {
  if (/\.tsx$/i.test(path)) return 'tsx';
  if (/\.ts$/i.test(path)) return 'typescript';
  if (/\.(js|jsx|mjs|cjs)$/i.test(path)) return 'javascript';
  if (/\.py$/i.test(path)) return 'python';
  if (/\.go$/i.test(path)) return 'go';
  return null;
}

async function downloadGrammar(file: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const url = `${CDN}/${file}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Failed to download grammar ${file}: HTTP ${res.status}`);
  }
  await pipeline(
    Readable.fromWeb(res.body as import('node:stream/web').ReadableStream),
    createWriteStream(dest),
  );
}

async function loadLanguage(Language: LanguageLoader, key: string): Promise<unknown> {
  const file = LANG_FILES[key];
  if (!file) throw new Error(`No grammar for ${key}`);
  const dest = join(grammarDir(), file);
  if (!existsSync(dest)) {
    await downloadGrammar(file, dest);
  }
  return Language.load(dest);
}

async function getParserRuntime(): Promise<{
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Parser: any;
  languages: Map<string, unknown>;
}> {
  if (parserPromise) return parserPromise;
  parserPromise = (async () => {
    // CJS binding: Parser.Language is only attached AFTER init()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Parser: any = require('web-tree-sitter');

    let runtimeWasm: string | undefined;
    try {
      runtimeWasm = require.resolve('web-tree-sitter/tree-sitter.wasm');
    } catch {
      const nested = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../node_modules/web-tree-sitter/tree-sitter.wasm',
      );
      const hoisted = join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../../node_modules/web-tree-sitter/tree-sitter.wasm',
      );
      if (existsSync(nested)) runtimeWasm = nested;
      else if (existsSync(hoisted)) runtimeWasm = hoisted;
    }

    if (runtimeWasm) {
      await Parser.init({ locateFile: () => runtimeWasm as string });
    } else {
      await Parser.init();
    }

    const Language = Parser.Language as LanguageLoader | undefined;
    if (!Language?.load) {
      throw new Error('web-tree-sitter Language.load unavailable after init');
    }

    const languages = new Map<string, unknown>();
    for (const key of Object.keys(LANG_FILES)) {
      try {
        languages.set(key, await loadLanguage(Language, key));
      } catch (err) {
        console.error(
          `[fastpath] tree-sitter grammar ${key} unavailable:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return { Parser, languages };
  })();
  return parserPromise;
}

function kindFromType(type: string): SymbolKind {
  if (type.includes('function') || type === 'method_definition' || type === 'arrow_function') {
    return type === 'method_definition' ? 'method' : 'function';
  }
  if (type.includes('class')) return 'class';
  if (type.includes('interface')) return 'interface';
  if (type.includes('type_alias') || type === 'type_declaration') return 'type';
  if (type.includes('lexical') || type.includes('variable') || type === 'const') return 'const';
  return 'other';
}

function nodeName(node: TsNode): string | null {
  const nameNode =
    node.childForFieldName('name') ||
    node.descendantsOfType('identifier')[0] ||
    node.descendantsOfType('type_identifier')[0] ||
    node.descendantsOfType('property_identifier')[0];
  return nameNode?.text ?? null;
}

function callCalleeName(node: TsNode): string | null {
  const fn = node.childForFieldName('function') || node.namedChildren[0];
  if (!fn) return null;
  if (fn.type === 'identifier' || fn.type === 'property_identifier') return fn.text;
  if (fn.type === 'member_expression' || fn.type === 'attribute' || fn.type === 'selector_expression') {
    const props = fn.descendantsOfType([
      'property_identifier',
      'identifier',
      'field_identifier',
    ]);
    if (props.length >= 2) {
      return `${props[0]!.text}.${props[props.length - 1]!.text}`;
    }
    return props[props.length - 1]?.text ?? fn.text;
  }
  const id = fn.descendantsOfType('identifier')[0];
  return id?.text ?? null;
}

function collectFromTree(
  path: string,
  content: string,
  root: TsNode,
  language: string,
): ParseResult {
  const symbols: IndexedSymbol[] = [];
  const edges: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  const TARGET = new Set([
    'function_declaration',
    'function_definition',
    'method_definition',
    'class_declaration',
    'class_definition',
    'interface_declaration',
    'type_alias_declaration',
    'type_declaration',
    'lexical_declaration',
    'method_declaration',
  ]);

  let currentSymbol: string | null = null;

  const visit = (node: TsNode, classPrefix = ''): void => {
    if (node.type === 'import_statement' || node.type === 'import_declaration') {
      const src =
        node.descendantsOfType('string')[0]?.text?.replace(/^['"]|['"]$/g, '') ||
        node.descendantsOfType('interpreted_string_literal')[0]?.text?.replace(
          /^`|`$/g,
          '',
        );
      if (src) {
        edges.push({ fromPath: path, toPath: '', toSpecifier: src });
      }
    }

    if (node.type === 'call_expression' || node.type === 'call') {
      const name = callCalleeName(node);
      if (name) {
        calls.push({
          fromPath: path,
          fromSymbol: currentSymbol,
          toName: name,
          toPath: null,
          line: node.startPosition.row + 1,
          kind: 'call',
        });
      }
    }

    if (TARGET.has(node.type)) {
      // Locals inside classes/functions: never index as ClassName.local
      if (node.type === 'lexical_declaration' && classPrefix) {
        for (const child of node.namedChildren) visit(child, classPrefix);
        return;
      }
      // Nested lexical (inside function body, not class): skip symbol, still walk calls
      if (node.type === 'lexical_declaration' && currentSymbol) {
        for (const child of node.namedChildren) visit(child, classPrefix);
        return;
      }

      let name = nodeName(node);
      if (node.type === 'lexical_declaration') {
        const id = node.descendantsOfType('identifier')[0];
        name = id?.text ?? null;
      }
      if (name) {
        // Methods keep Class.method; locals never get classPrefix
        const isMethod =
          node.type === 'method_definition' || node.type === 'method_declaration';
        const full = isMethod && classPrefix ? `${classPrefix}.${name}` : name;
        const prev = currentSymbol;
        currentSymbol = full;
        const start = node.startPosition.row + 1;
        const end = node.endPosition.row + 1;
        const body = content.slice(
          node.startIndex,
          Math.min(node.endIndex, node.startIndex + 400),
        );
        symbols.push({
          name: full,
          kind: kindFromType(node.type),
          path,
          line: start,
          endLine: end,
          signature: body.split('\n')[0]?.trim().slice(0, 240) || full,
          tokens: `${tokenizeIdentifier(full)} ${body.slice(0, 200)}`,
        });
        if (node.type.includes('class')) {
          for (const child of node.namedChildren) visit(child, name);
          currentSymbol = prev;
          return;
        }
        for (const child of node.namedChildren) visit(child, classPrefix);
        currentSymbol = prev;
        return;
      }
    }

    for (const child of node.namedChildren) visit(child, classPrefix);
  };

  visit(root);
  return { symbols, edges, calls, language };
}

/** Parse with web-tree-sitter; falls back to TS/regex parsers. */
export async function parseFileAst(path: string, content: string): Promise<ParseResult> {
  const key = languageKey(path);
  if (!key || process.env.FASTPATH_PARSER === 'legacy') {
    return parseFileFallback(path, content);
  }

  try {
    const { Parser, languages } = await getParserRuntime();
    const lang = languages.get(key);
    if (!lang) return parseFileFallback(path, content);

    const parser = new Parser();
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    if (!tree?.rootNode) return parseFileFallback(path, content);
    const result = collectFromTree(path, content, tree.rootNode as TsNode, key);
    if (!result.symbols.length) return parseFileFallback(path, content);
    if (!result.edges.length || !result.calls.length) {
      const fb = parseFileFallback(path, content);
      if (!result.edges.length) result.edges = fb.edges;
      if (!result.calls.length) result.calls = fb.calls;
    }
    return result;
  } catch (err) {
    console.error(
      '[fastpath] tree-sitter parse failed, using legacy parser:',
      err instanceof Error ? err.message : err,
    );
    return parseFileFallback(path, content);
  }
}

export async function warmParsers(): Promise<string[]> {
  const { languages } = await getParserRuntime();
  return [...languages.keys()];
}

/** Sync wrapper for call sites that still use parseFile — prefer parseFileAst. */
export function parseFile(path: string, content: string): ParseResult {
  return parseFileFallback(path, content);
}
