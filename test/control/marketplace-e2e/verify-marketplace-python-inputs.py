#!/usr/bin/env python3
"""Reject Marketplace dependency inputs that could execute candidate build code."""

import re
import sys
import tomllib
from pathlib import Path
from urllib.parse import urlsplit


def reject(message):
    raise ValueError(message)


def load(path, label):
    try:
        return tomllib.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise ValueError(f"{label} is not readable valid TOML") from error


def nonempty_string(value, label):
    if not isinstance(value, str) or not value.strip():
        reject(f"{label} must be a non-empty string")
    return value


def pypi_registry(value, label):
    url = nonempty_string(value, label)
    if url != "https://pypi.org/simple":
        reject(f"{label} must be exactly https://pypi.org/simple")


def pythonhosted_artifact(value, label, suffix=None):
    url = nonempty_string(value, label)
    parsed = urlsplit(url)
    try:
        port = parsed.port
    except ValueError:
        reject(f"{label} has an invalid port")
    if (
        parsed.scheme != "https"
        or parsed.hostname != "files.pythonhosted.org"
        or parsed.username
        or parsed.password
        or port is not None
        or parsed.query
        or parsed.fragment
    ):
        reject(f"{label} must use the exact files.pythonhosted.org HTTPS origin")
    if suffix and not parsed.path.lower().endswith(suffix):
        reject(f"{label} must end with {suffix}")


def reject_direct_sources(value, label):
    if isinstance(value, dict):
        for key, nested in value.items():
            reject_direct_sources(nested, f"{label}.{key}")
    elif isinstance(value, list):
        for index, nested in enumerate(value):
            reject_direct_sources(nested, f"{label}[{index}]")
    elif isinstance(value, str):
        lowered = value.strip().lower()
        if (
            re.search(
                r"(?:https?://|git\+|git@|github:|gitlab:|bitbucket:|file:|link:|workspace:)",
                lowered,
            )
            or lowered.startswith(("/", "./", "../", "~/"))
        ):
            reject(f"{label} contains a forbidden direct source")


def dependency_lists(pyproject):
    project = pyproject["project"]
    result = [("project.dependencies", project.get("dependencies", []))]
    optional = project.get("optional-dependencies", {})
    groups = pyproject.get("dependency-groups", {})
    build_system = pyproject.get("build-system", {})
    tool = pyproject.get("tool", {})
    if not isinstance(tool, dict):
        reject("tool must be a table")
    tool_uv = tool.get("uv", {})
    if not all(isinstance(value, dict) for value in (optional, groups, build_system, tool_uv)):
        reject("dependency metadata tables are malformed")
    result.extend((f"project.optional-dependencies.{name}", value) for name, value in optional.items())
    result.extend((f"dependency-groups.{name}", value) for name, value in groups.items())
    result.append(("build-system.requires", build_system.get("requires", [])))
    result.append(("tool.uv.dev-dependencies", tool_uv.get("dev-dependencies", [])))
    return result, tool_uv


def validate_pyproject(pyproject):
    project = pyproject.get("project")
    if not isinstance(project, dict):
        reject("pyproject [project] must be a table")
    root_name = re.sub(r"[-_.]+", "-", nonempty_string(project.get("name"), "project.name")).lower()
    lists, tool_uv = dependency_lists(pyproject)
    if "sources" in tool_uv:
        reject("tool.uv.sources is forbidden")
    if "workspace" in tool_uv:
        reject("tool.uv.workspace is forbidden")
    unexpected_uv_keys = set(tool_uv).difference({"dev-dependencies"})
    if unexpected_uv_keys:
        reject(f"tool.uv configuration is forbidden: {sorted(unexpected_uv_keys)[0]}")
    dynamic = project.get("dynamic", [])
    if (
        not isinstance(dynamic, list)
        or not all(isinstance(value, str) for value in dynamic)
        or {"dependencies", "optional-dependencies"}.intersection(dynamic)
    ):
        reject("dynamic dependency metadata is forbidden")
    for label, requirements in lists:
        if not isinstance(requirements, list):
            reject(f"{label} must be an array")
        for index, requirement in enumerate(requirements):
            if isinstance(requirement, dict) and set(requirement) == {"include-group"}:
                nonempty_string(requirement["include-group"], f"{label}[{index}].include-group")
                continue
            value = nonempty_string(requirement, f"{label}[{index}]").strip()
            if re.search(r"\s*@\s*", value) or value.lower().startswith(
                ("git+", "http:", "https:", "file:", "/", "./", "../")
            ):
                reject(f"{label}[{index}] must use an index requirement")
    return root_name


