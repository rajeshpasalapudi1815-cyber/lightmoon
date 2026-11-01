// The notifications Windows keeps for the notification centre (its own database, read with the SQLite built into
// Windows, read-only): the newest first, with the app each came from and its words. Pop-ups can't be seen by UI
// Automation on Windows 11, so this is how "what notifications did I get?" is answered (ScreenReader.Notifications).
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class NotificationStore
{
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_open_v2(byte[] file, out IntPtr db, int flags, IntPtr vfs);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_close(IntPtr db);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_prepare_v2(IntPtr db, byte[] sql, int bytes, out IntPtr statement, IntPtr tail);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_step(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_finalize(IntPtr statement);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern IntPtr sqlite3_column_blob(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern int sqlite3_column_bytes(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern long sqlite3_column_int64(IntPtr statement, int column);
    [DllImport("winsqlite3.dll", CallingConvention = CallingConvention.StdCall)] static extern IntPtr sqlite3_column_text(IntPtr statement, int column);

    const int SQLITE_OPEN_READONLY = 1, SQLITE_ROW = 100;
    static readonly Regex Text = new Regex("<text[^>]*>(.*?)</text>", RegexOptions.Singleline | RegexOptions.IgnoreCase);

    static readonly string File = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Microsoft\Windows\Notifications\wpndatabase.db");

    // [{ at (ms since 1970), app, text }], newest first, at most `limit`.
    public static List<Dictionary<string, object>> Recent(int limit)
    {
        var found = new List<Dictionary<string, object>>();
        IntPtr db;
        if (sqlite3_open_v2(Encoding.UTF8.GetBytes(File + "\0"), out db, SQLITE_OPEN_READONLY, IntPtr.Zero) != 0) { sqlite3_close(db); return found; }
        try
        {
            string sql = "SELECT n.Payload, n.ArrivalTime, h.PrimaryId FROM Notification n JOIN NotificationHandler h ON n.HandlerId = h.RecordId "
                + "WHERE n.Type = 'toast' ORDER BY n.ArrivalTime DESC LIMIT " + Math.Max(1, Math.Min(limit, 100)) + "\0";
            IntPtr statement;
            if (sqlite3_prepare_v2(db, Encoding.UTF8.GetBytes(sql), -1, out statement, IntPtr.Zero) != 0) return found;
            try
            {
                while (sqlite3_step(statement) == SQLITE_ROW)
                {
                    int size = sqlite3_column_bytes(statement, 0);
                    var payload = new byte[size];
                    if (size > 0) Marshal.Copy(sqlite3_column_blob(statement, 0), payload, 0, size);
                    var words = new List<string>();
                    foreach (Match m in Text.Matches(Encoding.UTF8.GetString(payload)))
                    {
                        string line = System.Net.WebUtility.HtmlDecode(Regex.Replace(m.Groups[1].Value, "<[^>]+>", "")).Trim();
                        if (line.Length > 0) words.Add(line);
                    }
                    if (words.Count == 0) continue;
                    long filetime = sqlite3_column_int64(statement, 1);
                    long ms = filetime > 0 ? (DateTime.FromFileTimeUtc(filetime) - new DateTime(1970, 1, 1)).Ticks / TimeSpan.TicksPerMillisecond : 0;
                    string app = Marshal.PtrToStringAnsi(sqlite3_column_text(statement, 2)) ?? "";
                    string text = string.Join(" / ", words);
                    found.Add(new Dictionary<string, object> { { "at", ms }, { "app", AppName(app) }, { "text", text.Length > 600 ? text.Substring(0, 600) : text } });
                }
            }
            finally { sqlite3_finalize(statement); }
        }
        catch (Exception) { }
        finally { sqlite3_close(db); }
        return found;
    }

    // "MSTeams_8wekyb3d8bbwe!MSTeams" -> "Teams"; "Microsoft.OutlookForWindows_..." -> "Outlook".
    static string AppName(string id)
    {
        string lower = id.ToLowerInvariant();
        if (lower.Contains("teams")) return "Teams";
        if (lower.Contains("outlook")) return "Outlook";
        if (lower.Contains("whatsapp")) return "WhatsApp";
        if (lower.Contains("chrome")) return "Chrome";
        if (lower.Contains("edge")) return "Edge";
        string last = id.Split('!', '\\', '_').Length > 0 ? id.Split('!', '\\')[0] : id;
        return last.Length > 40 ? last.Substring(0, 40) : last;
    }
}
