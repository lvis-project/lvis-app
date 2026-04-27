#!/usr/bin/env python3
"""
Migrate 33 test files from ~/.lvis/test-tmp to os.tmpdir().

Handles these patterns:
A. mkdtempSync(join(homedir(), ".lvis", "test-tmp", "prefix-"))
   → mkdtempSync(join(tmpdir(), "prefix-"))

B. testDir = join(homedir(), ".lvis", "test-tmp", `prefix-${Date.now()}-...`)
   followed by: await mkdir(testDir, { recursive: true })
   → testDir = mkdtempSync(join(tmpdir(), "prefix-"))
   (remove the mkdir line since mkdtempSync creates the dir)

C. const root = join(homedir(), ".lvis", "test-tmp");
   return mkdtempSync(join(root, "prefix-"));
   → const root = tmpdir();   (or inline it)

D. const root = join(homedir(), ".lvis", "test-tmp");
   return mkdtempSync(join(root, "prefix-"));
   → direct replacement

E. mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
   → remove this line (tmpdir always exists)

F. telemetry-client: deviceUuidPath: join(homedir(), ".lvis", "test-tmp", `lvis-test-uuid-${...}`)
   → deviceUuidPath: join(tmpdir(), `lvis-test-uuid-${...}`)

G. audit files: testHome = join(homedir(), ".lvis", "test-tmp", `prefix-${...}`)
   → testHome = mkdtempSync(join(tmpdir(), "prefix-"))
   (these then do: mkdirSync(auditDir, {recursive:true}) and vi.mocked(homedir).mockReturnValue(testHome))
"""

import re
import os
import sys

WORKTREE = "/c/Users/ikcha/workspace/lvis-project/_test-hygiene"

files = [
    "src/audit/__tests__/audit-rotation.test.ts",
    "src/audit/__tests__/audit-search.test.ts",
    "src/boot/__tests__/capability-audit-trail.test.ts",
    "src/boot/__tests__/event-hints.test.ts",
    "src/boot/__tests__/phase5-event-namespace.test.ts",
    "src/data/__tests__/settings-store.test.ts",
    "src/engine/__tests__/conversation-trace.test.ts",
    "src/engine/__tests__/usage-stats.test.ts",
    "src/hooks/__tests__/config-loader.test.ts",
    "src/lib/__tests__/with-file-lock.test.ts",
    "src/main/__tests__/release-prep.test.ts",
    "src/mcp/__tests__/mcp-marketplace-install.test.ts",
    "src/memory/__tests__/search.test.ts",
    "src/plugins/__tests__/deployment-guard.test.ts",
    "src/plugins/__tests__/destructive-uicallable-guard.test.ts",
    "src/plugins/__tests__/entry-path-guard.test.ts",
    "src/plugins/__tests__/marketplace-dependency-guard.test.ts",
    "src/plugins/__tests__/marketplace-guard.test.ts",
    "src/plugins/__tests__/marketplace-installer.test.ts",
    "src/plugins/__tests__/offline-cache.test.ts",
    "src/plugins/__tests__/phase5-validation.test.ts",
    "src/plugins/__tests__/plugin-artifact-store.test.ts",
    "src/plugins/__tests__/plugin-cards.test.ts",
    "src/plugins/__tests__/reload.test.ts",
    "src/plugins/__tests__/rollback.test.ts",
    "src/plugins/__tests__/runtime-config-overrides.test.ts",
    "src/plugins/__tests__/runtime.test.ts",
    "src/plugins/__tests__/signature-verifier.test.ts",
    "src/plugins/__tests__/sprint4b-ajv-guards.test.ts",
    "src/plugins/__tests__/sprint4b-signature-enforcement.test.ts",
    "src/plugins/__tests__/update-detector.test.ts",
    "src/sandbox/__tests__/path-validator.test.ts",
    "src/__tests__/telemetry-client.test.ts",
]


def add_tmpdir_to_import(content: str) -> str:
    """Add tmpdir to the node:os import, add import if needed."""
    # Check if homedir is imported from node:os
    # Pattern: import { ..., homedir, ... } from "node:os"
    os_import_re = re.compile(r'(import\s*\{([^}]+)\}\s*from\s*"node:os")', re.MULTILINE)
    match = os_import_re.search(content)
    if match:
        imports_str = match.group(2)
        # Parse individual imports
        imports = [x.strip() for x in imports_str.split(',') if x.strip()]
        if 'tmpdir' not in imports:
            imports.append('tmpdir')
            imports.sort()
            new_imports = ', '.join(imports)
            new_import_line = f'import {{ {new_imports} }} from "node:os"'
            content = content.replace(match.group(0), new_import_line, 1)
    else:
        # No node:os import exists, add one after the last import line
        # Find position to insert
        lines = content.split('\n')
        last_import_idx = -1
        for i, line in enumerate(lines):
            if re.match(r'\s*import\s', line):
                last_import_idx = i
        if last_import_idx >= 0:
            lines.insert(last_import_idx + 1, 'import { tmpdir } from "node:os";')
            content = '\n'.join(lines)
        else:
            content = 'import { tmpdir } from "node:os";\n' + content
    return content


