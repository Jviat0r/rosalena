// lowrun: the Windows half of Rosalena's shell sandbox.
//
// It starts one command in a Low-integrity process (Mandatory Integrity Control, MSDN
// "Designing Applications to Run at a Low Integrity Level"). Windows refuses any write
// from a Low process to an object labeled higher than Low ("no write up"), and every
// file and registry key without a label counts as Medium. So the command can write only
// where a folder has been labeled Low on purpose, and nowhere else.
//
// It is compiled once by sandbox.mjs with the .NET Framework's csc.exe (C# 5, so no
// newer syntax here) and cached; it never needs admin rights:
//  - The token is a restricted copy of our own (CreateRestrictedToken), so
//    CreateProcessAsUser accepts it without SeAssignPrimaryTokenPrivilege.
//  - DISABLE_MAX_PRIVILEGE drops every privilege except bypass-traverse, which a
//    shell needs to walk folders.
//  - The child runs in a job object that kills the whole process tree when this
//    helper exits or is killed, so a timeout in node (which kills us) also kills the
//    command and anything it started.
//  - Output: our stdin/stdout/stderr handles (node's pipes) are passed straight to the
//    child. Integrity is checked when a handle is opened, not when an inherited handle is
//    used, so the Low child can write to the pipes node already holds.
//
// Usage (arguments are base64 UTF-8 so quoting never matters):
//   lowrun run <cwd-b64> <commandline-b64>    exit code = the command's exit code
//   lowrun get-label <path-b64>               prints the label as SDDL, e.g. S:(ML;OICI;NW;;;LW)
//   lowrun set-low <path-b64>                 labels it Low, inherited by everything below
//                                             (what `icacls <dir> /setintegritylevel (OI)(CI)Low` does)
//   lowrun clear-label <path-b64>             removes an explicit integrity label
// The label commands use SDDL rather than parsing icacls output, which is localized.
// Setup failures print a line starting "[rosalena-sandbox]" to stderr and exit 125.

using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

static class LowRun
{
    const uint TOKEN_ASSIGN_PRIMARY = 0x0001, TOKEN_DUPLICATE = 0x0002, TOKEN_QUERY = 0x0008, TOKEN_ADJUST_DEFAULT = 0x0080;
    const uint DISABLE_MAX_PRIVILEGE = 0x1;
    const int TokenIntegrityLevel = 25;
    const uint SE_GROUP_INTEGRITY = 0x20;
    const uint CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400;
    const uint STARTF_USESTDHANDLES = 0x100;
    const uint HANDLE_FLAG_INHERIT = 0x1;
    const int JobObjectExtendedLimitInformation = 9;
    const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    const uint INFINITE = 0xFFFFFFFF;
    const int SE_FILE_OBJECT = 1;
    const uint LABEL_SECURITY_INFORMATION = 0x10;
    const int SETUP_FAILED = 125;

