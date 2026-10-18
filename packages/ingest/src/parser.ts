/**
 * Codebase parser — Phase 1 ingestion core.
 *
 * Uses the TypeScript Compiler API (via ts-morph) to extract the entities that
 * populate the RIPPLE graph:
 *
 *   (:File)-[:CONTAINS]->(:Function | :Class | :Type)
 *   (:File)-[:DEPENDS_ON { symbolsUsed }]->(:File)
 *   (:Function | :Class)-[:CALLS]->(:Function | :Class)
 *   (:ApiRoute)-[:HANDLED_BY]->(:Function)          (Next.js route conventions)
 *
 * Design notes (per docs/implementation.md §5):
 *  - every stored node carries a stable `key` so MERGE upserts work on re-run
 *  - node_modules / build outputs are excluded at the glob level
 */
import {
  Project,
  SyntaxKind,
  Node,
  type CallExpression,
  type NewExpression,
  type PropertyAccessExpression,
  type SourceFile,
} from "ts-morph";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface ParsedFile {
  key: string;
  path: string;
  hash: string;
  loc: number;
  isTest: boolean;
}

export interface ParsedSymbol {
  key: string;
  kind: "Function" | "Class" | "Type";
  name: string;
  fileKey: string;
  line: number;
  signature?: string;
  exported: boolean;
}

export interface ParsedDependency {
  fromFile: string;
  toFile: string;
  symbolsUsed: string[];
}

export interface ParsedCall {
  callerKey: string;
  callerKind: "File" | "Function" | "Class" | "Test";
  calleeKey: string;
  callSite: string;
}

export interface ParsedTest {
  key: string;
  name: string;
  fileKey: string;
}

export interface ParsedTested {
  subjectFileKey: string;
  testKey: string;
}

export interface ParsedRoute {
  key: string;
  fileKey: string;
  method: string;
  path: string;
  handler: string;
}

export interface ParseOutput {
  files: ParsedFile[];
  symbols: ParsedSymbol[];
  dependencies: ParsedDependency[];
  calls: ParsedCall[];
  tests: ParsedTest[];
  tested: ParsedTested[];
  routes: ParsedRoute[];
}

const INCLUDE_GLOBS = ["**/*.{ts,tsx,js,jsx}"];
const EXCLUDE_DIRS = ["node_modules", "dist", "build", "out", ".next", ".git", "coverage"];
const TEST_FILE_RE = /[.](test|spec)[.][jt]sx?$|__tests__\/|[/]tests?[/]/i;

const GLOBAL_EXCLUDE: ReadonlySet<string> = new Set(EXCLUDE_DIRS);

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

/** Segment-based exclusion so `checkout/` never trips the `out` dir rule. */
function isExcluded(absPath: string): boolean {
  const segments = toPosix(absPath).toLowerCase().split("/");
  return segments.some((seg) => GLOBAL_EXCLUDE.has(seg));
}

/** Load the target repo into a ts-morph project (tsconfig aware if present). */
function loadProject(rootPath: string): Project {
  const tsconfig = `${rootPath}/tsconfig.json`;

  const project = existsSync(tsconfig)
    ? new Project({
        tsConfigFilePath: tsconfig,
        skipAddingFilesFromTsConfig: true,
      })
    : new Project({ compilerOptions: { allowJs: true, jsx: 4 } });

  const globs = INCLUDE_GLOBS.map((g) => `${toPosix(rootPath)}/${g}`);
  project.addSourceFilesAtPaths(globs);

  // filter excluded dirs after glob expansion (ts-morph globs respect ignorePaths,
  // but be explicit so stray generated files never enter the graph)
  for (const file of project.getSourceFiles()) {
    if (isExcluded(file.getFilePath())) {
      project.removeSourceFile(file);
    }
  }
  return project;
}

interface SymbolIndexEntry { key: string; fileKey: string }

export class CodebaseParser {
  private readonly project: Project;
  private readonly root: string;

  constructor(rootPath: string) {
    this.root = toPosix(resolve(rootPath)).replace(/\/+$/, "");
    this.project = loadProject(rootPath);
  }

  get fileCount(): number {
    return this.project.getSourceFiles().length;
  }

  relPath(sdf: SourceFile): string {
    const abs = toPosix(sdf.getFilePath());
    const base = this.root;
    let rel = abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : abs;
    if (rel.startsWith("/")) rel = rel.slice(1);
    return rel;
  }

