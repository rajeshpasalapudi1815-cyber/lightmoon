// LightMoon working with this computer's apps, when asked:
//   Launch(name)   "open Outlook", "open Notepad": a Start menu app or a well-known Store app, by name. It only
//                  opens the app; nothing inside it is read or typed.
//   Remember()     at the wake word: which box the user was typing in (the window in front and its focused field).
//   Typed()        what is written in that box, for "LightMoon, improve this".
//   Replace(text)  puts the better version back in that box (Ctrl+Z in most apps brings theirs back). Nothing is sent.
// Typing in work apps (Teams, Outlook, the company account) is never read: company words must not reach the AI.
// The bridge (DesktopOrb.cs) answers POST /launch, GET /typed and POST /typed, for LightMoon's own page only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

static class DesktopApps
{
    static readonly Regex Work = new Regex(@"\b(teams|outlook|sarasamerica|arogya360)\b", RegexOptions.IgnoreCase);

    // ---------- Opening apps ----------

    // Store apps have no shortcut file: the usual ones by their Windows app id.
    static readonly Dictionary<string, string> StoreApps = new Dictionary<string, string>
    {
        { "Outlook", "Microsoft.OutlookForWindows_8wekyb3d8bbwe!Microsoft.OutlookforWindows" },
        { "Teams", "MSTeams_8wekyb3d8bbwe!MSTeams" },
        { "WhatsApp", "5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App" },
        { "Calculator", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" },
        { "Camera", "Microsoft.WindowsCamera_8wekyb3d8bbwe!App" },
        { "Photos", "Microsoft.Windows.Photos_8wekyb3d8bbwe!App" },
        { "Notepad", "Microsoft.WindowsNotepad_8wekyb3d8bbwe!App" },
        { "Snipping Tool", "Microsoft.ScreenSketch_8wekyb3d8bbwe!App" },
        { "Sound Recorder", "Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe!App" },
        { "Microsoft Store", "Microsoft.WindowsStore_8wekyb3d8bbwe!App" },
        { "Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify" },
        { "Clock", "Microsoft.WindowsAlarms_8wekyb3d8bbwe!App" },
        { "Settings", "windows.immersivecontrolpanel_cw5n1h2txyewy!microsoft.windows.immersivecontrolpanel" },
    };

    // -> { opened: "Outlook" } or { opened: "", like: [close names] }.
    public static Dictionary<string, object> Launch(string asked)
    {
        string want = Plain(Regex.Replace(asked ?? "", @"^(the|my)\s+|\s+app$", "", RegexOptions.IgnoreCase));
        if (want.Length == 0) return new Dictionary<string, object> { { "opened", "" }, { "error", "Which app?" } };
        // Start menu shortcuts (everyone's and this user's), then the Store apps above.
        var apps = new List<KeyValuePair<string, string>>();
        foreach (var folder in new[] {
            Environment.GetFolderPath(Environment.SpecialFolder.CommonStartMenu),
            Environment.GetFolderPath(Environment.SpecialFolder.StartMenu) })
        {
            try
            {
                foreach (string file in System.IO.Directory.GetFiles(folder, "*.lnk", System.IO.SearchOption.AllDirectories))
                    apps.Add(new KeyValuePair<string, string>(System.IO.Path.GetFileNameWithoutExtension(file), file));
            }
            catch (Exception) { }
        }
        foreach (var store in StoreApps) apps.Add(new KeyValuePair<string, string>(store.Key, "store:" + store.Value));

        // Best match: the same name, then a name starting with the words, then one containing them; the shortest wins.
        // Uninstallers and help pages are left out.
        Func<KeyValuePair<string, string>, int> score = app =>
        {
            string name = Plain(app.Key);
            if (Regex.IsMatch(name, @"\b(uninstall|readme|help|safe mode|documentation|release notes)\b")) return -1;
            if (name == want) return 3;
            if (name.StartsWith(want + " ")) return 2;
            if (Regex.IsMatch(name, @"\b" + Regex.Escape(want) + @"\b")) return 1;
            return -1;
        };
        var best = apps.Select(a => new { a, s = score(a) }).Where(x => x.s >= 0)
            .OrderByDescending(x => x.s).ThenBy(x => x.a.Value.StartsWith("store:") ? 0 : 1).ThenBy(x => x.a.Key.Length).Select(x => x.a).ToList();
        if (best.Count == 0)
        {
            string first = want.Split(' ')[0];
            string part = first.Length > 3 ? first.Substring(0, 4) : first;
            var like = apps.Where(a => Plain(a.Key).Contains(part)).Select(a => a.Key).Distinct().Take(6).ToList();
            return new Dictionary<string, object> { { "opened", "" }, { "like", like } };
        }
        var chosen = best[0];
        try
        {
            if (chosen.Value.StartsWith("store:")) Process.Start("explorer.exe", "shell:AppsFolder\\" + chosen.Value.Substring(6));
            else Process.Start(new ProcessStartInfo(chosen.Value) { UseShellExecute = true });
        }
        catch (Exception err) { return new Dictionary<string, object> { { "opened", "" }, { "error", err.Message } }; }
        return new Dictionary<string, object> { { "opened", chosen.Key } };
    }

    static string Plain(string text)
    {
        return Regex.Replace((text ?? "").ToLowerInvariant().Replace("microsoft ", ""), @"[^a-z0-9 ]", " ").Trim();
    }

    // ---------- The box they were typing in ----------

    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);

