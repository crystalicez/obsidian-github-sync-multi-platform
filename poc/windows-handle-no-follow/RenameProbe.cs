// D17 test-only Windows native rename / rollback proof. NEVER ship or call from plugin.
// Compiled ONLY by scripts/test-windows-native-rename-poc.mjs into ignored .tmp.
// Object-anchored NtSetInformationFile(FileRenameInformation), no pathname fallback.
using System;
using System.IO;
using System.Text;
using System.Security.Cryptography;
using System.Runtime.InteropServices;

internal static class RenameProbe
{
    private const uint DELETE = 0x10000;
    private const uint FILE_READ_DATA = 0x1;
    private const uint FILE_READ_ATTRIBUTES = 0x80;
    private const uint FILE_TRAVERSE = 0x20;
    private const uint SYNCHRONIZE = 0x100000;
    private const uint FILE_SHARE_ALL = 7;
    private const uint OPEN_EXISTING = 3;
    private const uint FILE_OPEN = 1;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
    private const uint FILE_DIRECTORY_FILE = 1;
    private const uint FILE_NON_DIRECTORY_FILE = 0x40;
    private const uint FILE_SYNCHRONOUS_IO_NONALERT = 0x20;
    private const uint FILE_OPEN_REPARSE_POINT = 0x00200000;
    private const uint OBJ_CASE_INSENSITIVE = 0x40;
    private const uint OBJ_DONT_REPARSE = 0x1000;
    private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
    private const int FileAttributeTagInfo = 9;
    private const int FileRenameInformationClass = 10;
    private static readonly IntPtr InvalidHandle = new IntPtr(-1);

