#!/usr/bin/env node
/** Validate the published docs as both site pages and package-local Markdown. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const docsDir = resolve(repoRoot, "docs");
const packageJsonPath = resolve(repoRoot, "packages/eve/package.json");
const excludedSiteFiles = new Set(["README.md", "STYLE.md"]);
const failures = [];
let validatedCount = 0;

function toPosix(value) {
  return value.split("\\").join("/");
}

function walk(dir, predicate = () => true) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, predicate));
    else if (predicate(full)) out.push(full);
  }
  return out;
}

const markdownFiles = walk(docsDir, (file) => /\.mdx?$/.test(file));
const siteFiles = markdownFiles.filter(
  (file) => !excludedSiteFiles.has(toPosix(relative(docsDir, file))),
);

function parseFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return null;
  const data = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = line.match(/^([\w-]+):\s*(.*)$/);
    if (!field) continue;
    data[field[1]] = field[2].trim().replace(/^["']|["']$/g, "");
  }
  return data;
}

function normalizeRoute(route) {
  const normalized = route.replace(/\/{2,}/g, "/").replace(/\/$/, "");
  return normalized || "/docs";
}

function renderedRoute(relPath, source) {
  const override = parseFrontmatter(source)?.url;
  if (override) {
    return normalizeRoute(override.startsWith("/docs") ? override : `/docs/${override}`);
  }
  let slug = relPath.replace(/\.mdx?$/, "");
  if (slug === "index") slug = "";
  else slug = slug.replace(/\/index$/, "");
  return normalizeRoute(`/docs/${slug}`);
}

const pages = siteFiles.map((abs) => {
  const rel = toPosix(relative(docsDir, abs));
  const source = readFileSync(abs, "utf8");
  return { abs, rel, source, route: renderedRoute(rel, source) };
});
const pageByRoute = new Map();
const pageByAbs = new Map(pages.map((page) => [page.abs, page]));

for (const page of pages) {
  validatedCount += 1;
  const frontmatter = parseFrontmatter(page.source);
  if (!frontmatter) {
    failures.push({ file: page.rel, issue: "no frontmatter block" });
    continue;
  }
  for (const field of ["title", "description"]) {
    if (!frontmatter[field]) {
      failures.push({ file: page.rel, issue: `frontmatter missing \`${field}\`` });
    }
  }

  const duplicate = pageByRoute.get(page.route);
  if (duplicate) {
    failures.push({
      file: page.rel,
      issue: `duplicate rendered route \`${page.route}\` (also ${duplicate.rel})`,
    });
  } else {
    pageByRoute.set(page.route, page);
  }
}

function readMeta(dir) {
  const path = resolve(dir, "meta.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    failures.push({
      file: toPosix(relative(docsDir, path)),
      issue: `invalid JSON: ${String(error.message ?? error)}`,
    });
    return null;
  }
}

function isMetaControl(entry) {
  return (
    entry === "..." ||
    entry === "z...z" ||
    entry === "---" ||
    /^---.+---$/.test(entry) ||
    entry.startsWith("[")
  );
}

function resolveMarkdownTarget(base) {
  const candidates = extname(base)
    ? [base]
    : [`${base}.md`, `${base}.mdx`, resolve(base, "index.md"), resolve(base, "index.mdx")];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile());
}

const navExplicit = new Set();
const navWildcardDirs = new Set();

function inspectMetaTree(dir) {
  const relDir = toPosix(relative(docsDir, dir));
  const meta = readMeta(dir);
  if (meta && Array.isArray(meta.pages)) {
    const localEntries = new Set();
    for (const rawEntry of meta.pages) {
      if (typeof rawEntry !== "string" || isMetaControl(rawEntry)) {
        if (rawEntry === "..." || rawEntry === "z...z") navWildcardDirs.add(relDir);
        continue;
      }
      const entry = rawEntry.startsWith("!") ? rawEntry.slice(1) : rawEntry;
      if (localEntries.has(entry)) {
        failures.push({
          file: toPosix(relative(docsDir, resolve(dir, "meta.json"))),
          issue: `duplicate meta.json entry \`${entry}\``,
        });
      }
      localEntries.add(entry);
      const rawTarget = resolve(dir, entry);
      const target = resolveMarkdownTarget(rawTarget);
      const targetIsGroup = existsSync(rawTarget) && statSync(rawTarget).isDirectory();
      if (!target && !targetIsGroup) {
        failures.push({
          file: toPosix(relative(docsDir, resolve(dir, "meta.json"))),
          issue: `meta.json entry \`${entry}\` does not resolve to a page or folder index`,
        });
      }
      navExplicit.add(relDir ? `${relDir}/${entry}` : entry);
    }
  } else if (dir !== docsDir) {
    navWildcardDirs.add(relDir);
  }

  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) inspectMetaTree(full);
  }
}

inspectMetaTree(docsDir);

function coveredByNav(relPath) {
  const slug = relPath.replace(/\.mdx?$/, "");
  if (navExplicit.has(slug)) return true;
  if (slug.endsWith("/index") && navExplicit.has(slug.slice(0, -"/index".length))) return true;
  const slash = slug.lastIndexOf("/");
  const folder = slash === -1 ? "" : slug.slice(0, slash);
  return navWildcardDirs.has(folder) || (slash !== -1 && navExplicit.has(folder));
}

for (const page of pages) {
  if (!coveredByNav(page.rel)) {
    failures.push({ file: page.rel, issue: "page is orphaned from meta.json navigation" });
  }
}

function headingIds(source) {
  const ids = new Set();
  const duplicates = new Map();
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^#{1,6}\s+(.+?)\s*#*$/);
    if (!match) continue;
    const plain = match[1]
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .toLowerCase()
      .trim()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-");
    const count = duplicates.get(plain) ?? 0;
    duplicates.set(plain, count + 1);
    ids.add(count === 0 ? plain : `${plain}-${count}`);
  }
  return ids;
}

function parseLinkTarget(raw) {
  let value = raw.trim();
  if (value.startsWith("<") && value.includes(">")) value = value.slice(1, value.indexOf(">"));
  else value = value.split(/\s+["']/)[0];
  const hashAt = value.indexOf("#");
  return {
    path: hashAt === -1 ? value : value.slice(0, hashAt),
    anchor: hashAt === -1 ? "" : decodeURIComponent(value.slice(hashAt + 1)),
  };
}

function validateAnchor(sourceFile, targetPage, anchor, raw) {
  if (!anchor || !targetPage) return;
  if (!headingIds(targetPage.source).has(anchor)) {
    failures.push({
      file: sourceFile,
      issue: `link \`${raw}\` points to missing heading \`#${anchor}\` in ${targetPage.rel}`,
    });
  }
}

function checkLinks(absFiles) {
  const markdownLink = /\]\((\s*[^)]+?)\s*\)/g;
  for (const abs of absFiles) {
    const rel = toPosix(relative(docsDir, abs));
    if (rel === "STYLE.md") continue;
    const source = readFileSync(abs, "utf8");
    const sourcePage = pageByAbs.get(abs);
    let match;
    while ((match = markdownLink.exec(source)) !== null) {
      const raw = match[1].trim();
      const { path, anchor } = parseLinkTarget(raw);
      if (!path && anchor) {
        validateAnchor(rel, sourcePage, anchor, raw);
        continue;
      }

      const absoluteSite = path === "/docs" || path.startsWith("/docs/");
      const eveSite = /^https:\/\/(?:www\.)?eve\.dev\/docs(?:\/|$)/.test(path);
      if (absoluteSite || eveSite) {
        const route = normalizeRoute(eveSite ? new URL(path).pathname : path);
        const target = pageByRoute.get(route);
        if (!target) failures.push({ file: rel, issue: `broken site link \`${raw}\`` });
        else validateAnchor(rel, target, anchor, raw);
        continue;
      }

      if (!path.startsWith("./") && !path.startsWith("../")) continue;
      const rawBase = resolve(dirname(abs), path);
      const targetAbs = resolveMarkdownTarget(rawBase);
      if (!targetAbs) {
        failures.push({ file: rel, issue: `broken relative link \`${raw}\`` });
        continue;
      }
      if (!targetAbs.startsWith(`${docsDir}/`) && targetAbs !== docsDir) {
        if (rel !== "README.md") {
          failures.push({ file: rel, issue: `site page links outside docs with \`${raw}\`` });
        }
        continue;
      }
      const targetPage = pageByAbs.get(targetAbs);
      if (!targetPage && !excludedSiteFiles.has(toPosix(relative(docsDir, targetAbs)))) {
        failures.push({
          file: rel,
          issue: `relative link \`${raw}\` does not resolve to a rendered page`,
        });
        continue;
      }
      validateAnchor(rel, targetPage, anchor, raw);
    }
  }
}

checkLinks(markdownFiles);

// Every package export must be discoverable from the authored API entrypoint.
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const apiReference = readFileSync(resolve(docsDir, "reference/typescript-api.md"), "utf8");
for (const subpath of Object.keys(packageJson.exports ?? {})) {
  const specifier = subpath === "." ? "eve" : `eve/${subpath.slice(2)}`;
  if (!apiReference.includes(`\`${specifier}\``)) {
    failures.push({
      file: "reference/typescript-api.md",
      issue: `package export \`${specifier}\` is missing from the API export map`,
    });
  }
}

const packageFiles = new Set(packageJson.files ?? []);
for (const required of ["docs", "README.md"]) {
  if (!packageFiles.has(required)) {
    failures.push({
      file: "../packages/eve/package.json",
      issue: `package files omits \`${required}\``,
    });
  }
}
if (!existsSync(resolve(docsDir, "README.md"))) {
  failures.push({ file: "README.md", issue: "package-local task index is missing" });
}

if (failures.length === 0) {
  process.stdout.write(
    `[docs:check] ok — ${validatedCount} rendered pages, navigation, links, anchors, exports, and package inputs validated.\n`,
  );
  process.exit(0);
}

process.stderr.write("[docs:check] FAIL\n\n");
for (const { file, issue } of failures) {
  process.stderr.write(`  docs/${file}\n    → ${issue}\n\n`);
}
process.exit(1);