  parse(): ParseOutput {
    const out: ParseOutput = {
      files: [],
      symbols: [],
      dependencies: [],
      calls: [],
      tests: [],
      tested: [],
      routes: [],
    };

    const exportIndex = new Map<string, SymbolIndexEntry>(); // exported name -> key

    // ── pass 1: files + symbols ───────────────────────────────────────────
    for (const sdf of this.project.getSourceFiles()) {
      const rel = this.relPath(sdf);
      const key = rel;
      const content = sdf.getFullText();
      const isTest = TEST_FILE_RE.test(rel);

      out.files.push({
        key,
        path: rel,
        hash: createHash("sha1").update(content).digest("hex").slice(0, 12),
        loc: content.split("\n").length,
        isTest,
      });

      // symbols
      for (const fn of sdf.getFunctions()) {
        this.addSymbol(out, exportIndex, "Function", key, fn.getName(), fn.getStartLineNumber(true), fn.isExported(), paramsSignature(fn));
      }
      for (const cls of sdf.getClasses()) {
        this.addSymbol(out, exportIndex, "Class", key, cls.getName(), cls.getStartLineNumber(true), cls.isExported(), undefined);
      }
      for (const iface of sdf.getInterfaces()) {
        this.addSymbol(out, exportIndex, "Type", key, iface.getName(), iface.getStartLineNumber(true), iface.isExported(), undefined);
      }
      for (const alias of sdf.getTypeAliases()) {
        this.addSymbol(out, exportIndex, "Type", key, alias.getName(), alias.getStartLineNumber(true), alias.isExported(), undefined);
      }
      // arrow/function-expression consts: export const handler = async () => {}
      for (const stmt of sdf.getVariableStatements()) {
        for (const decl of stmt.getDeclarations()) {
          const init = decl.getInitializer();
          const isCallable = init &&
            (init.getKind() === SyntaxKind.ArrowFunction || init.getKind() === SyntaxKind.FunctionExpression);
          if (isCallable) {
            this.addSymbol(out, exportIndex, "Function", key, decl.getName(), decl.getStartLineNumber(true), stmt.isExported(), undefined);
          }
        }
      }
    }

    const symbolsByName = new Map<string, SymbolIndexEntry>();
    for (const sym of out.symbols) {
      if (!symbolsByName.has(sym.name)) symbolsByName.set(sym.name, { key: sym.key, fileKey: sym.fileKey });
    }

    // ── pass 2: imports, calls, routes, tests ────────────────────────────
    for (const sdf of this.project.getSourceFiles()) {
      const fromFile = this.relPath(sdf);

      // DEPENDS_ON via import declarations (module specifier resolved by ts-morph)
      const usedSymbols = new Map<string, string[]>(); // targetFileKey -> [names]
      for (const imp of sdf.getImportDeclarations()) {
        const targetSdf = imp.getModuleSpecifierSourceFile();
        if (!targetSdf) continue;
        const toFile = this.relPath(targetSdf);
        if (toFile === fromFile) continue;
        const names: string[] = [];
        for (const named of imp.getNamedImports()) names.push(named.getName());
        const def = imp.getDefaultImport();
        if (def) names.push(def.getText());
        const ns = imp.getNamespaceImport();
        if (ns) names.push(ns.getText());
        const bucket = usedSymbols.get(toFile) ?? [];
        usedSymbols.set(toFile, [...bucket, ...names]);
        out.dependencies.push({ fromFile, toFile, symbolsUsed: names });
      }

      // CALLS within this file
      const calleeResolver = (name: string): string | null => {
        // 1. same-file symbol
        const local = out.symbols.find((s) => s.fileKey === fromFile && s.name === name);
        if (local) return local.key;
        // 2. imported symbol: find its definition file, then the symbol there
        for (const [depFile] of usedSymbols) {
          const depSym = out.symbols.find((s) => s.fileKey === depFile && s.name === name);
          if (depSym) return depSym.key;
        }
        // 3. any visible symbol with that name (best effort)
        const fallback = symbolsByName.get(name);
        if (fallback) return fallback.key;
        return null;
      };

      const importedNames = new Set<string>();
      for (const names of usedSymbols.values()) {
        for (const n of names) if (n) importedNames.add(n);
      }

      const emitCall = (node: CallExpression | NewExpression, expr: Node, calleeName: string) => {
        // member calls only count when the receiver is an imported binding:
        // `logger.warn()` (imported ns) yes, `console.warn()` / `str.split()` no
        if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
          const receiver = (expr as PropertyAccessExpression).getExpression();
          if (receiver.getKind() === SyntaxKind.Identifier) {
            if (!importedNames.has(receiver.getText())) return;
          }
        }
        const calleeKey = calleeResolver(calleeName);
        if (!calleeKey) return; // external or unresolvable — skip for MVP
        const enc = enclosingCallableNode(fromFile, node);
        out.calls.push({
          callerKey: enc.key ?? fromFile,
          callerKind: enc.kind,
          calleeKey,
          callSite: `${fromFile}:${node.getStartLineNumber(true)}`,
        });
      };

      for (const call of sdf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const name = calleeNameOf(call.getExpression());
        if (name) emitCall(call, call.getExpression(), name);
      }
      for (const ctor of sdf.getDescendantsOfKind(SyntaxKind.NewExpression)) {
        const name = calleeNameOf(ctor.getExpression());
        if (name) emitCall(ctor, ctor.getExpression(), name);
      }

      // API routes: Next.js app-router convention `app/**/route.ts`
      const routeMatch = /(?:^|\/)app\/(.+)\/route\.[jt]sx?$/.exec(fromFile);
      if (routeMatch) {
        const routePath = `/${routeMatch[1]}`;
        for (const method of ["GET", "POST", "PUT", "DELETE", "PATCH"]) {
          const handler = sdf.getFunction(method) ?? sdf.getVariableDeclaration(method);
          if (handler) {
            out.routes.push({
              key: `${method} ${routePath}`,
              fileKey: fromFile,
              method,
              path: routePath,
              handler: `${fromFile}::${method}`,
            });
          }
        }
      }

      // Tests: each describe/it/test block; TESTED_BY edges from imported files
      if (TEST_FILE_RE.test(fromFile)) {
        const testNames = extractTestNames(sdf.getFullText());
        for (const name of testNames) {
          const key = `${fromFile}::${name}`;
          out.tests.push({ key, name, fileKey: fromFile });
        }
        // everything this test file imports is considered covered
        for (const targetFile of usedSymbols.keys()) {
          for (const t of out.tests.filter((x) => x.fileKey === fromFile)) {
            out.tested.push({ subjectFileKey: targetFile, testKey: t.key });
          }
        }
      }

    }