    private const string Original = "D17-ORIGINAL-CONTENT\n";
    private const string Candidate = "D17-CANDIDATE-CONTENT\n";
    private static readonly byte[] OriginalBytes = Encoding.UTF8.GetBytes(Original);
    private static readonly byte[] CandidateBytes = Encoding.UTF8.GetBytes(Candidate);

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

    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true, EntryPoint="CreateFileW")]
    private static extern IntPtr CreateFile(string path, uint access, uint share,
        IntPtr security, uint creation, uint flags, IntPtr templateHandle);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(
        IntPtr handle, int informationClass, out FileAttributeTag info, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFilePointerEx(IntPtr handle, long distance, out long newOffset, uint moveMethod);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileSizeEx(IntPtr handle, out long size);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ReadFile(IntPtr handle, byte[] bytes, uint count,
        out uint read, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("ntdll.dll", ExactSpelling=true)]
    private static extern int NtCreateFile(
        out IntPtr handle, uint access, ref ObjectAttributes oa,
        ref IoStatusBlock iosb, IntPtr allocationSize, uint attributes,
        uint shareAccess, uint disposition, uint flags, IntPtr eaBuffer, uint eaLength);
    [DllImport("ntdll.dll", ExactSpelling=true)]
    private static extern int NtSetInformationFile(
        IntPtr file, ref IoStatusBlock iosb, IntPtr information, uint length, int informationClass);

    private static bool Invalid(IntPtr handle) { return handle == IntPtr.Zero || handle == InvalidHandle; }
    private static void Close(ref IntPtr handle) { if (!Invalid(handle)) CloseHandle(handle); handle = IntPtr.Zero; }
    private static string SafeName(string s)
    {
        if (String.IsNullOrWhiteSpace(s) || s == "." || s == ".."
            || s.IndexOfAny(new char[]{ '\\', '/', ':', '\0' }) >= 0)
            throw new InvalidOperationException("unsafe relative name");
        return s;
    }
    private static void CheckNotReparse(IntPtr h)
    {
        FileAttributeTag result;
        if (!GetFileInformationByHandleEx(h, FileAttributeTagInfo, out result, 8))
            throw new InvalidOperationException("cannot query reparse tag: " + Marshal.GetLastWin32Error());
        if ((result.Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
            throw new InvalidOperationException("reparse or junction rejected");
    }
    private static IntPtr OpenChild(IntPtr parent, string name, bool directory, bool optional)
    {
        name = SafeName(name);
        var text = Marshal.StringToHGlobalUni(name);
        IntPtr unicode = IntPtr.Zero;
        try
        {
            var us = new UnicodeString {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)((name.Length + 1) * 2)),
                Buffer = text
            };
            unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(us, unicode, false);
            var oa = new ObjectAttributes {
                Length = (uint)Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = parent,
                ObjectName = unicode,
                Attributes = OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE
            };
            IoStatusBlock iosb = new IoStatusBlock();
            IntPtr result;
            uint access = FILE_READ_ATTRIBUTES | SYNCHRONIZE | (directory ? FILE_TRAVERSE : FILE_READ_DATA | DELETE);
            uint options = FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_REPARSE_POINT |
                (directory ? FILE_DIRECTORY_FILE : FILE_NON_DIRECTORY_FILE);
            int status = NtCreateFile(out result, access, ref oa, ref iosb,
                IntPtr.Zero, 0, FILE_SHARE_ALL, FILE_OPEN, options, IntPtr.Zero, 0);
            if (optional && (status == unchecked((int)0xC0000034) || status == unchecked((int)0xC000003A)))
                return IntPtr.Zero;
            if (status < 0 || Invalid(result))
                throw new InvalidOperationException("native relative open rejected: NTSTATUS=0x" + status.ToString("X8"));
            try { CheckNotReparse(result); return result; }
            catch { CloseHandle(result); throw; }
        }
        finally
        {
            if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
            Marshal.FreeHGlobal(text);
        }
    }
    private static byte[] ReadSmallPinned(IntPtr file)
    {
        if (Invalid(file)) throw new InvalidOperationException("missing proof-bearing file handle");
        long size, offset;
        if (!GetFileSizeEx(file, out size)) throw new InvalidOperationException("GetFileSizeEx failed: " + Marshal.GetLastWin32Error());
        if (!SetFilePointerEx(file, 0, out offset, 0)) throw new InvalidOperationException("SetFilePointerEx failed: " + Marshal.GetLastWin32Error());
        byte[] chunk = new byte[4096];
        uint count;
        if (!ReadFile(file, chunk, (uint)chunk.Length, out count, IntPtr.Zero))
            throw new InvalidOperationException("native ReadFile failed: " + Marshal.GetLastWin32Error());
        if (count >= chunk.Length) throw new InvalidOperationException("oversize proof fixture");
        if (count != size) throw new InvalidOperationException("native content length mismatch size=" + size + " read=" + count);
        var result = new byte[(int)count];
        Array.Copy(chunk, result, count);
        return result;
    }
    private static bool Equal(byte[] a, byte[] b)
    {
        using (var sha = SHA256.Create())
            return String.Equals(BitConverter.ToString(sha.ComputeHash(a)), BitConverter.ToString(sha.ComputeHash(b)), StringComparison.Ordinal)
                && a.Length == b.Length;
    }
    private static string HashHex(byte[] bytes)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
    }
    private static void ProveIntent(IntPtr pinnedRoot)
    {
        // This is a test-only, pre-fsynced durable-intent fixture, not the
        // production WAL protocol or a storage-power-failure proof.
        IntPtr h = OpenChild(pinnedRoot, ".wal-intent-d17", false, false);
        try
        {
            string expected = "D17-WAL-INTENT-V1\noriginal=" + HashHex(OriginalBytes)
                + "\ncandidate=" + HashHex(CandidateBytes) + "\n";
            string recorded = Encoding.ASCII.GetString(ReadSmallPinned(h));
            if (!String.Equals(expected,recorded,StringComparison.Ordinal))
                throw new InvalidOperationException("MANUAL_REVIEW WAL intent is missing or corrupted");
        }
        finally { Close(ref h); }
    }
    private static void Prove(IntPtr file, byte[] expected, string name)
    {
        byte[] actual = ReadSmallPinned(file);
        if (!Equal(actual, expected))
            throw new InvalidOperationException("MANUAL_REVIEW unverified " + name + " actual=" + BitConverter.ToString(actual) + " expected=" + BitConverter.ToString(expected));
    }
    // FILE_RENAME_INFORMATION: BOOLEAN ReplaceIfExists at offset 0,
    // HANDLE RootDirectory at offset 8 (x64), ULONG FileNameLength at 16,
    // variable UTF-16 bytes beginning at offset 20. No ReplaceIfExists:
    // a pre-existing file or symlink is a hard stop, never overwrite.
    private static void RenamePinned(IntPtr source, IntPtr pinnedParent, string dest)
    {
        dest = SafeName(dest);
        if (IntPtr.Size != 8) throw new InvalidOperationException("D17 PoC x64 only");
        byte[] encoded = Encoding.Unicode.GetBytes(dest);
        int size = checked(20 + encoded.Length);
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try
        {
            for (int i=0;i<size;i++) Marshal.WriteByte(buffer, i, 0);
            Marshal.WriteByte(buffer, 0, 0);
            Marshal.WriteIntPtr(buffer, 8, pinnedParent);
            Marshal.WriteInt32(buffer, 16, encoded.Length);
            Marshal.Copy(encoded, 0, IntPtr.Add(buffer,20), encoded.Length);
            IoStatusBlock iosb = new IoStatusBlock();
            int status = NtSetInformationFile(source, ref iosb, buffer, (uint)size, FileRenameInformationClass);
            if (status < 0)
                throw new InvalidOperationException("native handle-relative rename rejected: NTSTATUS=0x" + status.ToString("X8"));
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    private static void PauseAt(string label)
    {
        Console.Out.WriteLine("CUT:" + label);
        Console.Out.Flush();
        if (Console.ReadLine() != "GO") throw new InvalidOperationException("missing GO after " + label);
    }
    private static void RequireAbsent(IntPtr parent, string name)
    {
        IntPtr found = OpenChild(parent,name,false,true);
        if (!Invalid(found)) { Close(ref found); throw new InvalidOperationException("MANUAL_REVIEW occupied " + name); }
    }
    private static void Rollback(IntPtr parent, bool stepwise)
    {
        IntPtr backup = OpenChild(parent, "original.backup", false, true);
        IntPtr target = IntPtr.Zero, residue = IntPtr.Zero, stage = IntPtr.Zero;
        try
        {
            target = OpenChild(parent, "original.md", false, true);
            residue = OpenChild(parent, "replacement.residue", false, true);
            stage = OpenChild(parent, "candidate.stage", false, true);
            // Proof-gate *every* file we might touch. Unknown local edits:
            // fail and preserve everything for manual review.
            if (!Invalid(backup)) Prove(backup,OriginalBytes,"backup");
            if (!Invalid(target))
                Prove(target,Invalid(backup) ? OriginalBytes : CandidateBytes,"target");
            if (!Invalid(residue)) Prove(residue,CandidateBytes,"residue");
            if (!Invalid(stage)) Prove(stage,CandidateBytes,"stage");
            if (!Invalid(backup))
            {
                if (!Invalid(target))
                {
                    if (!Invalid(residue)) throw new InvalidOperationException("MANUAL_REVIEW target and residue coexist");
                    // Never delete/replace candidate; first park it.
                    // Use the existing proven target FILE HANDLE.
                    RenamePinned(target,parent,"replacement.residue");
                    Close(ref target);
                    if (stepwise) PauseAt("PARK");
                }
                // Opening backup above is a handle identity/proof, but
                // the directory entry may have changed; native rename is pinned
                // and destination no-replace, so outside links cannot redirect.
                RequireAbsent(parent,"original.md");
                RenamePinned(backup,parent,"original.md");
                if (stepwise) PauseAt("RESTORE");
                return;
            }
            // A crash after the final restore may leave only original+residue.
            // Proof and preserve the residue for a separate receipt-gated cleanup.
            if (!Invalid(target) && !Invalid(residue)) return;
            if (!Invalid(target) && Invalid(residue)) return;
            throw new InvalidOperationException("MANUAL_REVIEW insufficient recovery evidence");
        }
        finally { Close(ref stage); Close(ref residue); Close(ref target); Close(ref backup); }
    }
    private static void Commit(IntPtr parent)
    {
        IntPtr original=IntPtr.Zero, stage=IntPtr.Zero;
        try
        {
            original = OpenChild(parent,"original.md",false,false);
            stage = OpenChild(parent,"candidate.stage",false,false);
            Prove(original,OriginalBytes,"original");
            Prove(stage,CandidateBytes,"stage");
            RequireAbsent(parent,"original.backup");
            RequireAbsent(parent,"replacement.residue");
            Console.Out.WriteLine("READY"); Console.Out.Flush();
            if (Console.ReadLine() != "GO") throw new InvalidOperationException("missing initial GO");
            // A user may have edited an open source after the first proof.
            // We recheck bytes through pinned handles immediately before each rename.
            // This PoC still does NOT guarantee no concurrent write between these calls.
            Prove(original,OriginalBytes,"original");
            RenamePinned(original,parent,"original.backup");
            PauseAt("BACKUP");
            Prove(stage,CandidateBytes,"stage");
            RequireAbsent(parent,"original.md");
            RenamePinned(stage,parent,"original.md");
            PauseAt("PUBLISH");
        }
        finally { Close(ref stage); Close(ref original); }
    }
    public static int Main(string[] args)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || IntPtr.Size != 8) return 8;
        if (args.Length != 2) return 2;
        string root = Path.GetFullPath(args[0]).TrimEnd(Path.DirectorySeparatorChar);
        // The executable lives inside a random d17-native-build-* directory
        // in the SAME ignored .tmp parent as the generated disposable root.
        // A similarly named path anywhere else must never be accepted.
        string compiledDir = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar);
        string allowedParent = Path.GetDirectoryName(compiledDir);
        if (!String.Equals(Path.GetDirectoryName(root), allowedParent, StringComparison.OrdinalIgnoreCase)
            || Path.GetFileName(allowedParent) != ".tmp"
            || !Path.GetFileName(root).StartsWith("d17-native-root-",StringComparison.Ordinal)
            || !File.Exists(Path.Combine(root,".d17-poc-only"))) return 3;
        string mode=args[1];
        if (mode != "commit" && mode != "rollback-auto" && mode != "rollback-steps") return 4;
        IntPtr trusted=IntPtr.Zero, dir=IntPtr.Zero;
        try
        {
            trusted=CreateFile(root,FILE_READ_ATTRIBUTES|FILE_TRAVERSE|SYNCHRONIZE,
                FILE_SHARE_ALL,IntPtr.Zero,OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,IntPtr.Zero);
            if (Invalid(trusted)) throw new InvalidOperationException("cannot open pinned root: " + Marshal.GetLastWin32Error());
            CheckNotReparse(trusted);
            ProveIntent(trusted);
            dir=OpenChild(trusted,"notes",true,false);
            if (mode=="commit") Commit(dir);
            else Rollback(dir,mode=="rollback-steps");
            Console.Out.WriteLine("COMPLETE"); Console.Out.Flush();
            return 0;
        }
        catch(Exception e) { Console.Error.WriteLine(e.GetType().Name+": "+e.Message); return 6; }
        finally { Close(ref dir); Close(ref trusted); }
    }
}
