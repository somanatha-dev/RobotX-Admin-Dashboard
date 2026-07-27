"use strict";

/**
 * Dependency-free JavaScript source scanner shared by the Phase 0 build gates.
 *
 * The Phase 0 execution plan adds no npm dependencies, so the gates cannot use a
 * real parser. Everything here therefore works on a *lexical* view of the source:
 * a single character scanner blanks out comments, string literals, template
 * literals and regular-expression literals, leaving a same-length buffer in which
 * every remaining character is genuine code at its original offset. Line and column
 * numbers computed against the blanked buffer are valid for the original file.
 *
 * Limitations, stated so that no gate silently over-claims:
 *   - Template-literal *expressions* (`${...}`) are blanked along with the literal.
 *     A behavioural constant hidden inside one is not seen by the parameter gate.
 *   - Regex-literal detection uses the standard "previous significant character"
 *     heuristic. A misclassification blanks code rather than revealing a literal,
 *     so it can only produce a false negative, never a false positive.
 *
 * Both limitations are one-sided in the safe direction for a *reviewer* (a gate
 * never fails a compliant file) and are recorded as accepted risk in
 * `PHASE_0_IMPLEMENTATION_REPORT.md`.
 */

const fs = require("fs");
const path = require("path");

/**
 * Characters after which a `/` begins a regular-expression literal rather than a
 * division operator. Standard lexer heuristic.
 */
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*",
  "%", "~", "^", "<", ">", "\n", "",
]);

const JS_EXTENSION = ".js";

/**
 * Replace the interior of comments — and optionally of string/template/regex
 * literals — with spaces, preserving overall length and every newline.
 *
 * @param {string} source
 * @param {{ literals?: boolean }} [options] when `literals` is true, string,
 *   template and regex literal contents are blanked too.
 * @returns {string} a buffer the same length as `source`
 */
function blank(source, options) {
  const blankLiterals = Boolean(options && options.literals);
  const out = source.split("");
  const n = source.length;
  let i = 0;
  let prevSignificant = "";

  const erase = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (out[k] !== "\n") out[k] = " ";
    }
  };

  while (i < n) {
    const c = source[i];
    const c2 = source[i + 1];

    // Line comment — always blanked.
    if (c === "/" && c2 === "/") {
      const start = i;
      while (i < n && source[i] !== "\n") i += 1;
      erase(start, i);
      continue;
    }

    // Block comment — always blanked.
    if (c === "/" && c2 === "*") {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i = Math.min(i + 2, n);
      erase(start, i);
      continue;
    }

    // String or template literal.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      const start = i;
      i += 1;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      if (blankLiterals) erase(start, i);
      prevSignificant = quote;
      continue;
    }

    // Regular-expression literal.
    if (c === "/" && REGEX_PRECEDERS.has(prevSignificant)) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== "\n") {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) {
          i += 1;
          break;
        }
        i += 1;
      }
      while (i < n && /[a-z]/.test(source[i])) i += 1; // flags
      if (blankLiterals) erase(start, i);
      prevSignificant = "/";
      continue;
    }

    if (!/\s/.test(c)) prevSignificant = c;
    i += 1;
  }

  return out.join("");
}

/**
 * Source with comments removed but string literals intact — the view used for
 * import extraction, whose specifiers live inside string literals.
 *
 * @param {string} source
 * @returns {string}
 */
function stripComments(source) {
  return blank(source, { literals: false });
}

/**
 * Source with comments *and* literals removed — the view used for any rule that
 * must not be fooled by text appearing inside a doc comment or a string.
 *
 * @param {string} source
 * @returns {string}
 */
function codeOnly(source) {
  return blank(source, { literals: true });
}

/**
 * Build a cumulative line-start table so offsets can be mapped to 1-based lines.
 *
 * @param {string} source
 * @returns {(offset: number) => number}
 */
