// The web audit's premise, pinned to the code the audit was about.
//
// `WEB_REACHABLE` in `roles.ts` says which verbs the web app reaches, and
// `WEB_GRANTS` is compared to it. That claim rests on a SET - the
// control-plane names the shipped app calls - and a verb list cannot state its
// own premise. On 2026-08-24 the facade started to call
// `recordOrdinaryCheckoutSession`, which writes `name_reservations`, and no
// suite noticed until signup failed in production with 42501.
//
// So the names are read from the app's source, through the TypeScript parser:
// every runtime binding a shipped app file takes from a control-plane module,
// and every Store method the facade calls. Each must be audited, and each
// audited name must carry a decision: it is cited in a `WEB_REACHABLE` entry,
// or it is recorded as reaching no table. A binding shape the reader does not
// know fails here rather than being skipped.
//
// Neither test says the verbs are right - that is a human audit, and the `via`
// citations are where it is written down.

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";
import {
  AUDITED_WEB_STORE_CALLS,
  AUDITED_WEB_SURFACES,
  WEB_REACHABLE,
  WEB_TABLE_FREE,
} from "./roles.ts";
import { Store } from "./store.ts";

const CONTROL_PLANE = import.meta.dir;
const WEB = path.join(CONTROL_PLANE, "web");
const FACADE = path.join(WEB, "lib", "services.server.ts");

/** What ships in the app's server bundle: web-boundary.test.ts's scope, less
 * the tests, which do not ship. */
function shippedFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", ".next", "e2e"].includes(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(ts|tsx)$/.test(entry.name) &&
        !entry.name.endsWith(".d.ts") &&
        !/\.test\.tsx?$/.test(entry.name)
      )
        out.push(full);
    }
  };
  walk(WEB);
  return out.sort();
}

/** The control-plane module a specifier names, as its path under
 * control-plane/ without the extension, or null for anything else. */
function controlPlaneModule(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, "index.ts"),
  ]) {
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
    if (candidate.startsWith(WEB + path.sep)) return null;
    if (!candidate.startsWith(CONTROL_PLANE + path.sep)) return null;
    return path
      .relative(CONTROL_PLANE, candidate)
      .replace(/\.tsx?$/, "")
      .replace(/\/index$/, "");
  }
  throw new Error(`${from}: cannot resolve ${specifier}`);
}

type Uses = Map<string, Set<string>>;

const lineOf = (source: ts.SourceFile, node: ts.Node): string =>
  `${path.relative(CONTROL_PLANE, source.fileName)}:${
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
  }`;

function unwrap(node: ts.Node): ts.Node {
  let current = node;
  while (
    ts.isAwaitExpression(current.parent) ||
    ts.isParenthesizedExpression(current.parent)
  )
    current = current.parent;
  return current;
}

/** The string values an element access key can take: a literal, or an
 * identifier declared with a union of string literal types. */
function keysOf(source: ts.SourceFile, key: ts.Expression): string[] {
  if (ts.isStringLiteralLike(key)) return [key.text];
  if (ts.isIdentifier(key)) {
    for (let scope: ts.Node = key; scope; scope = scope.parent) {
      if (!ts.isFunctionLike(scope)) continue;
      for (const param of scope.parameters) {
        if (!ts.isIdentifier(param.name) || param.name.text !== key.text)
          continue;
        const type = param.type;
        const members =
          type && ts.isUnionTypeNode(type) ? type.types : type ? [type] : [];
        const values = members.map((member) =>
          ts.isLiteralTypeNode(member) && ts.isStringLiteral(member.literal)
            ? member.literal.text
            : null,
        );
        if (values.length > 0 && values.every((v) => v !== null)) return values;
      }
    }
  }
  throw new Error(
    `${lineOf(source, key)}: a namespace is indexed by a key the reader cannot resolve`,
  );
}

/** Every use of a namespace binding: `ns.name`, `ns["name"]` or `ns[verb]`
 * with `verb` typed as string literals. Any other use is unreadable. */