    return out;
  }

  private addSymbol(
    out: ParseOutput,
    exportIndex: Map<string, SymbolIndexEntry>,
    kind: ParsedSymbol["kind"],
    fileKey: string,
    name: string | undefined,
    line: number,
    exported: boolean,
    signature?: string,
  ): void {
    if (!name) return;
    const key = `${fileKey}::${name}`;
    out.symbols.push({ key, kind, name, fileKey, line, signature, exported });
    if (exported && !exportIndex.has(name)) exportIndex.set(name, { key, fileKey });
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function paramsSignature(fn: { getParameters(): Array<{ getText(): string }>; getReturnTypeNode?: () => unknown }): string {
  const params = fn.getParameters().map((p) => p.getText());
  return `(${params.join(", ")})`;
}

function calleeNameOf(expr: Node): string | null {
  if (expr.getKind() === SyntaxKind.Identifier) {
    return (expr as unknown as { getText(): string }).getText();
  }
  if (expr.getKind() === SyntaxKind.PropertyAccessExpression) {
    const prop = expr as unknown as { getName(): string };
    return prop.getName();
  }
  return null;
}

/** Nearest enclosing callable around `node`; keys match symbol keys `${file}::name`. */
function enclosingCallableNode(fileKey: string, node: Node): { key: string | null; kind: "File" | "Function" | "Class" | "Test" } {
  let cur: Node | undefined = node;
  while (cur && !Node.isSourceFile(cur)) {
    const kind = cur.getKind();
    if (
      kind === SyntaxKind.FunctionDeclaration ||
      kind === SyntaxKind.MethodDeclaration ||
      kind === SyntaxKind.FunctionExpression ||
      kind === SyntaxKind.ArrowFunction
    ) {
      const name = guessCallableName(cur);
      if (name) {
        return { key: `${fileKey}::${name}`, kind: "Function" };
      }
    } else if (kind === SyntaxKind.ClassDeclaration) {
      const name = guessCallableName(cur);
      if (name) return { key: `${fileKey}::${name}`, kind: "Class" };
    }
    cur = cur.getParent();
  }
  return { key: null, kind: "File" };
}

function guessCallableName(node: Node): string | undefined {
  const anyNode = node as unknown as {
    getName?: () => string | undefined;
    getSymbol?: () => { getName(): string } | undefined;
  };
  const direct = anyNode.getName?.();
  if (direct) return direct;
  const sym = anyNode.getSymbol?.();
  if (sym) return sym.getName();
  // anonymous arrow assigned to a variable: climb to the VariableDeclaration name
  const parent = node.getParent();
  if (parent && parent.getKind() === SyntaxKind.VariableDeclaration) {
    const declName = (parent as unknown as { getName(): string }).getName();
    if (declName) return declName;
  }
  return undefined;
}

/** Regex MVP test extraction: describe(...) / it(...) / test(...) blocks. */
function extractTestNames(content: string): string[] {
  const names: string[] = [];
  const re = /\b(describe|it|test)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content))) {
    names.push(m[2]);
  }
  return names;
}
