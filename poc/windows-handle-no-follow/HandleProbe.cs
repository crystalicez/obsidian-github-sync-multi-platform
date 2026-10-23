// D16 ONLY: test-only proof of concept. NEVER bundle, invoke from plugin, or release.
// Compiled explicitly by scripts/test-windows-native-handle-poc.mjs into ignored .tmp.
// Uses Windows directory and file handles; no Node path-based deletes.
using System;
using System.IO;
using System.Runtime.InteropServices;

internal static class HandleProbe
{
    private const uint DELETE = 0x00010000;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_TRAVERSE = 0x00000020;
    private const uint SYNCHRONIZE = 0x00100000;
    private const uint FILE_SHARE_ALL = 0x00000007;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_OPEN = 1;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_DIRECTORY_FILE = 0x00000001;
    private const uint FILE_NON_DIRECTORY_FILE = 0x00000040;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x00000020;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint OBJ_CASE_INSENSITIVE = 0x00000040;
    private const uint OBJ_DONT_REPARSE = 0x00001000;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
    private const int FileAttributeTagInfo = 9;
    private const int FileDispositionInfo = 4;

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public uint Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock { public IntPtr Status; public IntPtr Information; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileAttributeTag { public uint Attributes; public uint ReparseTag; }

    [StructLayout(LayoutKind.Sequential)]
    private struct FileDisposition { public byte DeleteFile; }

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
    private static extern IntPtr CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr templateHandle);

    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        IntPtr handle, int informationClass, out FileAttributeTag information, uint size);

    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(
        IntPtr handle, int informationClass, ref FileDisposition information, uint size);

    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll", ExactSpelling=true)]
    private static extern int NtCreateFile(
        out IntPtr handle, uint desiredAccess, ref ObjectAttributes objectAttributes,
        ref IoStatusBlock ioStatusBlock, IntPtr allocationSize, uint fileAttributes,
        uint shareAccess, uint createDisposition, uint createOptions,
        IntPtr eaBuffer, uint eaLength);

    private static bool Invalid(IntPtr h) { return h == IntPtr.Zero || h == new IntPtr(-1); }
    private static string Name(string value)
    {
        if (String.IsNullOrWhiteSpace(value) || value == "." || value == ".."
            || value.IndexOfAny(new char[] { '\\', '/', ':', '\0' }) >= 0)
            throw new InvalidOperationException("Relative name is unsafe");
        return value;
    }

    private static void CheckNotReparse(IntPtr handle)
    {
        FileAttributeTag info;
        if (!GetFileInformationByHandleEx(handle, FileAttributeTagInfo, out info, 8))
            throw new InvalidOperationException("attribute query failed: " + Marshal.GetLastWin32Error());
        if ((info.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            throw new InvalidOperationException("reparse or junction target refused");
    }

    // RootDirectory is a previously opened DIRECTORY handle. The kernel resolves
    // a single component RELATIVE to that handle, regardless of a concurrent
    // replacement of the textual parent path. No fallback to a pathname.
    private static IntPtr OpenChild(IntPtr parent, string component, bool directory)
    {
        component = Name(component);
        IntPtr stringBuffer = Marshal.StringToHGlobalUni(component);
        IntPtr unicodeBuffer = IntPtr.Zero;
        try
        {
            var name = new UnicodeString {
                Length = checked((ushort)(component.Length * 2)),
                MaximumLength = checked((ushort)((component.Length + 1) * 2)),
                Buffer = stringBuffer
            };
            unicodeBuffer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(name, unicodeBuffer, false);
            var oa = new ObjectAttributes {
                Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = parent,
                ObjectName = unicodeBuffer,
                Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
            };
            IoStatusBlock iosb = new IoStatusBlock();
            IntPtr result;
            uint access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | (directory ? FILE_TRAVERSE : DELETE);
            uint flags = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT
                | (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
            int status = NtCreateFile(out result, access, ref oa, ref iosb,
                IntPtr.Zero, 0, FILE_SHARE_ALL, FILE_OPEN, flags, IntPtr.Zero, 0);
            if (status < 0 || Invalid(result))
                throw new InvalidOperationException("NtCreateFile relative failed, NTSTATUS=0x" + status.ToString("X8"));
            try { CheckNotReparse(result); return result; }
            catch { CloseHandle(result); throw; }
        }
        finally {
            if (unicodeBuffer != IntPtr.Zero) Marshal.FreeHGlobal(unicodeBuffer);
            Marshal.FreeHGlobal(stringBuffer);
        }
    }

    private static void DeletePinned(IntPtr file)
    {
        FileDisposition info = new FileDisposition { DeleteFile = 1 };
        if (!SetFileInformationByHandle(file, FileDispositionInfo, ref info, 1))
            throw new InvalidOperationException("delete-by-handle failed Win32=" + Marshal.GetLastWin32Error());
    }

    public static int Main(string[] args)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT) return 8;
        if (args.Length != 2) { Console.Error.WriteLine("Usage: HandleProbe <disposable D16 vault> <pinned|parent|root-only|reject-link>"); return 2; }
        string root = Path.GetFullPath(args[0]).TrimEnd(Path.DirectorySeparatorChar);
        // This test-only helper deliberately cannot target a personal vault or
        // any arbitrary file name. The test script owns these disposable roots.
        if (!Path.GetFileName(root).StartsWith("d16-native-root-", StringComparison.Ordinal)
            || !File.Exists(Path.Combine(root, ".d16-poc-only"))) {
            Console.Error.WriteLine("Refused non-D16 disposable root");
            return 3;
        }
        string mode = args[1];
        if (mode != "pinned" && mode != "parent" && mode != "root-only" && mode != "reject-link") return 4;
        IntPtr hRoot = IntPtr.Zero, hDir = IntPtr.Zero, hFile = IntPtr.Zero;
        try
        {
            hRoot = CreateFile(root, FILE_READ_ATTRIBUTES | FILE_TRAVERSE | SYNCHRONIZE,
                FILE_SHARE_ALL, IntPtr.Zero, OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
            if (Invalid(hRoot)) throw new InvalidOperationException("root open failed: " + Marshal.GetLastWin32Error());
            CheckNotReparse(hRoot);
            if (mode != "root-only") hDir = OpenChild(hRoot, "notes", true);
            if (mode == "pinned") hFile = OpenChild(hDir, "sentinel.bin", false);
            if (mode == "reject-link") {
                // The harness intentionally places a junction at notes: OpenChild
                // must refuse it before this point; success is a test failure.
                Console.Error.WriteLine("ERROR: initial junction was followed!");
                return 5;
            }
            Console.Out.WriteLine("READY");
            Console.Out.Flush();
            if (Console.ReadLine() != "GO") throw new InvalidOperationException("missing GO handshake");
            if (mode == "root-only") hDir = OpenChild(hRoot, "notes", true);
            if (mode == "parent" || mode == "root-only") hFile = OpenChild(hDir, "sentinel.bin", false);
            CheckNotReparse(hFile);
            DeletePinned(hFile);
            Console.Out.WriteLine("DELETED_PINNED");
            return 0;
        }
        catch (Exception error) {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 6;
        }
        finally {
            if (!Invalid(hFile)) CloseHandle(hFile);
            if (!Invalid(hDir)) CloseHandle(hDir);
            if (!Invalid(hRoot)) CloseHandle(hRoot);
        }
    }
}
