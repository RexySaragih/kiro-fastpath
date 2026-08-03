import ts from 'typescript';
import type { CallEdge, ImportEdge, IndexedSymbol, SymbolKind } from '../types.js';
import { tokenizeIdentifier } from '../tokenize.js';

export interface ParseResult {
  symbols: IndexedSymbol[];
  edges: ImportEdge[];
  calls: CallEdge[];
  language: string;
}

function lineOf(source: ts.SourceFile, pos: number): number {
  return source.getLineAndCharacterOfPosition(pos).line + 1;
}

function enclosingSymbol(source: ts.SourceFile, node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
    if (ts.isMethodDeclaration(cur) && cur.name && ts.isIdentifier(cur.name)) {
      let className: string | null = null;
      let p: ts.Node | undefined = cur.parent;
      while (p) {
        if (ts.isClassDeclaration(p) && p.name) {
          className = p.name.text;
          break;
        }
        p = p.parent;
      }
      return className ? `${className}.${cur.name.text}` : cur.name.text;
    }
    if (ts.isClassDeclaration(cur) && cur.name) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

function calleeName(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
    if (ts.isIdentifier(expr.expression)) {
      return `${expr.expression.text}.${expr.name.text}`;
    }
    return expr.name.text;
  }
  return null;
}

export function parseTypeScript(path: string, content: string): ParseResult {
  const kind =
    path.endsWith('.tsx') || path.endsWith('.jsx')
      ? ts.ScriptKind.TSX
      : path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, kind);
  const symbols: IndexedSymbol[] = [];
  const edges: ImportEdge[] = [];
  const calls: CallEdge[] = [];

  const addSymbol = (
    name: string,
    node: ts.Node,
    symbolKind: SymbolKind,
    signature: string,
  ): void => {
    const start = lineOf(source, node.getStart(source));
    const end = lineOf(source, node.getEnd());
    symbols.push({
      name,
      kind: symbolKind,
      path,
      line: start,
      endLine: end,
      signature: signature.slice(0, 240),
      tokens: tokenizeIdentifier(name),
    });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({
        fromPath: path,
        toPath: '',
        toSpecifier: node.moduleSpecifier.text,
      });
    }

    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name) {
        calls.push({
          fromPath: path,
          fromSymbol: enclosingSymbol(source, node),
          toName: name,
          toPath: null,
          line: lineOf(source, node.getStart(source)),
          kind: 'call',
        });
      }
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      addSymbol(node.name.text, node, 'function', node.getText(source).split('\n')[0] ?? node.name.text);
    } else if (ts.isClassDeclaration(node) && node.name) {
      addSymbol(node.name.text, node, 'class', `class ${node.name.text}`);
      for (const member of node.members) {
        if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
          addSymbol(
            `${node.name.text}.${member.name.text}`,
            member,
            'method',
            member.getText(source).split('\n')[0] ?? member.name.text,
          );
        }
      }
    } else if (ts.isInterfaceDeclaration(node)) {
      addSymbol(node.name.text, node, 'interface', `interface ${node.name.text}`);
    } else if (ts.isTypeAliasDeclaration(node)) {
      addSymbol(node.name.text, node, 'type', `type ${node.name.text}`);
    } else if (ts.isVariableStatement(node)) {
      // Module top-level or exported only — skip method/function locals (noise).
      const isTopLevel = node.parent?.kind === ts.SyntaxKind.SourceFile;
      const isExported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (isTopLevel || isExported) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const isConst = (node.declarationList.flags & ts.NodeFlags.Const) !== 0;
            addSymbol(
              decl.name.text,
              decl,
              isConst ? 'const' : 'variable',
              decl.getText(source).split('\n')[0] ?? decl.name.text,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
  return {
    symbols,
    edges,
    calls,
    language: kind === ts.ScriptKind.JS ? 'javascript' : 'typescript',
  };
}

export function parsePython(path: string, content: string): ParseResult {
  const symbols: IndexedSymbol[] = [];
  const edges: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const def = /^\s*(async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (def?.[2]) {
      symbols.push({
        name: def[2],
        kind: 'function',
        path,
        line: i + 1,
        endLine: i + 1,
        signature: line.trim().slice(0, 240),
        tokens: tokenizeIdentifier(def[2]),
      });
      continue;
    }
    const cls = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:(]/.exec(line);
    if (cls?.[1]) {
      symbols.push({
        name: cls[1],
        kind: 'class',
        path,
        line: i + 1,
        endLine: i + 1,
        signature: line.trim().slice(0, 240),
        tokens: tokenizeIdentifier(cls[1]),
      });
      continue;
    }
    const imp = /^\s*(?:from\s+(\S+)\s+)?import\s+(.+)$/.exec(line);
    if (imp) {
      edges.push({
        fromPath: path,
        toPath: '',
        toSpecifier: (imp[1] ?? imp[2] ?? '').trim(),
      });
    }
    const call = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/.exec(line);
    if (call?.[1] && !/^(def|class|if|for|while|return)$/.test(call[1])) {
      calls.push({
        fromPath: path,
        fromSymbol: null,
        toName: call[1],
        toPath: null,
        line: i + 1,
        kind: 'call',
      });
    }
  }

  return { symbols, edges, calls, language: 'python' };
}

export function parseGo(path: string, content: string): ParseResult {
  const symbols: IndexedSymbol[] = [];
  const edges: ImportEdge[] = [];
  const calls: CallEdge[] = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const fn = /^func\s+(?:\([^)]+\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(line);
    if (fn?.[1]) {
      symbols.push({
        name: fn[1],
        kind: 'function',
        path,
        line: i + 1,
        endLine: i + 1,
        signature: line.trim().slice(0, 240),
        tokens: tokenizeIdentifier(fn[1]),
      });
      continue;
    }
    const typ = /^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+/.exec(line);
    if (typ?.[1]) {
      symbols.push({
        name: typ[1],
        kind: 'type',
        path,
        line: i + 1,
        endLine: i + 1,
        signature: line.trim().slice(0, 240),
        tokens: tokenizeIdentifier(typ[1]),
      });
    }
    const imp = /^\s*"([^"]+)"\s*$/.exec(line);
    if (imp?.[1] && i > 0 && /import\s*\(/.test(lines[i - 1] ?? '')) {
      edges.push({ fromPath: path, toPath: '', toSpecifier: imp[1] });
    }
    const call = /\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/.exec(line);
    if (call?.[1] && !/^func$/.test(call[1])) {
      calls.push({
        fromPath: path,
        fromSymbol: null,
        toName: call[1],
        toPath: null,
        line: i + 1,
        kind: 'call',
      });
    }
  }

  return { symbols, edges, calls, language: 'go' };
}

export function parseFile(path: string, content: string): ParseResult {
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path)) return parseTypeScript(path, content);
  if (path.endsWith('.py')) return parsePython(path, content);
  if (path.endsWith('.go')) return parseGo(path, content);
  return { symbols: [], edges: [], calls: [], language: 'text' };
}