def remove_homedir_if_unused(content: str) -> str:
    """Remove homedir from imports if it's no longer used in the file (outside imports)."""
    os_import_re = re.compile(r'(import\s*\{([^}]+)\}\s*from\s*"node:os")', re.MULTILINE)
    match = os_import_re.search(content)
    if not match:
        return content

    imports_str = match.group(2)
    imports = [x.strip() for x in imports_str.split(',') if x.strip()]

    if 'homedir' not in imports:
        return content

    # Check if homedir is used outside the import line
    # Remove the import statement temporarily to check usage
    content_without_import = content.replace(match.group(0), '', 1)

    # Check for homedir usage (as function call or reference)
    if re.search(r'\bhomedir\b', content_without_import):
        return content  # still used, keep it

    # Remove homedir from imports
    imports.remove('homedir')
    if imports:
        new_imports = ', '.join(imports)
        new_import_line = f'import {{ {new_imports} }} from "node:os"'
        content = content.replace(match.group(0), new_import_line, 1)
    else:
        # Remove entire import line
        content = content.replace(match.group(0), '', 1)
        content = re.sub(r'\n\n+', '\n\n', content)
    return content


def ensure_mkdtempSync_import(content: str) -> str:
    """Ensure mkdtempSync is imported from node:fs."""
    fs_import_re = re.compile(r'(import\s*\{([^}]+)\}\s*from\s*"node:fs")', re.MULTILINE)
    match = fs_import_re.search(content)
    if match:
        imports_str = match.group(2)
        imports = [x.strip() for x in imports_str.split(',') if x.strip()]
        if 'mkdtempSync' not in imports:
            imports.append('mkdtempSync')
            imports.sort()
            new_imports = ', '.join(imports)
            new_import_line = f'import {{ {new_imports} }} from "node:fs"'
            content = content.replace(match.group(0), new_import_line, 1)
    else:
        # No node:fs import, add one
        lines = content.split('\n')
        last_import_idx = -1
        for i, line in enumerate(lines):
            if re.match(r'\s*import\s', line):
                last_import_idx = i
        if last_import_idx >= 0:
            lines.insert(last_import_idx + 1, 'import { mkdtempSync } from "node:fs";')
            content = '\n'.join(lines)
        else:
            content = 'import { mkdtempSync } from "node:fs";\n' + content
    return content