    static IntPtr typedWindow = IntPtr.Zero;
    static AutomationElement typedBox;
    static string typedApp = "";
    static DateTime typedAt = DateTime.MinValue;
    static readonly TimeSpan KeepFor = TimeSpan.FromMinutes(3);

    static string AppOf(IntPtr window)
    {
        var title = new StringBuilder(512);
        GetWindowText(window, title, title.Capacity);
        string process = "";
        try
        {
            uint id;
            GetWindowThreadProcessId(window, out id);
            process = Process.GetProcessById((int)id).ProcessName;
        }
        catch (Exception) { }
        return (process + " | " + title.ToString().Replace("​", "")).Trim();
    }

    // At the wake word, before LightMoon shows itself: the window in front and its focused field.
    public static void Remember()
    {
        try
        {
            IntPtr window = GetForegroundWindow();
            string app = AppOf(window);
            if (window == IntPtr.Zero || app.IndexOf("LightMoon", StringComparison.OrdinalIgnoreCase) >= 0) return;
            AutomationElement box = null;
            var worker = new Thread(() => { try { box = AutomationElement.FocusedElement; } catch (Exception) { } }) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            worker.Join(2000);
            typedWindow = window;
            typedBox = box;
            typedApp = app;
            typedAt = DateTime.Now;
        }
        catch (Exception) { }
    }

    static string TextIn(AutomationElement box)
    {
        object pattern;
        if (box.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)) return ((ValuePattern)pattern).Current.Value ?? "";
        if (box.TryGetCurrentPattern(TextPattern.Pattern, out pattern)) return ((TextPattern)pattern).DocumentRange.GetText(8000) ?? "";
        return "";
    }

    // -> { found, app, text } or { found: false, why }.
    public static Dictionary<string, object> Typed()
    {
        if (typedBox == null || DateTime.Now - typedAt > KeepFor)
            return new Dictionary<string, object> { { "found", false }, { "why", "nothing" } };
        if (Work.IsMatch(typedApp)) return new Dictionary<string, object> { { "found", false }, { "why", "work" }, { "app", "a work app" } };
        string text = "";
        var worker = new Thread(() => { try { text = TextIn(typedBox); } catch (Exception) { } }) { IsBackground = true };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        worker.Join(4000);
        if (text.Trim().Length == 0) return new Dictionary<string, object> { { "found", false }, { "why", "empty" }, { "app", typedApp } };
        if (Work.IsMatch(text.Length > 400 ? text.Substring(0, 400) : text)) return new Dictionary<string, object> { { "found", false }, { "why", "work" }, { "app", typedApp } };
        return new Dictionary<string, object> { { "found", true }, { "app", typedApp }, { "text", text.Length > 6000 ? text.Substring(0, 6000) : text } };
    }

    // Puts `text` in that box in place of what was there: back to its window, select all in the box, paste.
    // Called on the UI thread (the clipboard needs it). -> "replaced", "gone" or "work".
    public static string Replace(string text)
    {
        if (typedBox == null || typedWindow == IntPtr.Zero || DateTime.Now - typedAt > KeepFor) return "gone";
        if (Work.IsMatch(typedApp)) return "work";
        string before = null;
        try { if (Clipboard.ContainsText()) before = Clipboard.GetText(); } catch (Exception) { }
        try
        {
            SetForegroundWindow(typedWindow);
            Thread.Sleep(250);
            // Keys go to whatever is in front: never press them anywhere else.
            if (GetForegroundWindow() != typedWindow) return "not in front";
            var worker = new Thread(() => { try { typedBox.SetFocus(); } catch (Exception) { } }) { IsBackground = true };
            worker.SetApartmentState(ApartmentState.MTA);
            worker.Start();
            worker.Join(2000);
            Clipboard.SetText(text);
            Thread.Sleep(80);
            Press(0x11, 0x41); // Ctrl+A: everything in the box
            Thread.Sleep(80);
            Press(0x11, 0x56); // Ctrl+V
            Thread.Sleep(300);
        }
        catch (Exception) { return "gone"; }
        try { if (before != null) Clipboard.SetText(before); else Clipboard.Clear(); } catch (Exception) { }
        typedAt = DateTime.Now;
        return "replaced";
    }

    static void Press(byte modifier, byte key)
    {
        keybd_event(modifier, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 0, UIntPtr.Zero);
        keybd_event(key, 0, 2, UIntPtr.Zero);
        keybd_event(modifier, 0, 2, UIntPtr.Zero);
    }
}
