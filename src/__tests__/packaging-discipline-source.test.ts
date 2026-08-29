import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoFile } from "./test-helpers.js";

const root = process.cwd();

/** The `jobs:` block of a workflow, split into `job id -> raw job body`. Inside
 *  `jobs:` the job ids are the only keys at two-space indentation; everything
 *  belonging to a job is indented further. Throws when a file has no `jobs:`
 *  block, so a renamed key fails loudly instead of yielding an empty map that
 *  every assertion below would then pass vacuously.
 *
 *  A run of comment and blank lines immediately above a job id belongs to that
 *  job, not to the one that ends above it. Reading them the other way puts the
 *  prose that explains a job — including the sentences that name what the job
 *  must not contain — inside its neighbour's body. */
function workflowJobs(source: string): Map<string, string> {
  const marker = "\njobs:\n";
  const start = source.indexOf(marker);
  if (start < 0) {
    throw new Error("workflow has no top-level `jobs:` block");
  }
  const jobs = new Map<string, string>();
  let id: string | null = null;
  let body: string[] = [];
  for (const line of source.slice(start + marker.length).split("\n")) {
    const header = /^ {2}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/u.exec(line);
    if (header) {
      const preamble: string[] = [];
      while (
        body.length > 0 &&
        /^\s*(#.*)?$/u.test(body[body.length - 1] as string)
      ) {
        preamble.unshift(body.pop() as string);
      }
      if (id !== null) jobs.set(id, body.join("\n"));
      id = header[1];
      body = preamble;
      continue;
    }
    body.push(line);
  }
  if (id !== null) jobs.set(id, body.join("\n"));
  return jobs;
}

/** Every shell command a job runs, in order, with block scalars (`run: |`)
 *  folded into one string.
 *
 *  Comments are excluded deliberately. The ordering invariant below forbids
 *  certain scripts from sharing a job with the compile and test steps, and both
 *  workflows explain that rule in comments that name those very scripts — a
 *  substring scan over the raw job body would read those sentences as steps and
 *  fail on the explanation. This is not a general YAML parser; it covers the
 *  shapes `.github/workflows/` actually uses. */
function jobRunCommands(jobBody: string): string[] {
  const commands: string[] = [];
  const lines = jobBody.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( *)(- )?run:(.*)$/u.exec(lines[index]);
    if (!match) continue;
    const [, spaces, dash, rest] = match;
    const indent = spaces.length + (dash ? dash.length : 0);
    const inline = rest.trim();
    if (inline !== "" && !/^[|>][-+]?\d*$/u.test(inline)) {
      commands.push(inline);
      continue;
    }
    const block: string[] = [];
    for (let next = index + 1; next < lines.length; next += 1) {
      const line = lines[next];
      if (line.trim() !== "" && line.length - line.trimStart().length <= indent) {
        break;
      }
      block.push(line.trim());
      index = next;
    }
    commands.push(block.join("\n"));
  }
  return commands;
}

/** True when `marker` appears in `command` as a whole name rather than as the
 *  prefix or suffix of a longer one. `bun run test` runs the suite;
 *  `bun run test:knip-gate` is a hygiene gate, and `String.includes` reads the
 *  first inside the second. A name ends where a character outside the class
 *  below begins. `.` is outside it deliberately: the file spellings are written
 *  without an extension, so `check-knip-baseline` has to match inside
 *  `scripts/check-knip-baseline.mjs`. */
const NAME_CHARACTER = /[A-Za-z0-9_:-]/u;

function mentions(command: string, marker: string): boolean {
  for (let from = 0; ; from += 1) {
    const at = command.indexOf(marker, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (command[at - 1] as string);
    const after = command[at + marker.length] ?? "";
    if (!NAME_CHARACTER.test(before) && !NAME_CHARACTER.test(after)) return true;
    from = at;
  }
}

/** Every gate that inspects the repository's own bookkeeping — a manifest, a
 *  baseline ledger, the self-test of a gate that reads one. A failure says a
 *  file is stale, never that the product is broken.
 *
 *  Both spellings for every gate: the package.json script name, and the base
 *  name of the script file that name resolves to. The asymmetry is the failure
 *  mode. A list holding `check:knip` but not `check-knip-baseline` waves
 *  through `node scripts/check-knip-baseline.mjs`, which is the same gate under
 *  a name package.json already contains — so "the list cannot see a name nobody
 *  has written yet" would understate it. "keeps each gate's two spellings in
 *  step with package.json" below fails when a rename leaves a pair stale.
 *
 *  A gate genuinely new to the repository still has to be added here by hand. */
const HYGIENE_GATES: ReadonlyArray<{ script: string; file: string }> = [
  { script: "check:knip", file: "check-knip-baseline" },
  { script: "check:knip:self-test", file: "check-knip-gate-self-test" },
  { script: "test:knip-gate", file: "knip-baseline.test" },
  { script: "check:screenshot-provenance", file: "check-screenshot-provenance" },
  {
    script: "check:screenshot-provenance:self-test",
    file: "check-screenshot-provenance-self-test",
  },
  { script: "check:test-duplicates", file: "check-test-duplicates" },
  { script: "check:sunset-inventory", file: "check-sunset-inventory" },
];

const REPOSITORY_HYGIENE = HYGIENE_GATES.flatMap(({ script, file }) => [
  script,
  file,
]);

const HYGIENE_SCRIPTS = new Set(HYGIENE_GATES.map(({ script }) => script));

const packageScripts = (
  JSON.parse(readRepoFile("package.json")) as {
    scripts: Record<string, string>;
  }
).scripts;

/** The shape of a package.json script that compiles, builds, or runs the
 *  product: `typecheck`, `build`, `test`, and anything under `build:` or
 *  `test:`. */
const VERIFICATION_SCRIPT_SHAPE = /^(?:typecheck|build|test)(?::|$)/u;

/** Scripts that verify but whose names do not carry that shape, each with the
 *  file its body resolves to. Both spellings, for the same reason
 *  HYGIENE_GATES keeps both, and "keeps the verification list in step with
 *  package.json" below checks the pair against package.json. */
const VERIFICATION_CHECKS: ReadonlyArray<{ script: string; file: string }> = [
  { script: "check:typecheck-tests", file: "check-test-typecheck-baseline" },
  {
    script: "check:typecheck-tests:self-test",
    file: "check-test-typecheck-gate-self-test",
  },
  { script: "check:test-coverage", file: "run-test-coverage-gate" },
];

/** Compile and test invocations that reach the tool without going through
 *  package.json. Unlike the two lists above this one is written by hand and
 *  has a gap that no test closes: a workflow that compiles by calling some
 *  other tool directly, under a spelling nobody has written here, is not
 *  recognised, and the ordering invariant would let a hygiene gate precede it.
 *  These two are what `.github/workflows/` calls today — `bunx playwright test`
 *  in e2e.yml and marketplace-e2e.yml, and `tsc --noEmit`, which is
 *  `bun run typecheck`'s body and is listed so a workflow inlining it is still
 *  seen. */
const DIRECT_TOOL_INVOCATIONS = ["tsc --noEmit", "playwright test"];

/** Names that appear only in a step which compiles, builds, or executes the
 *  product. The ordering invariant below is "no hygiene gate before one of
 *  these", so a step this list cannot see is a step a hygiene gate may legally
 *  precede.
 *
 *  Exhaustive over package.json, not over every possible spelling. The first
 *  half is derived — every script matching VERIFICATION_SCRIPT_SHAPE that
 *  HYGIENE_GATES does not claim — so a new `build:*` or `test:*` script joins
 *  it with no edit here. That derivation replaced a hand list that package.json
 *  had already outgrown: the hand list held thirteen names, and of the
 *  twenty-six package.json scripts carrying this shape it left twenty
 *  unrecognised — `build:main` and `test:coverage` among them — so a workflow
 *  step calling one of those was a step a hygiene gate could legally precede.
 *  The remaining halves are hand-written; DIRECT_TOOL_INVOCATIONS states the
 *  gap that leaves. */
const VERIFIES_THE_CODE = [
  ...Object.keys(packageScripts)
    .filter(
      (name) =>
        VERIFICATION_SCRIPT_SHAPE.test(name) && !HYGIENE_SCRIPTS.has(name),
    )
    .map((name) => `bun run ${name}`),
  ...VERIFICATION_CHECKS.flatMap(({ script, file }) => [script, file]),
  ...DIRECT_TOOL_INVOCATIONS,
].sort();

/** Whether a job declares a `needs:` dependency. A key, not a substring: the
 *  comments that explain why a job has no `needs:` edge contain the word
 *  themselves. */
function declaresNeeds(jobBody: string): boolean {
  return jobBody.split("\n").some((line) => /^ +needs:/u.test(line));
}

function matched(commands: string[], markers: string[]): string[] {
  return markers.filter((marker) =>
    commands.some((command) => mentions(command, marker))
  );
}

function firstCommandIndex(commands: string[], markers: string[]): number {
  return commands.findIndex((command) =>
    markers.some((marker) => mentions(command, marker))
  );
}

function lastCommandIndex(commands: string[], markers: string[]): number {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index] as string;
    if (markers.some((marker) => mentions(command, marker))) return index;
  }
  return -1;
}

