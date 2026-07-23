#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const REMAPPING_FIELDS = [
  "catalog",
  "catalogs",
  "overrides",
  "resolutions",
  "workspaces",
];
const LOCK_TOP_LEVEL_FIELDS = new Set([
  "configVersion",
  "lockfileVersion",
  "packages",
  "trustedDependencies",
  "workspaces",
]);
const LOCK_WORKSPACE_FIELDS = new Set(["name", ...DEPENDENCY_FIELDS]);
const LOCK_METADATA_FIELDS = new Set([
  "bin",
  "bundled",
  "cpu",
  ...DEPENDENCY_FIELDS,
  "optionalPeers",
  "os",
]);
const REGISTRY_RESOLUTION =
  /^(@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/;
const PACKAGE_NAME =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const SDK_PACKAGE = "@lvis/plugin-sdk";
const SDK_REPOSITORY = "lvis-project/lvis-plugin-sdk";

function policyError(message) {
  return new Error(`Bun dependency input policy rejected candidate: ${message}`);
}

function assert(condition, message) {
  if (!condition) {
    throw policyError(message);
  }
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      index += 2;
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      let terminated = false;
      while (index < input.length) {
        if (input[index] === "*" && input[index + 1] === "/") {
          index += 1;
          terminated = true;
          break;
        }
        if (input[index] === "\n") {
          output += "\n";
        }
        index += 1;
      }
      assert(terminated, "bun.lock contains an unterminated block comment");
      continue;
    }

    output += current;
  }

  assert(!inString, "bun.lock contains an unterminated string");
  return output;
}

function stripTrailingCommas(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === '"') {
        inString = false;
      }
      continue;
    }

    if (current === '"') {
      inString = true;
      output += current;
      continue;
    }

    if (current === ",") {
      let lookahead = index + 1;
      while (lookahead < input.length && /\s/.test(input[lookahead])) {
        lookahead += 1;
      }
      if (input[lookahead] === "}" || input[lookahead] === "]") {
        continue;
      }
    }

    output += current;
  }

  return output;
}

export function parseBunLock(input) {
  try {
    return JSON.parse(stripTrailingCommas(stripJsonComments(input)));
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.startsWith("Bun dependency input policy rejected")
    ) {
      throw error;
    }
    throw policyError(
      `bun.lock is not parseable generated text: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertNoDependencyRemapping(manifest) {
  for (const field of REMAPPING_FIELDS) {
    assert(
      !Object.hasOwn(manifest, field),
      `package.json field ${field} is not allowed in candidate builds`,
    );
  }

  if (isRecord(manifest.pnpm)) {
    for (const field of REMAPPING_FIELDS) {
      assert(
        !Object.hasOwn(manifest.pnpm, field),
        `package.json field pnpm.${field} is not allowed in candidate builds`,
      );
    }
  }
}

function assertRegistrySpecifier(
  specifier,
  location,
  { allowGeneratedWhitespace = false } = {},
) {
  assert(
    typeof specifier === "string" && specifier.length > 0,
    `${location} must be a non-empty string`,
  );
  assert(
    !/[\u0000-\u001f\u007f]/.test(specifier),
    `${location} contains control characters`,
  );
  assert(
    allowGeneratedWhitespace || specifier === specifier.trim(),
    `${location} must not contain surrounding whitespace`,
  );
  const checkedSpecifier = allowGeneratedWhitespace
    ? specifier.trim()
    : specifier;

  if (checkedSpecifier.startsWith("npm:")) {
    const alias = checkedSpecifier.slice(4);
    const separator = alias.startsWith("@")
      ? alias.indexOf("@", alias.indexOf("/") + 1)
      : alias.indexOf("@");
    assert(separator > 0, `${location} contains an invalid npm registry alias`);
    const packageName = alias.slice(0, separator);
    assert(
      PACKAGE_NAME.test(packageName),
      `${location} contains an invalid npm registry alias package`,
    );
    assertRegistrySpecifier(alias.slice(separator + 1), `${location} alias`);
    return;
  }

  assert(
    /^[0-9A-Za-z*<>=~^| ._+-]+$/.test(checkedSpecifier),
    `${location} is not a registry version, range, or tag`,
  );
  assert(
    !/^(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::|\/|$)/i.test(
      checkedSpecifier,
    ),
    `${location} names a network endpoint`,
  );
}

function dependencyMap(value, location) {
  if (value === undefined) {
    return {};
  }
  assert(isRecord(value), `${location} must be an object`);
  return value;
}

function validateDependencyMaps(owner, location, mode, sdkSha) {
  let sdkDeclarations = 0;

  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = dependencyMap(owner[field], `${location}.${field}`);
    for (const [name, specifier] of Object.entries(dependencies)) {
      assert(PACKAGE_NAME.test(name), `${location}.${field} has invalid name ${name}`);
      if (mode === "ep" && name === SDK_PACKAGE) {
        sdkDeclarations += 1;
        assert(
          specifier === `github:${SDK_REPOSITORY}#${sdkSha}`,
          `${location}.${field}.${SDK_PACKAGE} must use the expected exact SDK SHA`,
        );
      } else {
        assertRegistrySpecifier(specifier, `${location}.${field}.${name}`);
      }
    }
  }

  return sdkDeclarations;
}

