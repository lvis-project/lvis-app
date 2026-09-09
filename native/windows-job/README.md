# Windows background process ownership

`launcher.cpp` owns an unnamed kill-on-close Job Object. The command joins the
job atomically during creation, receives ordinary stdout/stderr pipes and NUL
stdin, and inherits the caller's prepared environment and working directory.
The helper's stdin is a private owner-lifetime pipe. Closing it or terminating
the helper kills the job. The job handle is non-inheritable. Root command exit also closes the job and returns the
root exit code. Descendants cannot opt out of job inheritance through the job's
breakaway flags. This is lifecycle ownership, not an OS security sandbox.
Guest Linux processes are outside this Windows job. The Bash tool rejects
background mode for a WSL-backed interpreter before starting the command;
distribution-wide termination would also affect unrelated work.

Call `spawnWindowsJobProcess` with an absolute executable path already selected
by the shell resolver. Keep its stdin open until disposal; never expose that pipe
as command input. The helper forwards the original command-line tail without
re-quoting. Internal launch failures print a diagnostic and exit 125; owner EOF
exits 130. A command can itself return those codes, so use the diagnostic to
identify launcher failures rather than interpreting the code alone.

For local Windows development, run `bun run build:windows-job` before executing
background commands. Building requires installed C++ build tools and a Windows
SDK; the build script downloads nothing. `-Arch arm64` supports the corresponding
installed cross tools. Installer `beforePack` always rebuilds the matching
architecture and packages only its executable outside ASAR. Missing assets fail
clearly at launch. No process-tree fallback is available. Windows 10 or newer is required for atomic
job assignment; unsupported APIs fail the launch. If root exit and owner EOF are
both observed, root exit takes precedence. Returned PID and process events belong
to the helper, and `kill()` terminates the entire job.

Native verification from the repository root:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/build-windows-job.ps1 -FailureFixture
node scripts/test-windows-job.mjs
```

The failure fixture is a separate executable compiled with an invalid job handle;
it is never packaged. Tests launch only owned synthetic processes, check their
actual OS lifetime after disposal, and exercise the installed Bash executable.
The Windows CI job runs this gate. Performance output reports median command
latency and helper working set as observations, without a machine-specific budget.
