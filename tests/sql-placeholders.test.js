import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROOTS = ["packages", "apps"];

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function sqlLiterals(text) {
  const literals = [];
  for (const match of text.matchAll(/`([^`]*)`/g)) {
    const body = match[1];
    if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(body)) continue;
    if (!/\$\d/.test(body)) continue;
    literals.push({ body, line: text.slice(0, match.index).split("\n").length });
  }
  return literals;
}

test("every SQL statement references a contiguous set of positional parameters", async () => {
  const failures = [];
  for (const root of ROOTS) {
    for (const file of await sourceFiles(root)) {
      const text = await readFile(file, "utf8");
      for (const literal of sqlLiterals(text)) {
        const used = new Set([...literal.body.matchAll(/\$(\d+)/g)].map((match) => Number(match[1])));
        const highest = Math.max(...used);
        const holes = [];
        for (let index = 1; index <= highest; index += 1) if (!used.has(index)) holes.push(index);
        if (holes.length > 0) {
          failures.push(`${file}:${literal.line} omits $${holes.join(", $")} but uses $${highest}`);
        }
      }
    }
  }
  assert.deepEqual(failures, [], "PostgreSQL cannot infer the type of a skipped placeholder, so these queries fail at runtime");
});

test("the memory search query binds only the parameters it references", async () => {
  const text = await readFile("packages/storage/src/memory.ts", "utf8");
  const search = text.slice(text.indexOf("async search("), text.indexOf("async graph("));
  const fts = search.slice(search.indexOf("this.#pool.query<FtsRow>"), search.indexOf("this.#pool.query<VectorRow>"));
  assert.match(fts, /\$3::text IS NULL OR project_id=\$3/, "the project filter must be the third bound parameter");
  assert.doesNotMatch(fts, /\$4/, "an unreferenced fourth parameter was the cause of a runtime 500");
});