def migrate_file(filepath: str) -> tuple[str, list[str]]:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    original = content
    changes = []

    # ── Step 1: Replace mkdtempSync(join(homedir(), ".lvis", "test-tmp", "prefix-"))
    # with mkdtempSync(join(tmpdir(), "prefix-"))
    pattern_mkdtemp = re.compile(
        r'mkdtempSync\(join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*("([^"]+)")\)\)',
    )
    if pattern_mkdtemp.search(content):
        content = pattern_mkdtemp.sub(
            lambda m: f'mkdtempSync(join(tmpdir(), {m.group(1)}))',
            content
        )
        changes.append("Pattern A: mkdtempSync with string prefix")

    # ── Step 2: Replace root = join(homedir(), ".lvis", "test-tmp") followed by mkdtempSync(join(root, ...))
    # First handle: const root = join(homedir(), ".lvis", "test-tmp");
    pattern_root_const = re.compile(
        r'(const\s+root\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"\);'
    )
    if pattern_root_const.search(content):
        content = pattern_root_const.sub(r'\1tmpdir();', content)
        changes.append("Pattern C: const root = join(homedir(), .lvis, test-tmp)")

    # ── Step 3: Handle dynamic join patterns (with Date.now() or randomBytes etc.)
    # These appear as: join(homedir(), ".lvis", "test-tmp", `prefix-${...}`)
    # For audit files: testHome = join(homedir(), ".lvis", "test-tmp", `lvis-audit-rot-${...}`)
    # → testHome = mkdtempSync(join(tmpdir(), "lvis-audit-rot-"))

    # Match: (var) = join(homedir(), ".lvis", "test-tmp", `prefix-${...}`)
    pattern_dynamic = re.compile(
        r'((?:testHome|testDir|tmpDir)\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*`([^`$]+)\$\{[^`]+\}`\);'
    )
    def replace_dynamic(m):
        var_assign = m.group(1)
        prefix = m.group(2)
        changes.append(f"Pattern B/G: dynamic join → mkdtempSync prefix={prefix}")
        return f'{var_assign}mkdtempSync(join(tmpdir(), "{prefix}"));'

    if pattern_dynamic.search(content):
        content = pattern_dynamic.sub(replace_dynamic, content)

    # ── Step 4: Remove mkdirSync(join(homedir(), ".lvis", "test-tmp"), { recursive: true });
    pattern_mkdir_redundant = re.compile(
        r'\s*mkdirSync\(join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"\),\s*\{[^}]+\}\);\n?'
    )
    if pattern_mkdir_redundant.search(content):
        content = pattern_mkdir_redundant.sub('\n', content)
        changes.append("Pattern E: removed redundant mkdirSync")

    # ── Step 5: Remove "await mkdir(testDir/tmpDir, { recursive: true })" lines
    # that directly follow the mkdtempSync assignment (mkdtempSync creates the dir)
    # Only remove the first mkdir that creates the testDir itself (not subdirs)
    # We look for: await mkdir(testDir, { recursive: true }); on its own line
    # after we've replaced testDir with mkdtempSync
    # Be conservative: only remove if the line is EXACTLY `await mkdir(<var>, { recursive: true });`
    # where <var> is the same variable we just migrated
    for var_name in ['testDir', 'tmpDir', 'testHome']:
        # Pattern: await mkdir(testDir, { recursive: true });
        pattern_mkdir_async = re.compile(
            r'[ \t]*await mkdir\(' + re.escape(var_name) + r',\s*\{\s*recursive:\s*true\s*\}\);\n'
        )
        if pattern_mkdir_async.search(content):
            # Only remove if this var was migrated to mkdtempSync (which creates the dir)
            # Check if the var is now assigned via mkdtempSync
            if re.search(var_name + r'\s*=\s*mkdtempSync\(', content):
                content = pattern_mkdir_async.sub('', content)
                changes.append(f"Removed await mkdir({var_name}) — mkdtempSync creates it")

    # ── Step 6: Handle marketplace-dependency-guard special:
    # tmpDir = join(homedir(), ".lvis", "test-tmp", `lvis-test-${randomBytes(8).toString("hex")}`);
    # (same pattern B but with randomBytes expression)
    pattern_dynamic2 = re.compile(
        r'((?:testHome|testDir|tmpDir)\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*`([^`$]+)\$\{[^`]+\}`\);'
    )
    # Already handled above (same regex)

    # ── Step 7: Handle const root = join(homedir(), ".lvis", "test-tmp", "plugins", "sample")
    # (entry-path-guard line 152)
    pattern_root_with_suffix = re.compile(
        r'(const\s+root\s*=\s*)join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*("(?:[^"]+)"(?:,\s*"[^"]*")*)\);'
    )
    if pattern_root_with_suffix.search(content):
        content = pattern_root_with_suffix.sub(
            lambda m: f'{m.group(1)}join(tmpdir(), {m.group(2)});',
            content
        )
        changes.append("Pattern D: const root with suffix path segments")

    # ── Step 8: Handle telemetry: join(homedir(), ".lvis", "test-tmp", `lvis-test-uuid-${...}`)
    # as a property value (not assignment to a variable name we can predict)
    pattern_prop_dynamic = re.compile(
        r'join\(homedir\(\),\s*"\.lvis",\s*"test-tmp",\s*(`[^`]+`)\)'
    )
    if pattern_prop_dynamic.search(content):
        content = pattern_prop_dynamic.sub(
            lambda m: f'join(tmpdir(), {m.group(1)})',
            content
        )
        changes.append("Pattern F: property dynamic join")

    # ── Step 9: Catch-all: any remaining join(homedir(), ".lvis", "test-tmp", ...)
    # This handles any edge cases
    remaining = re.compile(r'join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"').search(content)
    if remaining:
        changes.append(f"WARNING: Remaining pattern at position {remaining.start()}")

    # ── Now fix imports ──────────────────────────────────────────────────────────
    if content != original:
        content = add_tmpdir_to_import(content)
        content = remove_homedir_if_unused(content)
        # If we added mkdtempSync calls, ensure it's imported
        if 'mkdtempSync(' in content and 'mkdtempSync' not in original.split('from "node:fs"')[0] + 'node:fs':
            # Check if mkdtempSync is actually in the imports
            if not re.search(r'import\s*\{[^}]*mkdtempSync[^}]*\}\s*from\s*"node:fs"', content):
                content = ensure_mkdtempSync_import(content)
                changes.append("Added mkdtempSync to node:fs import")

    return content, changes


def main():
    total_changes = 0
    for rel_path in files:
        full_path = os.path.join(WORKTREE, rel_path)
        if not os.path.exists(full_path):
            print(f"MISSING: {rel_path}")
            continue

        new_content, changes = migrate_file(full_path)

        # Check for remaining patterns
        with open(full_path, 'r', encoding='utf-8') as f:
            original = f.read()

        if new_content != original:
            with open(full_path, 'w', encoding='utf-8') as f:
                f.write(new_content)
            total_changes += 1
            print(f"CHANGED: {rel_path}")
            for c in changes:
                print(f"  - {c}")
        else:
            print(f"NO CHANGE: {rel_path}")

        # Check for remaining issues
        remaining = re.search(r'join\(homedir\(\),\s*"\.lvis",\s*"test-tmp"', new_content)
        if remaining:
            line_num = new_content[:remaining.start()].count('\n') + 1
            print(f"  !! REMAINING PATTERN at line {line_num}: {new_content[remaining.start():remaining.start()+80]}")

    print(f"\nTotal files changed: {total_changes}")


if __name__ == '__main__':
    main()