def validate_lock(lock, root_name):
    allowed_lock_keys = {"version", "revision", "requires-python", "package"}
    unexpected_lock_keys = set(lock).difference(allowed_lock_keys)
    if unexpected_lock_keys:
        reject(f"uv.lock top-level key is forbidden: {sorted(unexpected_lock_keys)[0]}")
    packages = lock.get("package")
    if not isinstance(packages, list) or not packages:
        reject("uv.lock package list must be non-empty")
    root_count = 0
    wheel_count = 0
    for index, package in enumerate(packages):
        label = f"uv.lock package[{index}]"
        if not isinstance(package, dict):
            reject(f"{label} must be a table")
        name = re.sub(
            r"[-_.]+", "-", nonempty_string(package.get("name"), f"{label}.name")
        ).lower()
        source = package.get("source")
        if source == {"editable": "."}:
            if name != root_name:
                reject(f"{label} non-root editable source is forbidden")
            allowed_root_keys = {
                "name",
                "version",
                "source",
                "dependencies",
                "dev-dependencies",
                "metadata",
            }
            unexpected_root_keys = set(package).difference(allowed_root_keys)
            if unexpected_root_keys:
                reject(f"{label} root field is forbidden: {sorted(unexpected_root_keys)[0]}")
            reject_direct_sources(
                {key: value for key, value in package.items() if key != "source"},
                label,
            )
            root_count += 1
            continue
        if not isinstance(source, dict) or set(source) != {"registry"}:
            reject(f"{label} path, editable, VCS, and direct URL sources are forbidden")
        pypi_registry(source["registry"], f"{label}.source.registry")
        wheels = package.get("wheels")
        if not isinstance(wheels, list) or not wheels:
            reject(f"{label} must provide at least one pre-built wheel")
        for wheel_index, wheel in enumerate(wheels):
            wheel_label = f"{label}.wheels[{wheel_index}]"
            if not isinstance(wheel, dict):
                reject(f"{wheel_label} must be a table")
            pythonhosted_artifact(wheel.get("url"), f"{wheel_label}.url", ".whl")
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(wheel.get("hash", ""))):
                reject(f"{wheel_label}.hash must be a lowercase sha256 digest")
            wheel_count += 1
        sdist = package.get("sdist")
        if sdist is not None:
            if not isinstance(sdist, dict):
                reject(f"{label}.sdist must be a table")
            pythonhosted_artifact(sdist.get("url"), f"{label}.sdist.url")
            if not re.fullmatch(r"sha256:[0-9a-f]{64}", str(sdist.get("hash", ""))):
                reject(f"{label}.sdist.hash must be a lowercase sha256 digest")
        reject_direct_sources(
            {
                key: value
                for key, value in package.items()
                if key not in {"source", "wheels", "sdist"}
            },
            label,
        )
    if root_count != 1:
        reject("uv.lock must contain exactly one editable '.' root project")
    return len(packages), wheel_count


def main():
    if len(sys.argv) != 3:
        reject("expected <pyproject.toml> <uv.lock>")
    pyproject = load(sys.argv[1], "pyproject.toml")
    lock = load(sys.argv[2], "uv.lock")
    root_name = validate_pyproject(pyproject)
    package_count, wheel_count = validate_lock(lock, root_name)
    print(
        f"marketplace dependency policy accepted root={root_name} "
        f"packages={package_count} wheels={wheel_count}"
    )


try:
    main()
except ValueError as error:
    sys.stderr.write(f"marketplace dependency policy rejected inputs: {error}\n")
    raise SystemExit(1) from error
