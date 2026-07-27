import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_DIRECTORIES = 1_000;
const MAX_FILES = 1_000;
const MAX_DEPTH = 32;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

function usage() {
  throw new Error("usage: node scripts/sanitize-candidate-diagnostics.mjs <input-dir> <output-dir>");
}

function destinationPath(outputRoot, relativePath) {
  const destination = resolve(outputRoot, relativePath);
  const fromRoot = relative(outputRoot, destination);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error("candidate diagnostic path escapes the output root");
  }
  return destination;
}

export function sanitizeCandidateDiagnostics(inputArgument, outputArgument) {
  if (!inputArgument || !outputArgument) usage();

  const inputRoot = resolve(inputArgument);
  const outputRoot = resolve(outputArgument);
  if (inputRoot === outputRoot) {
    throw new Error("candidate diagnostic input and output must differ");
  }
  if (existsSync(outputRoot)) {
    throw new Error("candidate diagnostic output must not already exist");
  }

  let directoryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;

  function copyEntry(inputPath, relativePath, depth) {
    if (depth > MAX_DEPTH) {
      throw new Error("candidate diagnostic tree exceeds the maximum depth");
    }

    const stat = lstatSync(inputPath);
    if (stat.isSymbolicLink()) {
      throw new Error("candidate diagnostics must not contain symbolic links");
    }

    const outputPath = destinationPath(outputRoot, relativePath);
    if (stat.isDirectory()) {
      directoryCount += 1;
      if (directoryCount > MAX_DIRECTORIES) {
        throw new Error("candidate diagnostic tree contains too many directories");
      }
      mkdirSync(outputPath, { recursive: true, mode: 0o700 });
      for (const childName of readdirSync(inputPath).sort()) {
        copyEntry(
          resolve(inputPath, childName),
          relativePath === "" ? childName : `${relativePath}/${childName}`,
          depth + 1,
        );
      }
      return;
    }

    if (!stat.isFile()) {
      throw new Error("candidate diagnostics must contain only regular files and directories");
    }
    if (stat.nlink > 1) {
      throw new Error("candidate diagnostics must not contain hard-linked files");
    }
    fileCount += 1;
    if (fileCount > MAX_FILES) {
      throw new Error("candidate diagnostics contains too many files");
    }
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error("candidate diagnostic file exceeds the size limit");
    }
    totalBytes += stat.size;
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error("candidate diagnostics exceeds the total size limit");
    }

    mkdirSync(dirname(outputPath), { recursive: true, mode: 0o700 });
    copyFileSync(inputPath, outputPath);
  }

  copyEntry(inputRoot, "", 0);
  return { directories: directoryCount, files: fileCount, bytes: totalBytes };
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [inputArgument, outputArgument] = process.argv.slice(2);
  try {
    const result = sanitizeCandidateDiagnostics(inputArgument, outputArgument);
    process.stdout.write(
      `Sanitized candidate diagnostics: directories=${result.directories} files=${result.files} bytes=${result.bytes}\n`,
    );
  } catch (error) {
    process.stderr.write(`Candidate diagnostics rejected: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
