// Windows worker scope (ADR 0032): one named Job Object per worker. A keeper holds the only lasting
// handle, with KILL_ON_JOB_CLOSE and no breakaway, so the job and every process in it end when the
// keeper ends, which it does when its controller closes its stdin. Each command starts inside the
// job at creation (PROC_THREAD_ATTRIBUTE_JOB_LIST), never assigned after it ran. Loaded by the
// adjacent PowerShell entry point; shipped with the CLI.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class SquawkWorkerJob {
  const uint JobAssignProcess = 0x1, JobQuery = 0x4, JobTerminate = 0x8;
  const uint KillOnJobClose = 0x2000;
  const int ExtendedLimitInformation = 9, BasicAccountingInformation = 1;
  const uint ExtendedStartupInfoPresent = 0x80000, UseStdHandles = 0x100;
  static readonly IntPtr JobListAttribute = (IntPtr)0x2000D;
  const int NotFound = 2;

  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long TotalUserTime, TotalKernelTime, ThisPeriodUserTime, ThisPeriodKernelTime;
    public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
  }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct StartupInfo {
    public int Size; public string Reserved, Desktop, Title;
    public int X, Y, XSize, YSize, XCount, YCount, FillAttribute, Flags; public short ShowWindow, Reserved2;
    public IntPtr Reserved3, StdInput, StdOutput, StdError;
  }
  [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Info; public IntPtr AttributeList; }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInformation { public IntPtr Process, Thread; public int ProcessId, ThreadId; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr security, string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting info, int size, IntPtr returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint exitCode);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CreateProcessW(string application, StringBuilder commandLine, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string directory, ref StartupInfoEx startup, out ProcessInformation info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);

  static Win32Exception Last(string what) { return new Win32Exception(Marshal.GetLastWin32Error(), what); }

  // A job whose last handle closes kills every process in it; no process may break away.
  static IntPtr CreateJob(string name) {
    IntPtr job = CreateJobObjectW(IntPtr.Zero, name);
    if (job == IntPtr.Zero) throw Last("CreateJobObject");
    if (name != null && Marshal.GetLastWin32Error() == 183) { CloseHandle(job); throw new InvalidOperationException("worker job already exists: " + name); }
    var limit = new ExtendedLimit(); limit.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limit, Marshal.SizeOf(typeof(ExtendedLimit)))) { CloseHandle(job); throw Last("SetInformationJobObject"); }
    return job;
  }

  /** Creates the worker's job, reports `ready`, and holds it until stdin ends. */
  public static void Keep(string name) {
    IntPtr job = CreateJob(name);
    Console.Out.WriteLine("ready"); Console.Out.Flush();
    try { Console.In.ReadToEnd(); } finally { CloseHandle(job); }
  }

  /** Starts `argv` inside the named job with this process's standard handles and returns its exit
   * code. The job is opened, never created: a keeper that is not there yet is waited for, and a
   * command whose job never appears does not run. */
  public static int Run(string name, string[] argv, int waitMs) {
    IntPtr job = IntPtr.Zero;
    var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
    while ((job = OpenJobObjectW(JobAssignProcess | JobQuery, false, name)) == IntPtr.Zero) {
      if (Marshal.GetLastWin32Error() != NotFound || DateTime.UtcNow >= deadline) throw Last("OpenJobObject " + name);
      Thread.Sleep(20);
    }
    ProcessInformation info;
    try { info = StartIn(job, argv); } finally { CloseHandle(job); }
    try {
      WaitForSingleObject(info.Process, 0xFFFFFFFF);
      uint code; GetExitCodeProcess(info.Process, out code);
      return (int)code;
    } finally { CloseHandle(info.Process); }
  }

  static ProcessInformation StartIn(IntPtr job, string[] argv) {
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr list = Marshal.AllocHGlobal(size);
    IntPtr jobs = Marshal.AllocHGlobal(IntPtr.Size);
    try {
      if (!InitializeProcThreadAttributeList(list, 1, 0, ref size)) throw Last("InitializeProcThreadAttributeList");
      try {
        Marshal.WriteIntPtr(jobs, job);
        if (!UpdateProcThreadAttribute(list, 0, JobListAttribute, jobs, (IntPtr)IntPtr.Size, IntPtr.Zero, IntPtr.Zero)) throw Last("UpdateProcThreadAttribute");
        var startup = new StartupInfoEx(); startup.Info.Size = Marshal.SizeOf(typeof(StartupInfoEx));
        startup.Info.Flags = (int)UseStdHandles;
        startup.Info.StdInput = GetStdHandle(-10); startup.Info.StdOutput = GetStdHandle(-11); startup.Info.StdError = GetStdHandle(-12);
        startup.AttributeList = list;
        ProcessInformation info;
        if (!CreateProcessW(null, new StringBuilder(CommandLine(argv)), IntPtr.Zero, IntPtr.Zero, true, ExtendedStartupInfoPresent, IntPtr.Zero, null, ref startup, out info)) throw Last("CreateProcess");
        CloseHandle(info.Thread);
        return info;
      } finally { DeleteProcThreadAttributeList(list); }
    } finally { Marshal.FreeHGlobal(jobs); Marshal.FreeHGlobal(list); }
  }

  /** Ends every process in the named job and waits up to `waitMs` for none to be left. */
  public static string Terminate(string name, int waitMs) {
    IntPtr job = OpenJobObjectW(JobTerminate | JobQuery, false, name);
    if (job == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == NotFound) return "absent"; throw Last("OpenJobObject " + name); }
    try {
      if (!TerminateJobObject(job, 1)) throw Last("TerminateJobObject");
      var deadline = DateTime.UtcNow.AddMilliseconds(waitMs);
      while (Active(job) > 0) { if (DateTime.UtcNow >= deadline) return "busy"; Thread.Sleep(10); }
      return "empty";
    } finally { CloseHandle(job); }
  }

  /** How many processes the named job holds, or `absent`. */
  public static string Query(string name) {
    IntPtr job = OpenJobObjectW(JobQuery, false, name);
    if (job == IntPtr.Zero) { if (Marshal.GetLastWin32Error() == NotFound) return "absent"; throw Last("OpenJobObject " + name); }
    try { return Active(job).ToString(); } finally { CloseHandle(job); }
  }

  static uint Active(IntPtr job) {
    Accounting info;
    if (!QueryInformationJobObject(job, BasicAccountingInformation, out info, Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero)) throw Last("QueryInformationJobObject");
    return info.ActiveProcesses;
  }

  /** Whether this host lets this user create a job, start a process inside it at creation, and end it. */
  public static string Probe() {
    IntPtr job = CreateJob(null);
    try {
      var info = StartIn(job, new[] { Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe", "/d", "/c", "exit 0" });
      WaitForSingleObject(info.Process, 10000); CloseHandle(info.Process);
      if (!TerminateJobObject(job, 1)) throw Last("TerminateJobObject");
      return "ok";
    } finally { CloseHandle(job); }
  }

  // The command line CreateProcess parses back into `argv` (the CommandLineToArgvW rules). cmd.exe
  // does not parse by those rules: its arguments pass verbatim, as Node's windowsVerbatimArguments
  // passes them, so a `/s /c "<command>"` string keeps its quotes. A .cmd or .bat file runs through
  // cmd.exe, which CreateProcess requires.
  static string CommandLine(string[] argv) {
    string name = System.IO.Path.GetFileName(argv[0]).ToLowerInvariant();
    if (name == "cmd.exe" || name == "cmd") return Quote(argv[0]) + (argv.Length > 1 ? " " + string.Join(" ", argv, 1, argv.Length - 1) : "");
    var parts = new string[argv.Length];
    for (int i = 0; i < argv.Length; i++) parts[i] = Quote(argv[i]);
    string line = string.Join(" ", parts);
    string file = argv[0].ToLowerInvariant();
    if (file.EndsWith(".cmd") || file.EndsWith(".bat")) return Quote(Environment.GetEnvironmentVariable("ComSpec") ?? "cmd.exe") + " /d /s /c \"" + line + "\"";
    return line;
  }

  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    var quoted = new StringBuilder("\"");
    for (int i = 0; i < arg.Length; i++) {
      int slashes = 0;
      while (i < arg.Length && arg[i] == '\\') { slashes++; i++; }
      if (i == arg.Length) { quoted.Append('\\', slashes * 2); break; }
      if (arg[i] == '"') quoted.Append('\\', slashes * 2 + 1).Append('"');
      else quoted.Append('\\', slashes).Append(arg[i]);
    }
    return quoted.Append('"').ToString();
  }
}
