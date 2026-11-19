// Packs the package, installs the tarball into an empty consumer project, and imports it there
// the way users do. Run after `yarn build`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const dir = mkdtempSync(join(tmpdir(), "smoke-"));
try {
  const tarball = join(dir, "package.tgz");
  execFileSync("yarn", ["pack", "--out", tarball], { stdio: "ignore" });

  const listing = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  const packed = new Set(
    listing
      .trim()
      .split("\n")
      .map((path) => path.replace(/^package\//, ""))
  );
  const targets = new Set([pkg.main, pkg.types]);
  (function collect(value) {
    if (typeof value === "string") targets.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  })(pkg.exports);
  for (const target of targets)
    if (target && !packed.has(target.replace(/^\.\//, "")))
      throw new Error(`The packed package is missing ${target}`);

  const consumer = join(dir, "consumer");
  execFileSync("mkdir", [consumer]);
  writeFileSync(
    join(consumer, "package.json"),
    '{"name":"consumer","private":true,"type":"module"}'
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], {
    cwd: consumer,
    stdio: "ignore",
  });
  const check = `
    const m = await import(${JSON.stringify(pkg.name)});
    for (const name of ["createMagicHour", "magichour", "MagicHourError"])
      if (!m[name]) throw new Error("The package doesn't export " + name);
    m.createMagicHour({ apiKey: "smoke" }).image("flux-2-klein");
  `;
  execFileSync("node", ["--input-type=module", "-e", check], { cwd: consumer, stdio: "inherit" });
  console.log(`${pkg.name}: installed from the packed tarball and imported`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