    [StructLayout(LayoutKind.Sequential)]
    struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }

    [StructLayout(LayoutKind.Sequential)]
    struct TOKEN_MANDATORY_LABEL { public SID_AND_ATTRIBUTES Label; }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO
    {
        public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public uint dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags; public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS { public ulong a, b, c, d, e, f; }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int len);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr p);

    [DllImport("advapi32.dll", SetLastError = true)] static extern bool OpenProcessToken(IntPtr proc, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool CreateRestrictedToken(IntPtr existing, uint flags, uint nDisable, IntPtr disable, uint nDelete, IntPtr delete, uint nRestrict, IntPtr restrict, out IntPtr newToken);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool ConvertStringSidToSid(string sid, out IntPtr psid);
    [DllImport("advapi32.dll")] static extern int GetLengthSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool SetTokenInformation(IntPtr token, int cls, ref TOKEN_MANDATORY_LABEL info, int len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(IntPtr token, string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
    [DllImport("advapi32.dll", SetLastError = true)] static extern bool InitializeAcl(byte[] acl, int len, int revision);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern int SetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, byte[] sacl);
    [DllImport("advapi32.dll", EntryPoint = "SetNamedSecurityInfoW", CharSet = CharSet.Unicode)]
    static extern int SetNamedSecurityInfoPtr(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)]
    static extern int GetNamedSecurityInfo(string name, int type, uint info, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl, out IntPtr sd);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertSecurityDescriptorToStringSecurityDescriptor(IntPtr sd, uint revision, uint info, out IntPtr str, out uint len);
    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr sd, out uint len);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetSecurityDescriptorSacl(IntPtr sd, out bool present, out IntPtr sacl, out bool defaulted);

    static string FromB64(string s) { return Encoding.UTF8.GetString(Convert.FromBase64String(s)); }

    static int Fail(string what)
    {
        int e = Marshal.GetLastWin32Error();
        Console.Error.WriteLine("[rosalena-sandbox] " + what + " failed: Win32 error " + e + " (" + new Win32Exception(e).Message + ")");
        return SETUP_FAILED;
    }

    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 3 && args[0] == "run") return Run(FromB64(args[1]), FromB64(args[2]));
            if (args.Length == 2 && args[0] == "clear-label") return ClearLabel(FromB64(args[1]));
            if (args.Length == 2 && args[0] == "get-label") return GetLabel(FromB64(args[1]));
            if (args.Length == 2 && args[0] == "set-low") return SetLow(FromB64(args[1]));
            Console.Error.WriteLine("[rosalena-sandbox] usage: lowrun run <cwd-b64> <cmd-b64> | get-label | set-low | clear-label <path-b64>");
            return SETUP_FAILED;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("[rosalena-sandbox] " + ex.Message);
            return SETUP_FAILED;
        }
    }

    static int Run(string cwd, string commandLine)
    {
        IntPtr own, low, sid;
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT, out own)) return Fail("OpenProcessToken");
        if (!CreateRestrictedToken(own, DISABLE_MAX_PRIVILEGE, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out low)) return Fail("CreateRestrictedToken");
        if (!ConvertStringSidToSid("S-1-16-4096", out sid)) return Fail("ConvertStringSidToSid"); // Low mandatory level
        TOKEN_MANDATORY_LABEL tml = new TOKEN_MANDATORY_LABEL();
        tml.Label.Sid = sid;
        tml.Label.Attributes = SE_GROUP_INTEGRITY;
        if (!SetTokenInformation(low, TokenIntegrityLevel, ref tml, Marshal.SizeOf(typeof(TOKEN_MANDATORY_LABEL)) + GetLengthSid(sid))) return Fail("SetTokenInformation(IntegrityLevel=Low)");

        // The job is created before the child so there is no moment where the child runs
        // outside it: it starts suspended, joins the job, then resumes.
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) return Fail("CreateJobObject");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) return Fail("SetInformationJobObject");

        STARTUPINFO si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        si.dwFlags = STARTF_USESTDHANDLES;
        si.hStdInput = GetStdHandle(-10);
        si.hStdOutput = GetStdHandle(-11);
        si.hStdError = GetStdHandle(-12);
        foreach (IntPtr h in new IntPtr[] { si.hStdInput, si.hStdOutput, si.hStdError })
            if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

        PROCESS_INFORMATION pi;
        StringBuilder cmd = new StringBuilder(commandLine, commandLine.Length + 1);
        // Environment IntPtr.Zero: the child gets ours, which sandbox.mjs already set up
        // (TEMP/TMP pointing at the per-run Low folder).
        if (!CreateProcessAsUser(low, null, cmd, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, cwd, ref si, out pi))
            return Fail("CreateProcessAsUser");
        if (!AssignProcessToJobObject(job, pi.hProcess))
        {
            int code = Fail("AssignProcessToJobObject");
            TerminateProcess(pi.hProcess, 1);
            return code;
        }
        ResumeThread(pi.hThread);
        CloseHandle(pi.hThread);
        WaitForSingleObject(pi.hProcess, INFINITE);
        uint exit;
        GetExitCodeProcess(pi.hProcess, out exit);
        CloseHandle(pi.hProcess);
        LocalFree(sid);
        // Returning closes the job handle, which kills anything the command left running
        // in the background: a sandboxed command does not outlive its own result.
        return unchecked((int)exit);
    }

    // icacls can set a label but not remove one. An empty SACL written with
    // LABEL_SECURITY_INFORMATION removes the explicit label ACE; SetNamedSecurityInfo
    // then re-propagates inheritance, so children that only inherited the label lose it.
    static int ClearLabel(string path)
    {
        byte[] acl = new byte[8];
        if (!InitializeAcl(acl, acl.Length, 2)) return Fail("InitializeAcl");
        int rc = SetNamedSecurityInfo(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, acl);
        return Checked("SetNamedSecurityInfo(clear label)", rc);
    }

    static int Checked(string what, int rc)
    {
        if (rc == 0) return 0;
        Console.Error.WriteLine("[rosalena-sandbox] " + what + " failed: Win32 error " + rc + " (" + new Win32Exception(rc).Message + ")");
        return SETUP_FAILED;
    }

    static int GetLabel(string path)
    {
        IntPtr sd;
        int rc = GetNamedSecurityInfo(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);
        if (rc != 0) return Checked("GetNamedSecurityInfo", rc);
        IntPtr str; uint len;
        if (!ConvertSecurityDescriptorToStringSecurityDescriptor(sd, 1, LABEL_SECURITY_INFORMATION, out str, out len)) return Fail("ConvertSecurityDescriptorToStringSecurityDescriptor");
        Console.Out.WriteLine(Marshal.PtrToStringUni(str));
        LocalFree(str);
        LocalFree(sd);
        return 0;
    }

    // OI|CI: files and folders below inherit it; NW: "no write up", the default policy.
    static int SetLow(string path)
    {
        IntPtr sd; uint len;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;OICI;NW;;;LW)", 1, out sd, out len)) return Fail("ConvertStringSecurityDescriptorToSecurityDescriptor");
        bool present, defaulted; IntPtr sacl;
        if (!GetSecurityDescriptorSacl(sd, out present, out sacl, out defaulted)) return Fail("GetSecurityDescriptorSacl");
        int rc = SetNamedSecurityInfoPtr(path, SE_FILE_OBJECT, LABEL_SECURITY_INFORMATION, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, sacl);
        LocalFree(sd);
        return Checked("SetNamedSecurityInfo(Low label)", rc);
    }
}
