// Packs the package, installs the tarball into an empty consumer project with the AI SDK, then
// imports it and type-checks a consumer against its declarations, the way users do. Run after
// `yarn build`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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
  // The AI SDK and Node types this repo tests against, so the type check matches the lockfile.
  // The AI SDK's own declarations need @types/node and @types/json-schema, as in any real app.
  const version = (name) =>
    `${name}@${JSON.parse(readFileSync(`node_modules/${name}/package.json`, "utf8")).version}`;
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
      version("ai"),
      version("@types/node"),
      "@types/json-schema@7",
    ],
    { cwd: consumer, stdio: "ignore" }
  );
  const check = `
    const m = await import(${JSON.stringify(pkg.name)});
    for (const name of ["createMagicHour", "magichour", "MagicHourError"])
      if (!m[name]) throw new Error("The package doesn't export " + name);
    m.createMagicHour({ apiKey: "smoke" }).image("flux-2-klein");
  `;
  execFileSync("node", ["--input-type=module", "-e", check], { cwd: consumer, stdio: "inherit" });

  // skipLibCheck is off so a broken import inside the published declarations fails here.
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["consumer.ts"],
    })
  );
  writeFileSync(
    join(consumer, "consumer.ts"),
    `import { experimental_generateVideo, generateImage } from "ai";
import {
  createMagicHour,
  magichour,
  MagicHourError,
  type MagicHourImageModelId,
  type MagicHourSettings,
  type MagicHourVideoModelId,
} from ${JSON.stringify(pkg.name)};

const settings: MagicHourSettings = {
  apiKey: "key",
  fetch: globalThis.fetch,
  timeoutMs: 60_000,
  onProjectCreated: ({ id, kind }) => void [id, kind],
};
const provider = createMagicHour(settings);
const imageModel: MagicHourImageModelId = "flux-2-klein";
const videoModel: MagicHourVideoModelId = "ltx-2.5";
export async function run(): Promise<MagicHourError | undefined> {
  const { image } = await generateImage({ model: provider.image(imageModel), prompt: "x" });
  const { video } = await experimental_generateVideo({ model: magichour.video(videoModel), prompt: "x" });
  void [image.uint8Array, video.uint8Array];
  return undefined;
}
`
  );
  const tsc = resolve("node_modules/.bin/tsc");
  execFileSync(tsc, ["-p", consumer], { cwd: consumer, stdio: "inherit" });
  console.log(`${pkg.name}: installed from the packed tarball, imported and type-checked`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
