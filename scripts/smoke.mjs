// Installs the packed package into an empty project with the AI SDK, then imports it and
// type-checks a call to the AI SDK against its declarations. Run after `yarn build`.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const { name } = JSON.parse(readFileSync("package.json", "utf8"));
const dir = mkdtempSync(join(tmpdir(), "smoke-"));

function locked(dependency) {
  const { version } = JSON.parse(
    readFileSync(`node_modules/${dependency}/package.json`, "utf8"),
  );
  return `${dependency}@${version}`;
}

try {
  const tarball = join(dir, "package.tgz");
  execFileSync("yarn", ["pack", "--out", tarball], { stdio: "ignore" });

  writeFileSync(join(dir, "package.json"), '{"private":true,"type":"module"}');
  // The AI SDK's declarations need @types/node and @types/json-schema, as in any real app.
  execFileSync(
    "npm",
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      tarball,
      locked("ai"),
      locked("@types/node"),
      "@types/json-schema@7",
    ],
    { cwd: dir, stdio: "ignore" },
  );

  execFileSync(
    "node",
    [
      "--input-type=module",
      "-e",
      `(await import("${name}")).magichour.image("flux-2-klein");`,
    ],
    { cwd: dir, stdio: "inherit" },
  );

  // skipLibCheck is off so a broken import inside the published declarations fails here.
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        module: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: ["node"],
      },
      files: ["consumer.ts"],
    }),
  );
  writeFileSync(
    join(dir, "consumer.ts"),
    `import { experimental_generateVideo, generateImage } from "ai";
import { magichour } from "${name}";

await generateImage({ model: magichour.image("flux-2-klein"), prompt: "x" });
await experimental_generateVideo({ model: magichour.video("ltx-2.5"), prompt: "x" });
`,
  );
  execFileSync(resolve("node_modules/.bin/tsc"), ["-p", dir], {
    stdio: "inherit",
  });
  console.log(`${name}: installed, imported and type-checked`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
