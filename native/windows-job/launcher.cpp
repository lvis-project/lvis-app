#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <cstdio>
#include <cwctype>
#include <vector>
#include <string>

// The control pipe is never inherited by the command. EOF means its owner died
// or released the job; a blocking reader and kernel wait avoid polling.
static DWORD WINAPI watchOwner(void* pipe) {
  char byte;
  DWORD count;
  while (ReadFile(static_cast<HANDLE>(pipe), &byte, 1, &count, nullptr) && count) {}
  return 0;
}
static int fail(const char* operation) {
  std::fprintf(stderr, "Windows job launcher: %s failed (%lu)\n", operation, GetLastError());
  return 125;
}
static bool duplicateOutput(DWORD id, HANDLE* output) {
  return DuplicateHandle(GetCurrentProcess(), GetStdHandle(id), GetCurrentProcess(),
                         output, 0, TRUE, DUPLICATE_SAME_ACCESS) != FALSE;
}
int wmain(int argc, wchar_t** argv) {
  if (argc < 2 || !((iswalpha(argv[1][0]) && argv[1][1] == L':' &&
        (argv[1][2] == L'\\' || argv[1][2] == L'/')) ||
        (argv[1][0] == L'\\' && argv[1][1] == L'\\'))) {
    std::fprintf(stderr, "Windows job launcher requires an absolute executable path\n");
    return 125;
  }
  // Strip only this launcher's argv[0]. Forward the original command tail so
  // arguments undergo precisely the same quoting as a direct pipe spawn.
  wchar_t* command = GetCommandLineW();
  bool quoted = false;
  while (*command && (quoted || !iswspace(*command))) {
    if (*command == L'"') quoted = !quoted;
    ++command;
  }
  while (iswspace(*command)) ++command;

  std::wstring commandLine(command);

  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return fail("CreateJobObject");
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)))
    return fail("SetInformationJobObject");

  HANDLE inherited[3]{};
  SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
  inherited[0] = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                            &security, OPEN_EXISTING, 0, nullptr);
  if (inherited[0] == INVALID_HANDLE_VALUE || !duplicateOutput(STD_OUTPUT_HANDLE, &inherited[1]) ||
      !duplicateOutput(STD_ERROR_HANDLE, &inherited[2])) return fail("stdio handles");
  SIZE_T bytes = 0;
  InitializeProcThreadAttributeList(nullptr, 2, 0, &bytes);
  std::vector<unsigned char> storage(bytes);
  auto attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
  if (!InitializeProcThreadAttributeList(attributes, 2, 0, &bytes)) return fail("attribute list");
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
                                inherited, sizeof(inherited), nullptr, nullptr)) return fail("handle list");
#ifdef LVIS_TEST_INVALID_JOB
  // The separately built failure fixture proves creation fails before user code runs.
  HANDLE assignedJob = INVALID_HANDLE_VALUE;
#else
  HANDLE assignedJob = job;
#endif
  if (!UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST,
                                &assignedJob, sizeof(assignedJob), nullptr, nullptr)) return fail("job list");
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = inherited[0];
  startup.StartupInfo.hStdOutput = inherited[1];
  startup.StartupInfo.hStdError = inherited[2];
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION child{};
  // Assignment is atomic with creation, eliminating even an abandoned suspended
  // process if this launcher is terminated between creation and assignment.
  if (!CreateProcessW(argv[1], commandLine.data(), nullptr, nullptr, TRUE,
                      EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW,
                      nullptr, nullptr, &startup.StartupInfo, &child)) return fail("CreateProcess in job");
  DeleteProcThreadAttributeList(attributes);
  for (HANDLE handle : inherited) CloseHandle(handle);
  CloseHandle(child.hThread);
  HANDLE owner = CreateThread(nullptr, 0, watchOwner, GetStdHandle(STD_INPUT_HANDLE), 0, nullptr);
  if (!owner) return fail("owner watcher");
  HANDLE waits[]{child.hProcess, owner};
  DWORD result = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
  DWORD code = 125;
  if (result == WAIT_OBJECT_0) {
    if (!GetExitCodeProcess(child.hProcess, &code)) code = 125;
  } else if (result == WAIT_OBJECT_0 + 1) {
    code = 130;
  }
  // A completed root command must not leave descendants retaining its pipes.
  CloseHandle(job);
  CloseHandle(child.hProcess);
  CloseHandle(owner);
  // ExitProcess also stops the blocking owner reader on normal command exit.
  ExitProcess(code);
}
