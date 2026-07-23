#!/usr/bin/env node
import ts from "typescript";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function collectTypeScriptFiles(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path);
      else if (/\.(?:ts|tsx)$/u.test(name) && !name.endsWith(".d.ts")) files.push(path);
    }
  };
  walk(root);
  return files;
}

function isTypeOnlyImport(node) {
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  if (clause.name) return false;
  const bindings = clause.namedBindings;
  return ts.isNamedImports(bindings)
    && bindings.elements.length > 0
    && bindings.elements.every((element) => element.isTypeOnly);
}

function isTypeOnlyExport(node) {
  if (node.isTypeOnly) return true;
  return node.exportClause
    && ts.isNamedExports(node.exportClause)
    && node.exportClause.elements.length > 0
    && node.exportClause.elements.every((element) => element.isTypeOnly);
}

function resolveLocalImport(from, specifier, fileSet) {
  if (!specifier.startsWith(".")) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.js$/u, ".ts"),
    base.replace(/\.js$/u, ".tsx"),
    resolve(base, "index.ts"),
    resolve(base, "index.tsx"),
  ];
  return candidates.find((path) => fileSet.has(path)) ?? null;
}

export function findRuntimeImportCycles(rootInput) {
  const root = resolve(rootInput);
  const files = collectTypeScriptFiles(root);
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, new Set()]));
  for (const file of files) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of source.statements) {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        if (isTypeOnlyImport(node)) continue;
        const target = resolveLocalImport(file, node.moduleSpecifier.text, fileSet);
        if (target) graph.get(file).add(target);
        continue;
      }
      if (ts.isExportDeclaration(node) && node.moduleSpecifier
        && ts.isStringLiteral(node.moduleSpecifier) && !isTypeOnlyExport(node)) {
        const target = resolveLocalImport(file, node.moduleSpecifier.text, fileSet);
        if (target) graph.get(file).add(target);
      }
    }
  }

  let nextIndex = 0;
  const indexes = new Map();
  const lows = new Map();
  const stack = [];
  const stacked = new Set();
  const components = [];
  const visit = (node) => {
    indexes.set(node, nextIndex);
    lows.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    stacked.add(node);
    for (const target of graph.get(node)) {
      if (!indexes.has(target)) {
        visit(target);
        lows.set(node, Math.min(lows.get(node), lows.get(target)));
      } else if (stacked.has(target)) {
        lows.set(node, Math.min(lows.get(node), indexes.get(target)));
      }
    }
    if (lows.get(node) !== indexes.get(node)) return;
    const component = [];
    let current;
    do {
      current = stack.pop();
      stacked.delete(current);
      component.push(current);
    } while (current !== node);
    if (component.length > 1 || graph.get(node).has(node)) components.push(component);
  };
  for (const file of files) if (!indexes.has(file)) visit(file);

  const display = (file) => relative(root, file);
  return components.map((members) => {
    const memberSet = new Set(members);
    return {
      members: members.map(display).sort(),
      edges: members.flatMap((from) => [...graph.get(from)]
        .filter((to) => memberSet.has(to))
        .map((to) => `${display(from)} -> ${display(to)}`)).sort(),
    };
  }).sort((a, b) => b.members.length - a.members.length || a.members[0].localeCompare(b.members[0]));
}

function runCli() {
  const root = resolve(process.argv[2] ?? "src");
  if (!existsSync(root)) throw new Error(`import-cycle root not found: ${root}`);
  const cycles = findRuntimeImportCycles(root);
  if (cycles.length === 0) {
    process.stdout.write(`[import-cycles] OK root=${relative(process.cwd(), root) || "."} cycles=0\n`);
    return;
  }
  process.stderr.write(`[import-cycles] FAIL cycles=${cycles.length}\n`);
  for (const [index, cycle] of cycles.entries()) {
    process.stderr.write(`cycle ${index + 1}: ${cycle.members.join(", ")}\n`);
    for (const edge of cycle.edges) process.stderr.write(`  ${edge}\n`);
  }
  process.exitCode = 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) runCli();