function normalizedDependencyMap(owner, field) {
  const value = owner[field];
  return value === undefined ? {} : value;
}

function stableDependencyMap(owner, field) {
  return Object.fromEntries(
    Object.entries(normalizedDependencyMap(owner, field)).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function assertSameDependencyMaps(manifest, workspace) {
  for (const field of DEPENDENCY_FIELDS) {
    const packageValue = stableDependencyMap(manifest, field);
    const lockValue = stableDependencyMap(workspace, field);
    assert(
      JSON.stringify(packageValue) === JSON.stringify(lockValue),
      `bun.lock workspace ${field} does not exactly match package.json`,
    );
  }
}

function assertIntegrity(value, packageKey) {
  assert(
    typeof value === "string" &&
      /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value),
    `bun.lock package ${packageKey} is missing sha512 integrity`,
  );
  const encoded = value.slice("sha512-".length);
  const decoded = Buffer.from(encoded, "base64");
  assert(
    decoded.length === 64 && decoded.toString("base64") === encoded,
    `bun.lock package ${packageKey} has invalid sha512 integrity`,
  );
}

function validatePackageMetadata(metadata, location) {
  assert(isRecord(metadata), `${location} metadata must be an object`);
  for (const field of Object.keys(metadata)) {
    assert(
      LOCK_METADATA_FIELDS.has(field),
      `${location} metadata field ${field} is not allowed`,
    );
  }
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = dependencyMap(metadata[field], `${location}.${field}`);
    for (const [name, specifier] of Object.entries(dependencies)) {
      assert(PACKAGE_NAME.test(name), `${location}.${field} has invalid name ${name}`);
      assertRegistrySpecifier(specifier, `${location}.${field}.${name}`, {
        allowGeneratedWhitespace: true,
      });
    }
  }
}

function validateRegistryPackage(packageKey, tuple) {
  assert(
    tuple.length === 4 &&
      typeof tuple[0] === "string" &&
      tuple[1] === "" &&
      isRecord(tuple[2]),
    `bun.lock package ${packageKey} is not a registry package tuple`,
  );
  assert(
    REGISTRY_RESOLUTION.test(tuple[0]),
    `bun.lock package ${packageKey} does not resolve to an exact registry version`,
  );
  validatePackageMetadata(tuple[2], `bun.lock package ${packageKey}`);
  assertIntegrity(tuple[3], packageKey);
}

function validateSdkPackage(packageKey, tuple, sdkSha) {
  const abbreviatedSha = sdkSha.slice(0, 7);
  assert(packageKey === SDK_PACKAGE, "the SDK GitHub source has an unexpected key");
  assert(
    tuple.length === 4 &&
      tuple[0] ===
        `${SDK_PACKAGE}@github:${SDK_REPOSITORY}#${abbreviatedSha}` &&
      isRecord(tuple[1]) &&
      tuple[2] === `lvis-project-lvis-plugin-sdk-${abbreviatedSha}`,
    "bun.lock SDK package does not resolve to the expected repository and SHA prefix",
  );
  validatePackageMetadata(tuple[1], `bun.lock package ${packageKey}`);
  assertIntegrity(tuple[3], packageKey);
}