function namespaceUses(
  source: ts.SourceFile,
  binding: ts.Identifier,
  module: string,
  add: (module: string, name: string) => void,
): void {
  const visit = (node: ts.Node): void => {
    if (
      ts.isIdentifier(node) &&
      node !== binding &&
      node.text === binding.text &&
      !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
    ) {
      const parent = node.parent;
      if (ts.isPropertyAccessExpression(parent) && parent.expression === node)
        add(module, parent.name.text);
      else if (
        ts.isElementAccessExpression(parent) &&
        parent.expression === node
      )
        for (const key of keysOf(source, parent.argumentExpression))
          add(module, key);
      else
        throw new Error(
          `${lineOf(source, node)}: namespace ${binding.text} is used in a shape the reader does not know`,
        );
    }
    ts.forEachChild(node, visit);
  };
  // The binding's own block: a local of the same name elsewhere in the file is
  // another variable.
  let scope: ts.Node = binding;
  while (!ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
  visit(scope);
}

/** The names a binding takes from one module. */
function bind(
  source: ts.SourceFile,
  name: ts.BindingName,
  module: string,
  add: (module: string, name: string) => void,
): void {
  if (ts.isIdentifier(name)) return namespaceUses(source, name, module, add);
  if (ts.isObjectBindingPattern(name)) {
    for (const element of name.elements) {
      const key = element.propertyName ?? element.name;
      if (element.dotDotDotToken || !ts.isIdentifier(key))
        throw new Error(`${lineOf(source, element)}: unreadable binding`);
      add(module, key.text);
    }
    return;
  }
  throw new Error(`${lineOf(source, name)}: unreadable binding`);
}

/** The runtime names one file takes from the control plane, by module. */
function usesIn(file: string, uses: Uses): void {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const add = (module: string, name: string): void => {
    if (!uses.has(module)) uses.set(module, new Set());
    uses.get(module)!.add(name);
  };

  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const module = controlPlaneModule(file, node.moduleSpecifier.text);
      if (module) {
        if (ts.isExportDeclaration(node))
          throw new Error(`${lineOf(source, node)}: a re-export of ${module}`);
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          if (clause.name) add(module, "default");
          const bindings = clause.namedBindings;
          if (bindings && ts.isNamespaceImport(bindings))
            namespaceUses(source, bindings.name, module, add);
          else if (bindings)
            for (const element of bindings.elements)
              if (!element.isTypeOnly)
                add(module, (element.propertyName ?? element.name).text);
        }
        // `import "x"` with no clause runs the module for its effects.
        if (!clause) add(module, "*");
      }
    }

    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword
    ) {
      const [argument] = node.arguments;
      if (!argument || !ts.isStringLiteral(argument))
        throw new Error(`${lineOf(source, node)}: a computed import()`);
      const module = controlPlaneModule(file, argument.text);
      if (module) {
        const outer = unwrap(node);
        const parent = outer.parent;
        if (ts.isVariableDeclaration(parent) && parent.initializer === outer) {
          bind(source, parent.name, module, add);
        } else if (
          ts.isPropertyAccessExpression(parent) &&
          parent.expression === outer
        ) {
          add(module, parent.name.text);
        } else if (ts.isArrayLiteralExpression(parent)) {
          // `const [a, { b }] = await Promise.all([import(x), import(y)])`
          const index = parent.elements.indexOf(outer as ts.Expression);
          const all = parent.parent;
          const declaration =
            ts.isCallExpression(all) &&
            all.expression.getText(source) === "Promise.all"
              ? unwrap(all).parent
              : null;
          const element =
            declaration &&
            ts.isVariableDeclaration(declaration) &&
            ts.isArrayBindingPattern(declaration.name)
              ? declaration.name.elements[index]
              : null;
          if (!element || !ts.isBindingElement(element))
            throw new Error(`${lineOf(source, node)}: unreadable import()`);
          bind(source, element.name, module, add);
        } else {
          throw new Error(`${lineOf(source, node)}: unreadable import()`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function appUses(): Record<string, string[]> {
  const uses: Uses = new Map();
  for (const file of shippedFiles()) usesIn(file, uses);
  return Object.fromEntries(
    [...uses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([module, names]) => [module, [...names].sort()]),
  );
}

/** Every Store method the facade calls, on any receiver. */
function facadeStoreCalls(): string[] {
  const methods = new Set([
    ...Object.getOwnPropertyNames(Store.prototype),
    ...Object.getOwnPropertyNames(Store),
  ]);
  for (const notAMethod of ["constructor", "length", "name", "prototype"])
    methods.delete(notAMethod);
  const source = ts.createSourceFile(
    FACADE,
    fs.readFileSync(FACADE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      methods.has(node.expression.name.text)
    )
      found.add(node.expression.name.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort();
}

const pinnedNames = (): string[] => [
  ...Object.entries(AUDITED_WEB_SURFACES).flatMap(([module, names]) =>
    names.map((name) => `${module}:${name}`),
  ),
  ...AUDITED_WEB_STORE_CALLS.map((name) => `store:${name}`),
];

/** A via cites a pinned name as `<module>:<name>`, ended by a non-name
 * character, so `signup:reserveOffice` is not cited by `signup:reserveOfficeX`. */
const cites = (via: string, pinned: string): boolean =>
  new RegExp(`(^|[^\\w/$])${pinned.replace(/[$/]/g, "\\$&")}(?![\\w$])`).test(
    via,
  );

describe("the audited surface is the surface the app uses", () => {
  test("the reader finds the facade's bindings and the pages' own", () => {
    // A reader that matched nothing would make every case below pass on an
    // empty audit. The facade reaches signup through destructured and
    // Promise.all bindings, requests through a namespace indexed by a typed
    // verb; the signup page takes a constant by a static import.
    const uses = appUses();
    expect(uses.signup).toContain("reserveOffice");
    expect(uses.signup).toContain("recordOrdinaryCheckoutSession");
    expect(uses.requests).toContain("requestInvite");
    expect(uses.cancel).toContain("requestUncancel");
    expect(uses.signup).toContain("OFFICE_DOMAIN");
    expect(facadeStoreCalls()).toContain("openRuntime");
  });

  // A NEW NAME FAILS THIS, which is the point: recordOrdinaryCheckoutSession
  // arrived in the facade as one new name in a destructuring.
  test("each module is used through exactly its audited names", () => {
    const audited = Object.fromEntries(
      Object.entries(AUDITED_WEB_SURFACES).map(([module, names]) => [
        module,
        [...names].sort(),
      ]),
    );
    expect(appUses()).toEqual(audited);
  });

  test("the facade calls exactly the audited Store methods", () => {
    expect(facadeStoreCalls()).toEqual([...AUDITED_WEB_STORE_CALLS].sort());
  });
});

describe("every audited name carries a decision", () => {
  // Appending a name to the lists above would make them green without an
  // audit. So each name is either cited by a WEB_REACHABLE entry, or recorded
  // as reaching no table with a reason - never both, never neither.
  test("each pinned name is cited by a verb or recorded as table-free", () => {
    const undecided: string[] = [];
    const both: string[] = [];
    for (const pinned of pinnedNames()) {
      const cited = WEB_REACHABLE.some((entry) => cites(entry.via, pinned));
      const free = Object.hasOwn(WEB_TABLE_FREE, pinned);
      if (!cited && !free) undecided.push(pinned);
      if (cited && free) both.push(pinned);
    }
    expect(undecided).toEqual([]);
    expect(both).toEqual([]);
  });

  test("table-free entries name pinned names and say why", () => {
    const pinned = new Set(pinnedNames());
    for (const [name, reason] of Object.entries(WEB_TABLE_FREE)) {
      expect([name, pinned.has(name)]).toEqual([name, true]);
      expect(reason.trim().length).toBeGreaterThan(10);
    }
  });

  test("every verb is reached from a pinned name", () => {
    const pinned = pinnedNames();
    for (const entry of WEB_REACHABLE) {
      const label = `${entry.table}:${entry.verb}`;
      expect([label, pinned.some((name) => cites(entry.via, name))]).toEqual([
        label,
        true,
      ]);
    }
  });
});