function workflowFileNames(): string[] {
  return readdirSync(resolve(root, ".github/workflows"))
    .filter((entry) => /\.ya?ml$/u.test(entry))
    .sort();
}

describe("installer smoke and packaging discipline", () => {
  it("smoke-launches the packaged app before uploading installer artifacts", () => {
    const workflow = readRepoFile(".github/workflows/build-installers.yml");
    const smokeScript = readRepoFile("scripts/smoke-packaged-app.mjs");

    expect(workflow).toContain("Smoke launch packaged app");
    expect(workflow).toContain("scripts/smoke-packaged-app.mjs --target");
    expect(workflow).toContain("xvfb-run -a");
    expect(workflow).toContain("sudo apt-get update && sudo apt-get install -y fakeroot rpm xvfb");
    expect(workflow).toContain(
      "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9 # v6.1.0",
    );
    expect(workflow).toContain("~/.bun/install/cache");
    expect(workflow).toContain("ELECTRON_BUILDER_CACHE");
    expect(workflow).toContain("--skip-native-rebuild");
    expect(workflow.indexOf("Smoke launch packaged app")).toBeLessThan(workflow.indexOf("Upload installers"));

    expect(smokeScript).toContain("ERR_MODULE_NOT_FOUND");
    expect(smokeScript).toContain("Cannot find package");
    expect(smokeScript).toContain("linux-unpacked");
    expect(smokeScript).toContain("/^linux-.+-unpacked$/u");
    expect(smokeScript).toContain("linuxExecutablePreferenceSuffixes(process.arch, sep)");
    expect(smokeScript).toContain("pickBestByExactSuffix");
    expect(smokeScript).toContain("win-unpacked");
    expect(smokeScript).toContain(".app");
    expect(smokeScript).toContain("LVIS_HOME");
    expect(smokeScript).toContain("assertPackagedFirstLaunchSeed");
    expect(smokeScript).toContain("assertUpgradeProbe");
    expect(smokeScript).toContain("expectedSeededMarkdownFiles");
    expect(smokeScript).toContain('join(root, "resources", subdir)');
    expect(smokeScript).toContain('["agents", "skills", "prompts"]');
    expect(smokeScript).toContain("skills");
    expect(smokeScript).toContain("prompts");
  });

  it("does not persist cross-repository E2E checkout credentials into PR-controlled steps", () => {
    const workflow = readRepoFile(".github/workflows/marketplace-e2e.yml");
    const checkoutNames = [
      "lvis-app",
      "lvis-marketplace",
      "lvis-plugin-sdk",
      "lvis-plugin-ep",
    ];

    for (const name of checkoutNames) {
      const start = workflow.indexOf(`- name: Checkout ${name}`);
      expect(start).toBeGreaterThanOrEqual(0);
      const nextStep = workflow.indexOf("\n      - name:", start + 1);
      const block = workflow.slice(start, nextStep);
      expect(block).toContain("persist-credentials: false");
    }

    const sdkStart = workflow.indexOf("- name: Checkout lvis-plugin-sdk");
    const sdkEnd = workflow.indexOf("\n      - name:", sdkStart + 1);
    const sdkCheckout = workflow.slice(sdkStart, sdkEnd);
    expect(sdkCheckout).not.toContain("M4_MARKETPLACE_CHECKOUT_TOKEN");
  });

  it("keeps privileged workflows on trusted default-branch events", () => {
    for (const path of [
      ".github/workflows/marketplace-e2e.yml",
      ".github/workflows/e2e.yml",
      ".github/workflows/a2a-p4-5-packaged-evidence.yml",
      ".github/workflows/web-deploy.yml",
    ]) {
      const workflow = readRepoFile(path);
      expect(workflow).toContain("repository_dispatch:");
      expect(workflow).not.toContain("workflow_dispatch:");
      expect(workflow).not.toContain("pull_request:");
    }

    const marketplaceE2e = readRepoFile(".github/workflows/marketplace-e2e.yml");
    expect(marketplaceE2e).toContain("merge-base --is-ancestor");
    expect(marketplaceE2e).toContain("persist-credentials: false");

    const signing = readRepoFile(
      ".github/workflows/a2a-p4-5-packaged-evidence.yml",
    );
    expect(signing).toContain("environment: release-signing");
    expect(signing).toContain("merge-base --is-ancestor");

    const coreCi = readRepoFile(".github/workflows/ci.yml");
    expect(coreCi).not.toContain("LVIS_REPO_READ_TOKEN");
    const webCi = readRepoFile(".github/workflows/web-ci.yml");
    expect(webCi).not.toContain("CLOUDFLARE_API_TOKEN");
  });

  it("keeps private E2E acquisition separate from candidate execution", () => {
    const workflow = readRepoFile(".github/workflows/e2e.yml");
    const stage = workflow.slice(
      workflow.indexOf("  stage-inputs:"),
      workflow.indexOf("  e2e:"),
    );
    const execute = workflow.slice(workflow.indexOf("  e2e:"));

    expect(stage).toContain("secrets.LVIS_REPO_READ_TOKEN");
    expect(stage).toContain("git -C \"$repo\" archive");
    expect(stage).toContain("manifest.tsv");
    expect(stage).toContain("artifact-digest");
    for (const forbidden of [
      "bun install",
      "bun run build",
      "playwright test",
      "node scripts/",
      "npm ",
    ]) {
      expect(stage).not.toContain(forbidden);
    }

    expect(execute).toContain("Download staged E2E inputs");
    expect(execute).toContain("EXPECTED_MANIFEST_SHA256");
    expect(execute).toContain("sha256sum \"$archive\"");
    expect(execute).toContain("tar -xzf \"$archive\" -C sources");
    expect(execute).toContain("bun install --frozen-lockfile");
    expect(execute).toContain("bunx playwright test");
    expect(execute).not.toContain("secrets.");
    expect(execute).not.toContain("LVIS_REPO_READ_TOKEN");
  });

  it("deploys only a digest-bound web export on the protected runner", () => {
    const workflow = readRepoFile(".github/workflows/web-deploy.yml");
    const build = workflow.slice(
      workflow.indexOf("  build:"),
      workflow.indexOf("  deploy:"),
    );
    const deploy = workflow.slice(workflow.indexOf("  deploy:"));

    expect(build).toContain("bun install --frozen-lockfile");
    expect(build).toContain("bun run build");
    expect(build).toContain("bundle.sha256");
    expect(build).toContain("artifact-digest");
    expect(build).not.toContain("environment: web-production");
    expect(build).not.toContain("CLOUDFLARE_API_TOKEN");

    expect(deploy).toContain("environment: web-production");
    expect(deploy).toContain("EXPECTED_BUNDLE_SHA256");
    expect(deploy).toContain("sha256sum -c bundle.sha256");
    expect(deploy).toContain(
      "cloudflare/wrangler-action@ebbaa1584979971c8614a24965b4405ff95890e0 # v4.0.0",
    );
    expect(deploy).toContain('wranglerVersion: "4.114.0"');
    expect(deploy).not.toContain("actions/checkout");
    expect(deploy).not.toContain("setup-bun");
    expect(deploy).not.toContain("bun install");
    expect(deploy).not.toContain("bun run build");
  });

  it("pins every external workflow action to a reviewed commit SHA", () => {
    const workflowDirectory = resolve(root, ".github/workflows");
    for (const name of readdirSync(workflowDirectory).filter((entry) =>
      /\.ya?ml$/u.test(entry)
    )) {
      const source = readRepoFile(`.github/workflows/${name}`);
      for (const match of source.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/gu)) {
        const [, action, revision] = match;
        expect(
          revision,
          `${name}: ${action} must be pinned to an immutable commit`,
        ).toMatch(/^[0-9a-f]{40}$/u);
      }
    }
  });


  it("runs no repository-hygiene gate ahead of a compile or test step", () => {
    const names = workflowFileNames();
    expect(names.length).toBeGreaterThan(0);

    let jobsCarryingGates = 0;
    for (const name of names) {
      const jobs = workflowJobs(readRepoFile(`.github/workflows/${name}`));
      expect(jobs.size, `${name}: no jobs parsed`).toBeGreaterThan(0);
      for (const [id, body] of jobs) {
        // Guard on the split itself. `workflowJobs` recognises a job by a
        // two-space-indented key, which a shell line inside a `run: |` block
        // could in principle imitate; the resulting fragment would carry no
        // steps and the scan below would quietly find nothing in it. Every real
        // job in this directory declares `steps:` or `uses:` at four spaces.
        expect(
          / {4}(steps|uses):/u.test(body),
          `${name}: "${id}" was parsed as a job but declares no steps — ` +
            "the job splitter mis-read this file",
        ).toBe(true);
        const commands = jobRunCommands(body);
        const firstHygiene = firstCommandIndex(commands, REPOSITORY_HYGIENE);
        if (firstHygiene < 0) continue;
        jobsCarryingGates += 1;
        const lastVerification = lastCommandIndex(commands, VERIFIES_THE_CODE);
        if (lastVerification < 0) continue;
        expect(
          firstHygiene,
          `${name}: job "${id}" runs the hygiene gate(s) ` +
            `${matched(commands, REPOSITORY_HYGIENE).join(", ")} before the ` +
            `step \`${commands[lastVerification] as string}\`. A job stops at ` +
            "its first failed step, so a stale manifest there skips the steps " +
            "that verify the code and leaves a red check meaning \"nothing " +
            "was verified\", which is indistinguishable from \"something was " +
            "verified and failed\". Put every hygiene gate after the last " +
            "compile or test step in its job, or in a job of its own — and if " +
            "it moves to a job of its own, read the note on the " +
            "build-and-test test below first.",
        ).toBeGreaterThan(lastVerification);
      }
    }
    // Two today: ci.yml's build-and-test and web-ci.yml's
    // screenshot-provenance. A scan that stopped recognising the gates would
    // otherwise pass by finding nothing to check.
    expect(jobsCarryingGates).toBeGreaterThanOrEqual(2);
  });

  it("keeps ci.yml's hygiene gates inside the required build-and-test check", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/ci.yml"));
    const verification = jobs.get("build-and-test");
    expect(verification, "ci.yml lost its build-and-test job").toBeDefined();
    const commands = jobRunCommands(verification as string);

    // `build-and-test` is one of the two required status checks on `main`; the
    // other is `naming-gate`. Read the current list with
    //   gh api repos/lvis-project/lvis-app/branches/main/protection \
    //     --jq .required_status_checks.contexts
    // A gate moved into a job of its own reports under a check name that list
    // does not contain, and an unlisted check cannot block a merge. That was
    // measured, not feared: with these three in a separate `repo-hygiene` job,
    // a commit carrying a deliberately stale manifest entry had both required
    // contexts reporting success, and the checks that did go red on it reported
    // under names the required list does not contain.
    // Splitting them out is the better shape — it takes a change that adds the
    // new job's check name to that list at the same time.
    expect(
      matched(commands, REPOSITORY_HYGIENE),
      "ci.yml's build-and-test must run every core hygiene gate: it carries a " +
        "required check name, and a gate outside it stops blocking merges",
    ).toEqual([
      "check:knip",
      "test:knip-gate",
      "check:screenshot-provenance",
      "check:screenshot-provenance:self-test",
      "check:test-duplicates",
      "check:sunset-inventory",
    ]);

    // `test:a2a-p4-5:evidence` is on the verification side on purpose. It
    // asserts over the release-signing workflow's source, but it also exercises
    // the release-tooling libraries, so its failure means code is wrong.
    // Sorted, because VERIFIES_THE_CODE is sorted and `matched` returns marker
    // order — this pins the set, not the step order. The step order is pinned
    // by the ordering scan above and by "keeps the release-tooling suite last
    // among the verification steps" below.
    expect(matched(commands, VERIFIES_THE_CODE)).toEqual([
      "bun run build",
      "bun run test:a2a-p4-5:evidence",
      "bun run typecheck",
      "check:test-coverage",
      "check:typecheck-tests",
      "check:typecheck-tests:self-test",
    ]);
  });

  it("keeps the release-tooling suite last among the verification steps", () => {
    // ci.yml says so beside the step: a narrow `node --test` suite placed
    // ahead of the vitest suite would skip it. `matched` returns marker order,
    // not step order, so the assertion above cannot see this; the index does.
    const jobs = workflowJobs(readRepoFile(".github/workflows/ci.yml"));
    const commands = jobRunCommands(jobs.get("build-and-test") as string);
    const last = lastCommandIndex(commands, VERIFIES_THE_CODE);
    expect(last).toBeGreaterThanOrEqual(0);
    expect(
      commands[last],
      "ci.yml: build-and-test now ends its verification with a step other " +
        "than the release-tooling suite. That suite is narrow and fast; " +
        "anything it precedes is a step it can skip.",
    ).toContain("test:a2a-p4-5:evidence");
  });

  it("keeps the web screenshot gate out of the static-export build job", () => {
    const jobs = workflowJobs(readRepoFile(".github/workflows/web-ci.yml"));

    const build = jobs.get("build");
    const gate = jobs.get("screenshot-provenance");
    expect(build, "web-ci.yml lost its build job").toBeDefined();
    expect(gate, "web-ci.yml lost its screenshot-provenance job").toBeDefined();

    // Splitting costs no enforcement here, unlike in ci.yml: the check name
    // this job's `build` reports under is not in the required list either.
    expect(matched(jobRunCommands(build as string), REPOSITORY_HYGIENE)).toEqual(
      [],
    );
    expect(matched(jobRunCommands(build as string), VERIFIES_THE_CODE))
      .toContain("bun run build");
    expect(matched(jobRunCommands(gate as string), REPOSITORY_HYGIENE)).toEqual([
      "check-screenshot-provenance",
      "check-screenshot-provenance-self-test",
    ]);
    expect(matched(jobRunCommands(gate as string), VERIFIES_THE_CODE)).toEqual(
      [],
    );
    // A `needs:` edge would restore the skipping the split removed: a failed
    // gate would take `build` with it and report it as skipped.
    expect(declaresNeeds(gate as string)).toBe(false);
  });

  it("keeps each hygiene gate's two spellings in step with package.json", () => {
    for (const { script, file } of HYGIENE_GATES) {
      const body = packageScripts[script];
      expect(body, `package.json has no "${script}" script`).toBeDefined();
      expect(
        mentions(body as string, file),
        `"${script}" no longer runs ${file}; the workflow scan would stop ` +
          "recognising this gate under its file-name spelling",
      ).toBe(true);
    }
  });

  it("keeps the verification list in step with package.json", () => {
    // The same cross-check the hygiene list gets, on the other side of the
    // ordering invariant. Both sides are load-bearing: a gate the scan cannot
    // see is a gate it will not police, and a verification step the scan
    // cannot see is a step a gate may legally precede.
    for (const { script, file } of VERIFICATION_CHECKS) {
      const body = packageScripts[script];
      expect(body, `package.json has no "${script}" script`).toBeDefined();
      expect(
        mentions(body as string, file),
        `"${script}" no longer runs ${file}; the workflow scan would stop ` +
          "recognising this step under its file-name spelling",
      ).toBe(true);
    }

    // Totality over package.json for the derived half. This is what a hand
    // list could not give: before the derivation, thirteen names stood against
    // twenty-six scripts of this shape and left twenty of them unseen.
    // The floor guards the derivation itself — a shape regex that stopped
    // matching would otherwise make the loop below pass vacuously.
    const shaped = Object.keys(packageScripts).filter((name) =>
      VERIFICATION_SCRIPT_SHAPE.test(name)
    );
    expect(shaped.length).toBeGreaterThan(20);
    for (const name of shaped) {
      if (HYGIENE_SCRIPTS.has(name)) continue;
      expect(
        matched([`bun run ${name}`], VERIFIES_THE_CODE),
        `package.json defines "${name}", which compiles or tests, and the ` +
          "workflow scan does not recognise it",
      ).not.toEqual([]);
    }

    // The two spellings a certification run used to walk a verification step
    // past a hygiene gate while this file still reported 23 passing tests.
    // Subsumed by the loop above; kept because they are the reproduction.
    for (const command of ["bun run test:coverage", "bun run build:main"]) {
      expect(matched([command], VERIFIES_THE_CODE), command).not.toEqual([]);
    }
  });

  it("keeps every core hygiene gate out of the `build` composite", () => {
    // `bun run build` is one workflow step and fifteen commands, so the
    // workflow scan above — which reads steps — cannot see inside it. A gate
    // placed there fails ci.yml's build step and skips every step after it,
    // the whole suite included: the defect this file exists to keep out of
    // workflows, one layer down. `check:sunset-inventory` was the first
    // command of this composite until the change that added this assertion.
    const build = packageScripts["build"];
    expect(build, "package.json has no build script").toBeDefined();
    const commands = (build as string).split("&&").map((part) => part.trim());
    const inside = HYGIENE_GATES.filter(({ script, file }) =>
      commands.some(
        (command) => mentions(command, script) || mentions(command, file),
      )
    ).map(({ script }) => script);
    expect(
      inside,
      "package.json's `build` script runs a hygiene gate. A job's build step " +
        "stops at that gate, so a stale ledger skips the steps that verify " +
        "the code. Run it as its own step, after the last compile or test " +
        "step in the job.",
    ).toEqual([]);
  });

  it("pins the checks that remain inside the `build` composite", () => {
    // The residual, recorded rather than claimed away. These are not hygiene
    // gates by the list above, but each can still fail ci.yml's build step and
    // skip the suite behind it. They stay because each reads either the
    // sources being compiled or the bytes the build itself just wrote, and a
    // local `bun run build` is where that drift has to surface. Pinned as an
    // exact list so a check added to `build` fails here and has to be argued
    // for, and so the count in ci.yml's comment beside the trailing gates
    // cannot drift away from the composite it describes.
    const commands = (packageScripts["build"] as string)
      .split("&&")
      .map((part) => part.trim());
    const assertions = commands.filter((command) =>
      /(?:^|[\s/])check[-:]/u.test(command)
    );
    expect(assertions).toEqual([
      "bun run check:import-cycles",
      "node scripts/check-generated-assets.mjs",
      "bun run check:i18n-catalog",
      "bun run check:i18n-barrels",
      "node scripts/check-no-tls-bypass.mjs",
      "node scripts/check-opacity-tokens.mjs",
      "node scripts/check-color-tokens.mjs",
      "node scripts/check-shell-geometry-tokens.mjs",
      "node scripts/check-no-inline-channels.mjs",
      "bun run check:source-text-safe",
    ]);

    // Of those ten, the four that a later command in the same composite
    // compiles behind. ci.yml's comment states this number; this is where it
    // comes from.
    const lastCompile = commands.reduce(
      (found, command, index) =>
        /bun run build:/u.test(command) ? index : found,
      -1,
    );
    expect(lastCompile).toBeGreaterThan(0);
    expect(
      assertions.filter((command) => commands.indexOf(command) < lastCompile),
    ).toEqual([
      "bun run check:import-cycles",
      "node scripts/check-generated-assets.mjs",
      "bun run check:i18n-catalog",
      "bun run check:i18n-barrels",
    ]);
  });

  it("keeps the composite that orders a hygiene scan first out of CI", () => {
    // `check:test-quality` runs `check:test-duplicates` before
    // `check:test-coverage`, so a duplicated helper ends the step before a test
    // executes — the same masking defect one layer down, in an npm script
    // instead of a workflow. The workflow scan above reads workflow step order
    // and cannot see inside a script, so the composite is named here directly.
    const composite = packageScripts["check:test-quality"];
    expect(composite, "package.json has no check:test-quality").toBeDefined();
    expect(composite as string).toContain("check:test-duplicates");
    expect(composite as string).toContain("check:test-coverage");
    // The order is the reason, not the membership: a composite that ran the
    // suite first and scanned afterwards would be safe to call from a job.
    expect(
      (composite as string).indexOf("check:test-duplicates"),
    ).toBeLessThan((composite as string).indexOf("check:test-coverage"));
    for (const name of workflowFileNames()) {
      for (const [id, body] of workflowJobs(
        readRepoFile(`.github/workflows/${name}`),
      )) {
        expect(
          jobRunCommands(body).some((command) =>
            mentions(command, "check:test-quality")
          ),
          `${name}: job "${id}" calls the check:test-quality composite, which ` +
            "runs the duplicate scan before the suite. Call its halves.",
        ).toBe(false);
      }
    }
  });

  it("runs the NSIS smoke before win-unpacked and owner-cleans HKCU afterward", () => {
    const smoke = readRepoFile("scripts/smoke-packaged-app.mjs");
    const installerSmoke = smoke.indexOf(
      "await runWindowsInstallerSmoke(releaseDir, timeoutMs)",
    );
    const unpackedSmoke = smoke.indexOf(
      "await launchSmoke(executable, timeoutMs)",
    );

    expect(installerSmoke).toBeGreaterThanOrEqual(0);
    expect(unpackedSmoke).toBeGreaterThan(installerSmoke);
    expect(
      smoke.lastIndexOf("cleanupOwnedWindowsProtocolHandler(executable)"),
    ).toBeGreaterThan(smoke.indexOf("} finally {"));
    const launchBody = smoke.slice(
      smoke.indexOf("async function launchSmoke"),
      smoke.indexOf("async function runWindowsInstallerSmoke"),
    );
    expect(launchBody.indexOf(
      "assertWindowsPerMachineMarkerAbsent(executable)",
    )).toBeLessThan(launchBody.indexOf("runPackagedAppOnce"));
    expect(smoke).toContain(".lvis-nsis-per-machine-v1");
    expect(smoke).toContain(
      "lstatSync(markerPath, { throwIfNoEntry: false })",
    );
    expect(readRepoFile("src/main/lvis-protocol-registration.ts"))
      .toContain(".lvis-nsis-per-machine-v1");


    const cleanupScript = smoke.slice(
      smoke.indexOf("const WINDOWS_PROTOCOL_CLEANUP_SCRIPT"),
      smoke.indexOf("const TARGET_PLATFORM"),
    );
    expect(cleanupScript).toContain("$expectedCommand");
    expect(cleanupScript).toContain(
      "$expectedCommand = '\\\"' + $env:LVIS_PROTOCOL_OWNER_EXE + '\\\" \\\"%1\\\"'",
    );
    expect(cleanupScript).not.toContain("$launchExecutable");
    expect(cleanupScript).not.toContain("-match '\\s'");
    expect(cleanupScript).not.toContain(
      "owned lvis protocol cleanup left registry residue",
    );
    expect(cleanupScript).toContain("$expectedIcon");
    expect(cleanupScript).toContain("function Remove-RegistryValueIfEquals");
    expect(cleanupScript).toContain("$key.GetValueKind($name)");
    expect(cleanupScript).toContain("$commandKind = $commandKey.GetValueKind('')");
    expect(cleanupScript).toContain(
      "if ($null -eq $rootKey) { throw 'expected win-unpacked HKCU lvis protocol root is missing' }",
    );
    expect(cleanupScript).not.toContain(
      "if ($null -eq $rootKey) { return }",
    );

    expect(cleanupScript).toContain(
      "[Microsoft.Win32.RegistryValueKind]::String",
    );
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $commandPath '' $expectedCommand",
    );
    expect(cleanupScript).toContain("DefaultIcon' '' $expectedIcon");
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $rootPath 'URL Protocol' ''",
    );
    expect(cleanupScript).toContain(
      "Remove-RegistryValueIfEquals $rootPath '' 'URL:lvis'",
    );
    expect(cleanupScript).toContain(
      "[System.StringComparison]::OrdinalIgnoreCase",
    );
    expect(cleanupScript).toContain("$key.DeleteValue($name, $false)");
    expect(cleanupScript).toContain("Remove-EmptyRegistryKey");
    expect(cleanupScript).not.toContain("$expectedQuoted");
    expect(cleanupScript).not.toContain("$expectedUnquoted");
    expect(cleanupScript).not.toContain("StartsWith");
  });
  it("documents runtime package imports as dependencies, not devDependencies", () => {
    const agents = readRepoFile("AGENTS.md");

    expect(agents).toContain("unbundled runtime code");
    expect(agents).toContain("Renderer/UI-only");
    expect(agents).toContain("webpack/esbuild");
    expect(agents).toContain("`dependencies`");
    expect(agents).toContain("`devDependencies`");
    expect(agents).toContain("packaged-app smoke");
  });

  it("keeps cross-cutting change detection advisory", () => {
    const agents = readRepoFile("AGENTS.md");
    const claude = readRepoFile("CLAUDE.md");
    const contributing = readRepoFile("CONTRIBUTING.md");
    const pullRequestTemplate = readRepoFile(".github/pull_request_template.md");
    const clusterWorkflow = readRepoFile(".github/workflows/cluster-detector.yml");
    const clusterStatusOwners = readdirSync(resolve(root, ".github/workflows"))
      .filter((name) => /\.ya?ml$/.test(name))
      .filter((name) => {
        const source = readRepoFile(`.github/workflows/${name}`);
        return /statuses:\s*write|\/statuses\//.test(source);
      })
      .sort();
    const clusterScope = readRepoFile("scripts/check-cluster-scope.mjs");
    const sensitivePathHelper = readRepoFile("scripts/check-cluster-sensitive-paths.mjs");

    expect(agents).toContain("## Cross-Cutting Change Advisory");
    expect(agents).toContain("never requires an external reviewer, collaborator");
    expect(agents).toContain("Owner self-review and automated review are valid evidence.");
    expect(agents).toContain("does not write commit");
    expect(agents).toContain("never blocks merge.");
    expect(agents).not.toContain("## Cross-Cutting Review Gate");
    expect(agents).not.toContain("cluster-review-passed");
    expect(agents).not.toContain("visible role row and hidden marker");

    expect(pullRequestTemplate).toContain("## Sensitive-Area Advisory");
    expect(pullRequestTemplate).toContain("This is not a merge gate");
    expect(pullRequestTemplate).toContain("external reviewer");
    expect(pullRequestTemplate).not.toContain("## Cross-Cutting Review Gate");
    expect(pullRequestTemplate).not.toContain("cluster-review:");
    expect(pullRequestTemplate).not.toContain("cluster-review-passed");

    expect(clusterWorkflow).toContain("pull_request_target:");
    expect(clusterWorkflow).toContain("contents: read");
    expect(clusterWorkflow).toContain("pull-requests: read");
    expect(clusterWorkflow).toContain("::warning::Sensitive-area cluster advisory");
    expect(clusterWorkflow).not.toContain("pull-requests: write");
    expect(clusterWorkflow).not.toContain("statuses: write");
    expect(clusterWorkflow).not.toContain("cluster-review-passed");
    expect(clusterStatusOwners).toEqual([]);
    expect(existsSync(resolve(root, "scripts/check-cluster-review-attestation.mjs"))).toBe(false);
    expect(existsSync(resolve(root, "test/scripts/check-cluster-review-attestation.test.ts"))).toBe(false);

    expect(clusterScope).toContain(
      'import { hasSensitiveClusterPath } from "./check-cluster-sensitive-paths.mjs"',
    );
    expect(clusterScope).toContain("previous_filename");
    expect(clusterScope).toContain("github-previous-filename-required");
    // Inverted deliberately, in the file whose job is keeping this gate
    // advisory. A repeated pull is the documented consequence of paging a
    // MUTABLE sort key while the repo is being merged into, not corruption,
    // and hard-failing on it turned an ordinary merge landing mid-scan into
    // a blocked PR. The scan skips the repeat instead; that behaviour is
    // pinned in test/scripts/check-cluster-scope.test.ts.
    expect(clusterScope).not.toContain("pull-request-page-duplicate");
    // Inverted for the same reason, one layer up. `pull-request-window-changed`
    // compared two scans of the rolling window and hard-failed on ANY
    // difference between them — a candidate's `updated_at` advancing, the same
    // members arriving in another order, or one unrelated pull merging between
    // the scans. The scans are unioned now, so a late arrival is evaluated
    // instead of reported as corruption. What survives is a BOUNDED settle
    // check: a window that never stops moving still fails, loudly and rarely.
    expect(clusterScope).not.toContain("pull-request-window-changed");
    expect(clusterScope).toContain("pull-request-window-unsettled");
    expect(clusterScope).toContain("pull-request-files-incomplete");
    expect(clusterScope).toContain("pull-request-files-saturated");
    expect(clusterScope).toContain("pull-request-commits-saturated");
    expect(clusterScope).toContain("pull-request-pages-saturated");
    expect(clusterScope).toContain('state: "closed"');
    expect(clusterScope).not.toContain("--limit 100");
    expect(sensitivePathHelper).toContain("parseNulDelimitedGitPaths");
    expect(sensitivePathHelper).toContain(
      'return !path.startsWith(`${dir}/__tests__/`)',
    );
    expect(claude).toContain("[`AGENTS.md`](./AGENTS.md)");
    expect(claude).toContain("duplicates no");

    for (const guidance of [agents, contributing, pullRequestTemplate]) {
      expect(guidance).toContain("review-only Markdown");
      expect(guidance).toMatch(/runtime/i);
      expect(guidance).toMatch(/instruction/i);
      expect(guidance).toMatch(/workflow/i);
      expect(guidance).toMatch(/sensitive/i);
    }

    expect(agents).toContain("openFeatureNamespace");
    expect(agents).toContain("never hand-roll `mkdir`");
    expect(agents).toContain("`0o700` directory / `0o600`");
    expect(agents).toContain("mode bits alone are not encryption");
    expect(agents).toContain("src/shared/tool-timeout-policy.ts");
    expect(agents).toContain("TOOL_TIMEOUT_POLICY");
    expect(agents).toContain("runWithCeiling");
    expect(agents).toContain("AbortController");
    expect(agents).toContain("plus `Tool Governance` and `Security And Audit`");
    expect(agents).not.toContain("architecture section 6.3");
    expect(agents).toContain("staged default-on for `darwin`");
    expect(agents).toContain("opt-in for `linux`/`win32`");
    expect(agents).toContain("On `darwin`/`linux`, explicit `LVIS_SANDBOX_ENABLED=1`");
    expect(agents).toContain("default/settings mode may gracefully degrade");
    expect(agents).toContain("Windows always");
    expect(agents).toContain("degrades non-brickingly when unavailable");
    expect(agents).toContain("relaxation/effect-boundary coupling");
    expect(agents).toContain("No Fallback Code");
    expect(agents).toContain("plugin manifest field updates its schema and SDK");
    expect(agents).toContain("HostApi change bumps every plugin dependency pin");
    expect(agents).toContain("UI edits start with `grep` before editing");
    expect(agents).toContain("app shells `*Window`");
    expect(agents).toContain("bodies `*Content`, and modals `*Dialog`");
    expect(agents).toContain("marketplace API, `gh`, or local sources");
    expect(agents).toContain("not WebSearch. After three identical failures, change approach");
    expect(agents).toContain("sender/frame/origin checks");
    expect(agents).toContain("DLP handling");
    expect(agents).toContain("fail-closed defaults");
    expect(agents).toContain("active recipient's own permission and approval");
    expect(agents).toContain("Do not bypass hooks");
    expect(agents).toContain("Never push directly to `main`");
    expect(agents).toContain("same-PR field-addition");
    expect(agents).toContain("A new IPC channel is one coherent change");
    expect(agents).toContain("gh pr merge --merge");
    expect(agents).toContain("squash merge is not allowed");
    expect(agents).not.toContain("Markdown-only pushes");
    expect(contributing).not.toContain("Markdown-only pushes");
  });

  it("declares sonic-boom as a runtime dependency (log-file-sink imports it unbundled)", () => {
    // src/lib/log-file-sink.ts adds a top-level import from "sonic-boom" that
    // the packaged main process resolves directly from app.asar (unbundled
    // runtime code). The repository AGENTS.md contract requires it in
    // `dependencies`, NOT `devDependencies` — otherwise electron-builder prunes
    // it and the installed app crashes on first log write with
    // ERR_MODULE_NOT_FOUND (the PR #684 regression class). Assert the dependency
    // declaration so a future prune-to-devDep is caught here.
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(packageJson.dependencies?.["sonic-boom"]).toBeDefined();
    expect(packageJson.devDependencies?.["sonic-boom"]).toBeUndefined();

    // And the import is actually present in the unbundled runtime source, so
    // this guard tracks a real import rather than an orphaned dependency.
    const sinkSource = readRepoFile("src/lib/log-file-sink.ts");
    expect(sinkSource).toContain('from "sonic-boom"');
  });

  it("keeps fast preview installer mode separate from size-optimized release artifacts", () => {
    const packageJson = readRepoFile("package.json");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const releaseChecklist = readRepoFile("docs/references/production-release-checklist.md");

    expect(packageJson).toContain('"dist:fast"');
    expect(packageJson).toContain('"dist:mac:fast"');
    expect(packageJson).toContain('"dist:win:fast"');

    expect(buildInstallers).toContain("--fast");
    expect(buildInstallers).toContain("release-fast");
    expect(buildInstallers).toContain("-c.compression=store");
    expect(buildInstallers).toContain("-c.npmRebuild=false");
    expect(buildInstallers).toContain("cannot be combined with --publish");

    expect(releaseChecklist).toContain("Fast preview mode is only for quick QA links");
    expect(releaseChecklist).toContain("Keep normal `dist:*` / `release`");
    expect(releaseChecklist).toContain("public release assets");
    expect(releaseChecklist).toContain("DMG 106M / ZIP 103M");
    expect(releaseChecklist).toContain("DMG 227M / ZIP 226M");
  });

  it("fails packaging when the platform uv payload or uv license notice is missing", () => {
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");
    const runtimeAssets = readRepoFile("scripts/packaged-runtime-assets.mjs");

    expect(runtimeAssets).toContain("HOST_PACKAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("PLUGIN_MANAGED_RUNTIME_ASSETS");
    expect(runtimeAssets).toContain("resources/uv-runtime");
    expect(runtimeAssets).toContain("resources/licenses/uv");
    expect(runtimeAssets).toContain("better-sqlite3-native-binding");
    expect(runtimeAssets).toContain("python-wheelhouse");
    expect(buildInstallers).toContain("hostRuntimeAssetSummary(target)");
    expect(buildInstallers).toContain("required runtime assets");
    expect(buildInstallers).toContain("checkPackageFootprint(target, fast)");
    expect(buildInstallers).toContain("expected exactly one packaged app.asar");
    expect(buildInstallers).toContain("assertUvRuntimePayload(target)");
    expect(buildInstallers).toContain("staged uv runtime must contain only");
    expect(buildInstallers).toContain("compressed uv archive missing from staged runtime");
    expect(buildInstallers).toContain("staged uv binary SHA mismatch");
    expect(afterPack).toContain("assertBundledUvResource(context)");
    expect(afterPack).toContain("packaged uv resource must contain exactly one target");
    expect(afterPack).toContain("packaged uv binary SHA mismatch");
    expect(afterPack).toContain("uv license notice missing");
    expect(packageFootprint).toContain("packaged uv binary SHA mismatch");
    expect(packageFootprint).toContain("uv license notice missing");
  });

  it("keeps packaged Windows smoke launch flags on the same launcher SOT", () => {
    const smokePackagedApp = readRepoFile("scripts/smoke-packaged-app.mjs");
    const smokeWindowsNsis = readRepoFile("scripts/smoke-windows-nsis-installer.mjs");
    const electronLaunchOptions = readRepoFile("scripts/lib/electron-launch-options.mjs");

    expect(smokePackagedApp).toContain("prepareElectronLaunchEnv");
    expect(smokePackagedApp).toContain("prepareElectronLaunchArgs");
    expect(smokePackagedApp).not.toContain('from "./electron-flags.mjs";');
    expect(smokeWindowsNsis).toContain("prepareElectronLaunchEnv");
    expect(smokeWindowsNsis).toContain("prepareElectronLaunchArgs");
    expect(smokeWindowsNsis).not.toContain("const WINDOWS_SAFE_GPU_FLAGS = [");
    expect(smokeWindowsNsis).not.toContain('const SANDBOX_BYPASS_FLAG = "--no-sandbox";');
    expect(electronLaunchOptions).toContain("prepareElectronLaunchEnv");
    expect(electronLaunchOptions).toContain("prepareElectronLaunchArgs");
    expect(electronLaunchOptions).toContain("SANDBOX_BYPASS_FLAG");
  });

  it("keeps #1444/#1446 packaged smoke gates wired", () => {
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const smokePackagedApp = readRepoFile("scripts/smoke-packaged-app.mjs");
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(afterPack).toContain("assertNodePtyBinary(context)");
    expect(afterPack).toContain("conpty.node");
    expect(afterPack).toContain("conpty_console_list.node");
    expect(afterPack).toContain("winpty.dll");
    expect(afterPack).toContain("winpty-agent.exe");
    // node-pty builds `spawn-helper` only on macOS (binding.gyp `OS=="mac"`), and
    // only macOS uses it at runtime (`pty.cc` gates helperPath on `__APPLE__`).
    // Scoping this assertion to any non-Windows platform fails every Linux
    // installer build at afterPack — it broke the v0.4.5/v0.4.6 tag builds.
    expect(afterPack).toContain('if (platform === "darwin") {');
    expect(afterPack).toContain("spawn-helper");
    expect(smokePackagedApp).toContain("assertPackagedFootprint(target, executable)");
    expect(smokePackagedApp).toContain("check-package-footprint.mjs");
    expect(smokePackagedApp).toContain("app.asar footprint passed");
    expect(packageFootprint).toContain("mermaid\\.[0-9a-f]{8}\\.js");
    expect(packageFootprint).toContain("required lazy renderer chunks missing from app.asar");
  });

  it("asserts the packaged node-pty binding where node-pty's loader resolves it", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const afterPack = readRepoFile("scripts/electron-after-pack.cjs");
    const buildInstallers = readRepoFile("scripts/build-installers.mjs");
    const localChecks = readRepoFile("scripts/hooks/run-local-checks.mjs");

    // Release installers disable electron-builder's own native rebuild, so
    // `build/Release` is not an artifact any packaging step produces on
    // Windows/macOS — only an install-time `electron-rebuild` ever did.
    expect(buildInstallers).toContain('args.push("-c.npmRebuild=false")');
    // node-pty is N-API and ships per-platform prebuilds; postinstall must not
    // compile a per-Electron-ABI copy (it needs a C++ toolchain, `node-gyp
    // rebuild` deletes the working binding before it fails, and the `&&` chain
    // then skips uv fetch + protocol registration + hook install).
    expect(packageJson.scripts?.postinstall).not.toContain("electron-rebuild");
    expect(packageJson.scripts?.postinstall).toBe(
      "node scripts/fetch-uv.mjs && node scripts/register-lvis-protocol.mjs && node scripts/hooks/install.mjs",
    );
    // afterPack follows node-pty's loader order instead of hardcoding the
    // per-ABI gyp output directory.
    expect(afterPack).toContain("function resolveNodePtyBindingDir(context) {");
    expect(afterPack).toContain("const ptyRoot = resolveNodePtyBindingDir(context);");
    expect(afterPack).toContain('join(ptyModuleRoot, "build", "Release")');
    expect(afterPack).toContain("join(ptyModuleRoot, \"prebuilds\", `${platform}-${arch}`)");
    // One arch-enum table for every packaged-native assert.
    expect(afterPack.match(/const ARCH_DIR_BY_ENUM = /gu)).toHaveLength(1);
    // ABI-drift repair still exists — it just lives only in the pre-push hook,
    // which probes first and rebuilds only when better-sqlite3 actually drifted.
    expect(localChecks).toContain('"electron-rebuild"');
    expect(localChecks).toContain("rebuildBetterSqlite3ForElectron(dir)");
  });

  it("packages only the default Electron locale in the desktop shell", () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { electronLanguages?: string[] };
    };
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(packageJson.build?.electronLanguages).toEqual(["en-US"]);
    expect(packageFootprint).toContain('DEFAULT_PACKAGED_ELECTRON_LANGUAGES = Object.freeze(["en-US"])');
    expect(packageFootprint).toContain("desktop app must package only the default Electron language");
    expect(packageFootprint).toContain("ship UI languages as marketplace language packs");
    expect(packageFootprint).not.toContain('["en-US", "ko"]');
    expect(packageFootprint).not.toContain('"ko.pak"');
    expect(packageFootprint).not.toContain('"ko.lproj"');
  });

  it("derives packaged runtime script footprint from the build asset SOT", () => {
    const packageFootprint = readRepoFile("scripts/check-package-footprint.mjs");

    expect(packageFootprint).toContain('import { resolveBuildAssets } from "./lib/build-assets.mjs";');
    expect(packageFootprint).toContain('resolveBuildAssets(root, "runtime-script")');
    expect(packageFootprint).not.toContain('"/dist/scripts/electron-flags.mjs",');
    expect(packageFootprint).not.toContain('"/dist/scripts/uv-targets.mjs",');
  });

  it("keeps electron-builder host runtime resources aligned with the runtime asset inventory", async () => {
    const packageJson = JSON.parse(readRepoFile("package.json")) as {
      build?: { extraResources?: Array<{ from?: string; to?: string }> };
    };
    const runtimeAssets = await import("../../scripts/packaged-runtime-assets.mjs");
    const extraResources = packageJson.build?.extraResources ?? [];
    const hostResources = runtimeAssets.HOST_PACKAGED_RUNTIME_ASSETS.flatMap(
      (asset: {
        stagedBy?: string;
        packageResource?: { from: string; to: string };
        licenseResource?: { from: string; to: string };
      }) =>
        // asar-unpacked native binaries (e.g. the better-sqlite3 N-API prebuild)
        // are packaged via asarUnpack + afterPack, not electron-builder
        // extraResources, so they are not expected in build.extraResources.
        asset.packageResource?.to?.startsWith("app.asar.unpacked/")
          ? []
          : [asset.packageResource, asset.licenseResource].filter(Boolean),
    );

    for (const resource of hostResources) {
      expect(extraResources).toContainEqual({
        from: resource.from,
        to: resource.to,
      });
    }
  });
});
