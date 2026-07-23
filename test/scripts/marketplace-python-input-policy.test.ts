import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const verifier = resolve(
  "test/control/marketplace-e2e/verify-marketplace-python-inputs.py",
);
const fixtureDirectories: string[] = [];

const validPyproject = `
[project]
name = "fixture"
version = "1.0.0"
dependencies = ["remote-wheel==1.0.0"]

[dependency-groups]
dev = ["pytest==8.3.0"]

[build-system]
requires = ["hatchling==1.27.0"]
build-backend = "hatchling.build"
`;

const registryPackage = `
[[package]]
name = "remote-wheel"
version = "1.0.0"
source = { registry = "https://pypi.org/simple" }
sdist = { url = "https://files.pythonhosted.org/remote-wheel-1.0.0.tar.gz", hash = "sha256:${"1".repeat(64)}" }
wheels = [
  { url = "https://files.pythonhosted.org/remote_wheel-1.0.0-py3-none-any.whl", hash = "sha256:${"2".repeat(64)}" },
]
`;

const validLock = `
version = 1
revision = 3
requires-python = ">=3.12"

[[package]]
name = "fixture"
version = "1.0.0"
source = { editable = "." }

${registryPackage}
`;

function verify(
  pyproject = validPyproject,
  lock = validLock,
): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(join(tmpdir(), "marketplace-python-policy-"));
  fixtureDirectories.push(directory);
  const pyprojectPath = join(directory, "pyproject.toml");
  const lockPath = join(directory, "uv.lock");
  writeFileSync(pyprojectPath, pyproject, "utf8");
  writeFileSync(lockPath, lock, "utf8");
  return spawnSync("python3", [verifier, pyprojectPath, lockPath], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const directory of fixtureDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("Marketplace Python dependency input policy", () => {
  it("accepts an inert editable root and hashed remote registry wheels", () => {
    const result = verify();

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "root=fixture packages=2 wheels=1",
    );
  });

  it.each([
    'evil = { git = "https://example.invalid/evil.git" }',
    'evil = { path = "../evil" }',
    'evil = { url = "https://example.invalid/evil.whl" }',
    'evil = { workspace = true }',
  ])("rejects tool.uv.sources entries: %s", (source) => {
    const result = verify(`${validPyproject}\n[tool.uv.sources]\n${source}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tool.uv.sources is forbidden");
  });

  it.each([
    'index = [{ url = "https://169.254.169.254/simple" }]',
    'default-index = "https://10.0.0.1/simple"',
    'extra-index-url = ["https://192.168.1.1/simple"]',
    'find-links = ["http://127.0.0.1:8000/"]',
  ])("rejects custom uv network configuration: %s", (configuration) => {
    const result = verify(`${validPyproject}\n[tool.uv]\n${configuration}\n`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tool.uv configuration is forbidden");
  });

  it.each([
    "evil @ git+https://example.invalid/evil.git",
    "evil @ file:///tmp/evil",
    "evil @ ../evil",
    "evil @ http://127.0.0.1:8000/evil.whl",
    "evil @ https://10.0.0.1/evil.whl",
    "evil @ https://172.17.0.1/evil.whl",
    "evil @ https://192.168.1.1/evil.whl",
    "evil @ http://169.254.169.254/latest/meta-data",
    "evil @ https://example.invalid/redirect",
    "evil @ https://example.invalid/evil-1.0.0-py3-none-any.whl",
  ])("rejects direct project requirements: %s", (requirement) => {
    const pyproject = validPyproject.replace(
      '"remote-wheel==1.0.0"',
      JSON.stringify(requirement),
    );
    const result = verify(pyproject);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must use an index requirement");
  });

  it.each([
    '{ git = "https://example.invalid/evil.git" }',
    '{ path = "../evil" }',
    '{ editable = "../evil" }',
    '{ url = "https://example.invalid/evil-1.0.0-py3-none-any.whl" }',
    '{ url = "https://example.invalid/evil-1.0.0.tar.gz" }',
  ])("rejects non-registry dependency lock sources: %s", (source) => {
    const lock = validLock.replace(
      '{ registry = "https://pypi.org/simple" }',
      source,
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("direct URL sources are forbidden");
  });

  it("rejects non-root editable lock sources", () => {
    const lock = validLock.replace(
      '{ registry = "https://pypi.org/simple" }',
      '{ editable = "." }',
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("non-root editable source is forbidden");
  });

  it("rejects unexpected network-capable fields on the skipped editable root", () => {
    const lock = validLock.replace(
      'source = { editable = "." }',
      `source = { editable = "." }
sdist = { url = "https://files.pythonhosted.org/root.tar.gz", hash = "sha256:${"3".repeat(64)}" }`,
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("root field is forbidden: sdist");
  });

  it.each([
    "http://127.0.0.1:8000/metadata",
    "https://10.0.0.1/metadata",
    "https://169.254.169.254/latest/meta-data",
    "git+https://example.invalid/evil.git",
    "file:///tmp/evil",
    "../evil",
  ])("rejects direct sources hidden in lock metadata: %s", (url) => {
    const lock = `${validLock}
[package.metadata]
requires-dist = [{ name = "evil", url = ${JSON.stringify(url)} }]
`;
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("contains a forbidden direct source");
  });

  it("rejects unknown lock top-level policy inputs", () => {
    const lock = validLock.replace(
      "requires-python = \">=3.12\"",
      'requires-python = ">=3.12"\nindex-url = "https://example.invalid/simple"',
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("uv.lock top-level key is forbidden: index-url");
  });

  it.each([
    "http://pypi.org/simple",
    "https://example.invalid/simple",
    "https://127.0.0.1/simple",
    "https://10.0.0.1/simple",
    "https://172.17.0.1/simple",
    "https://192.168.1.1/simple",
    "https://169.254.169.254/simple",
    "https://user:password@pypi.org/simple",
    "https://pypi.org:443/simple",
    "https://pypi.org/simple?redirect=https://example.invalid",
    "https://pypi.org/simple#fragment",
  ])("rejects non-canonical registry origins: %s", (registry) => {
    const lock = validLock.replace("https://pypi.org/simple", registry);
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "must be exactly https://pypi.org/simple",
    );
  });

  it("rejects registry dependencies that provide only an sdist", () => {
    const lock = validLock.replace(
      /wheels = \[[\s\S]*?\]\n/u,
      "",
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("must provide at least one pre-built wheel");
  });

  it.each([
    ["wheel", "", `sha256:${"1".repeat(64)}`, "wheels[0].hash"],
    ["sdist", `sha256:${"2".repeat(64)}`, "", "sdist.hash"],
  ])("rejects a missing %s sha256 hash", (_kind, wheelHash, sdistHash, label) => {
    const lock = validLock
      .replace(`sha256:${"2".repeat(64)}`, wheelHash)
      .replace(`sha256:${"1".repeat(64)}`, sdistHash);
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(label);
  });

  it.each([
    "http://files.pythonhosted.org/remote_wheel-1.0.0-py3-none-any.whl",
    "https://example.invalid/remote_wheel-1.0.0-py3-none-any.whl",
    "https://127.0.0.1/remote_wheel-1.0.0-py3-none-any.whl",
    "https://10.0.0.1/remote_wheel-1.0.0-py3-none-any.whl",
    "https://172.17.0.1/remote_wheel-1.0.0-py3-none-any.whl",
    "https://192.168.1.1/remote_wheel-1.0.0-py3-none-any.whl",
    "https://169.254.169.254/remote_wheel-1.0.0-py3-none-any.whl",
    "https://user:password@files.pythonhosted.org/remote_wheel-1.0.0-py3-none-any.whl",
    "https://files.pythonhosted.org:443/remote_wheel-1.0.0-py3-none-any.whl",
    "https://files.pythonhosted.org/remote_wheel-1.0.0-py3-none-any.whl?redirect=1",
    "https://files.pythonhosted.org/remote_wheel-1.0.0-py3-none-any.whl#fragment",
    "https://files.pythonhosted.org/remote_wheel-1.0.0.tar.gz",
  ])("rejects unsafe wheel URLs: %s", (url) => {
    const lock = validLock.replace(
      "https://files.pythonhosted.org/remote_wheel-1.0.0-py3-none-any.whl",
      url,
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("wheels[0].url");
  });

  it.each([
    "http://files.pythonhosted.org/remote-wheel-1.0.0.tar.gz",
    "https://example.invalid/remote-wheel-1.0.0.tar.gz",
    "https://127.0.0.1/remote-wheel-1.0.0.tar.gz",
    "https://10.0.0.1/remote-wheel-1.0.0.tar.gz",
    "https://172.17.0.1/remote-wheel-1.0.0.tar.gz",
    "https://192.168.1.1/remote-wheel-1.0.0.tar.gz",
    "https://169.254.169.254/remote-wheel-1.0.0.tar.gz",
    "https://files.pythonhosted.org:443/remote-wheel-1.0.0.tar.gz",
    "https://files.pythonhosted.org/remote-wheel-1.0.0.tar.gz?redirect=1",
  ])("rejects unsafe sdist metadata URLs: %s", (url) => {
    const lock = validLock.replace(
      "https://files.pythonhosted.org/remote-wheel-1.0.0.tar.gz",
      url,
    );
    const result = verify(validPyproject, lock);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("sdist.url");
  });
});