export function verifyBunDependencyInputs({
  manifest,
  lock,
  mode,
  sdkSha,
}) {
  assert(mode === "host" || mode === "ep", "mode must be host or ep");
  assert(isRecord(manifest), "package.json must contain an object");
  assert(isRecord(lock), "bun.lock must contain an object");
  if (mode === "ep") {
    assert(
      typeof sdkSha === "string" && /^[0-9a-f]{40}$/.test(sdkSha),
      "EP mode requires an exact lowercase 40-character SDK SHA",
    );
  }

  assertNoDependencyRemapping(manifest);
  const manifestSdkDeclarations = validateDependencyMaps(
    manifest,
    "package.json",
    mode,
    sdkSha,
  );
  assert(
    mode !== "ep" || manifestSdkDeclarations === 1,
    `EP package.json must declare exactly one ${SDK_PACKAGE} source`,
  );

  for (const key of Object.keys(lock)) {
    assert(
      LOCK_TOP_LEVEL_FIELDS.has(key),
      `bun.lock top-level field ${key} is not allowed`,
    );
  }
  assert(lock.lockfileVersion === 1, "bun.lock lockfileVersion must be 1");
  assert(lock.configVersion === 1, "bun.lock configVersion must be 1");
  assert(isRecord(lock.workspaces), "bun.lock workspaces must be an object");
  assert(
    Object.keys(lock.workspaces).length === 1 &&
      Object.hasOwn(lock.workspaces, ""),
    "bun.lock must describe exactly the candidate root workspace",
  );
  const workspace = lock.workspaces[""];
  assert(isRecord(workspace), "bun.lock root workspace must be an object");
  for (const field of Object.keys(workspace)) {
    assert(
      LOCK_WORKSPACE_FIELDS.has(field),
      `bun.lock root workspace field ${field} is not allowed`,
    );
  }
  assertSameDependencyMaps(manifest, workspace);
  const workspaceSdkDeclarations = validateDependencyMaps(
    workspace,
    "bun.lock.workspaces[\"\"]",
    mode,
    sdkSha,
  );
  assert(
    mode !== "ep" || workspaceSdkDeclarations === 1,
    `EP bun.lock workspace must declare exactly one ${SDK_PACKAGE} source`,
  );

  assert(isRecord(lock.packages), "bun.lock packages must be an object");
  assert(
    Object.keys(lock.packages).length > 0,
    "bun.lock packages must not be empty",
  );
  let sdkPackages = 0;
  for (const [packageKey, tuple] of Object.entries(lock.packages)) {
    assert(Array.isArray(tuple), `bun.lock package ${packageKey} must be a tuple`);
    const resolution = tuple[0];
    if (
      mode === "ep" &&
      packageKey === SDK_PACKAGE &&
      typeof resolution === "string" &&
      resolution.includes("@github:")
    ) {
      sdkPackages += 1;
      validateSdkPackage(packageKey, tuple, sdkSha);
    } else {
      validateRegistryPackage(packageKey, tuple);
    }
  }
  assert(
    mode !== "ep" || sdkPackages === 1,
    `EP bun.lock must contain exactly one ${SDK_PACKAGE} GitHub package`,
  );

  return {
    mode,
    packages: Object.keys(lock.packages).length,
    sdkSha: mode === "ep" ? sdkSha : undefined,
  };
}

export function verifyBunDependencyInputFiles({
  packagePath,
  lockPath,
  mode,
  sdkSha,
}) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(packagePath, "utf8"));
  } catch (error) {
    throw policyError(
      `package.json is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const lock = parseBunLock(readFileSync(lockPath, "utf8"));
  return verifyBunDependencyInputs({ manifest, lock, mode, sdkSha });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    assert(
      typeof flag === "string" &&
        flag.startsWith("--") &&
        typeof value === "string",
      "arguments must be --name value pairs",
    );
    const name = flag.slice(2);
    assert(
      ["lock", "mode", "package", "sdk-sha"].includes(name),
      `unknown argument ${flag}`,
    );
    assert(!Object.hasOwn(options, name), `duplicate argument ${flag}`);
    options[name] = value;
  }
  assert(options.package, "--package is required");
  assert(options.lock, "--lock is required");
  assert(options.mode, "--mode is required");
  return options;
}

function main(argv) {
  const options = parseArguments(argv);
  const result = verifyBunDependencyInputFiles({
    packagePath: resolve(options.package),
    lockPath: resolve(options.lock),
    mode: options.mode,
    sdkSha: options["sdk-sha"],
  });
  process.stdout.write(
    `verified ${result.mode} Bun dependency inputs (${result.packages} locked packages)\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
