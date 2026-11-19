// Checks the packed package contains every file package.json points to, then imports it by
// name the way users do. Run after `yarn build`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const listing = execFileSync("yarn", ["pack", "--dry-run", "--json"], { encoding: "utf8" });
const packed = new Set(
  listing
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line).location)
    .filter(Boolean)
);
const targets = new Set([pkg.main, pkg.types]);
(function collect(value) {
  if (typeof value === "string") targets.add(value);
  else if (value && typeof value === "object") Object.values(value).forEach(collect);
})(pkg.exports);
for (const target of targets)
  if (target && !packed.has(target.replace(/^\.\//, "")))
    throw new Error(`The packed package is missing ${target}`);

const exports = await import(pkg.name);
for (const name of ["createMagicHour", "magichour", "MagicHourError"])
  if (!exports[name]) throw new Error(`The package doesn't export ${name}`);
console.log(`${pkg.name}: ${targets.size} entry files packed, import ok`);