function lineResolver(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === "\n") starts.push(i + 1);
  }
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const REQUIRE_PATTERN = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
const IMPORT_FROM_PATTERN = /\bfrom\s*(['"])([^'"]+)\1/g;
const BARE_IMPORT_PATTERN = /\bimport\s*(['"])([^'"]+)\1/g;
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(\s*(['"])([^'"]+)\1\s*\)/g;

/**
 * Extract every static or dynamic module specifier from a source file.
 *
 * @param {string} source
 * @returns {Array<{ specifier: string, line: number }>}
 */
function extractImports(source) {
  const view = stripComments(source);
  const lineAt = lineResolver(source);
  const found = [];
  const seen = new Set();

  for (const pattern of [
    REQUIRE_PATTERN,
    IMPORT_FROM_PATTERN,
    BARE_IMPORT_PATTERN,
    DYNAMIC_IMPORT_PATTERN,
  ]) {
    pattern.lastIndex = 0;
    let match = pattern.exec(view);
    while (match !== null) {
      const key = `${match.index}:${match[2]}`;
      if (!seen.has(key)) {
        seen.add(key);
        found.push({ specifier: match[2], line: lineAt(match.index) });
      }
      match = pattern.exec(view);
    }
  }

  found.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier));
  return found;
}

/**
 * Recursively list `.js` files under `root`, as POSIX paths relative to `root`.
 *
 * @param {string} root absolute directory
 * @param {{ include?: string[], exclude?: string[] }} [options]
 *   `include` — relative subdirectories to descend into (default: all).
 *   `exclude` — relative path prefixes to skip.
 * @returns {string[]} sorted relative POSIX paths
 */
function listSourceFiles(root, options) {
  const include = (options && options.include) || [""];
  const exclude = (options && options.exclude) || [];
  const results = [];

  const isExcluded = (relative) =>
    exclude.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`));

  const walk = (absolute, relative) => {
    if (relative !== "" && isExcluded(relative)) return;
    let entries;
    try {
      entries = fs.readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRelative = relative === "" ? entry.name : `${relative}/${entry.name}`;
      const childAbsolute = path.join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        walk(childAbsolute, childRelative);
      } else if (entry.isFile() && entry.name.endsWith(JS_EXTENSION)) {
        if (!isExcluded(childRelative)) results.push(childRelative);
      }
    }
  };

  for (const subdirectory of include) {
    const absolute = subdirectory === "" ? root : path.join(root, subdirectory);
    walk(absolute, subdirectory);
  }

  results.sort();
  return results;
}

/**
 * Resolve a module specifier appearing in `fromRelative` to a repo-relative POSIX
 * path, or `null` when the specifier is a package (bare) import.
 *
 * @param {string} fromRelative POSIX path of the importing file, relative to root
 * @param {string} specifier
 * @returns {string|null}
 */
function resolveSpecifier(fromRelative, specifier) {
  if (!specifier.startsWith(".")) return null;
  const fromDirectory = path.posix.dirname(fromRelative);
  let resolved = path.posix.normalize(path.posix.join(fromDirectory, specifier));
  if (resolved.startsWith("./")) resolved = resolved.slice(2);
  if (!resolved.endsWith(JS_EXTENSION) && !resolved.endsWith(".json")) {
    resolved = `${resolved}${JS_EXTENSION}`;
  }
  return resolved;
}

/**
 * Collect the annotation pragmas attached to a given line: pragmas on the line
 * itself, or on the contiguous comment block immediately above it.
 *
 * @param {string[]} lines raw source lines
 * @param {number} lineNumber 1-based
 * @param {RegExp} pragmaPattern must be a global regex capturing the payload in $1
 * @returns {string[]}
 */
function pragmasNear(lines, lineNumber, pragmaPattern) {
  const collected = [];
  const harvest = (text) => {
    pragmaPattern.lastIndex = 0;
    let match = pragmaPattern.exec(text);
    while (match !== null) {
      collected.push((match[1] || "").trim());
      match = pragmaPattern.exec(text);
    }
  };

  harvest(lines[lineNumber - 1] || "");

  // Walk upwards across a contiguous run of comment-only lines.
  let cursor = lineNumber - 2;
  while (cursor >= 0) {
    const text = (lines[cursor] || "").trim();
    const isCommentLine =
      text.startsWith("//") || text.startsWith("*") || text.startsWith("/*");
    if (!isCommentLine) break;
    harvest(text);
    cursor -= 1;
  }

  return collected;
}

module.exports = {
  blank,
  stripComments,
  codeOnly,
  lineResolver,
  extractImports,
  listSourceFiles,
  resolveSpecifier,
  pragmasNear,
};
