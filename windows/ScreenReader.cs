// What LightMoon can read on this computer, the way a screen reader does (Windows UI Automation), when the user asks
// ("read my latest Teams message", "any new email?", "read my notifications"):
//   Read(app)        the text showing in an open window of that app (Teams, Outlook, WhatsApp, a browser...)
//   Notifications()  Windows notifications that popped up since the Listener started (the last 40)
// Only what is on screen or popped up; nothing is clicked, typed or kept on disk. The LightMoon app asks over the
// Listener's bridge (DesktopOrb.cs: GET /read, GET /notifications), which only LightMoon's own pages may use.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Automation;

static class ScreenReader
{
    const int MaxChars = 24000; // a Teams window lists its chats first and the open conversation after: room for both

    [System.Runtime.InteropServices.DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int how);
    const int SW_SHOWNOACTIVATE = 4, SW_MINIMIZE = 6;
    const int MaxNodes = 6000;
    const int KeepNotifications = 40;

    // What they call an app → words in its window title.
    static readonly Dictionary<string, string[]> Titles = new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
    {
        { "teams", new[] { "Microsoft Teams", "| Teams", "Teams" } },
        { "outlook", new[] { "Outlook" } },
        { "email", new[] { "Outlook", "Mail", "Gmail" } },
        { "mail", new[] { "Outlook", "Mail", "Gmail" } },
        { "gmail", new[] { "Gmail" } },
        { "whatsapp", new[] { "WhatsApp" } },
        { "browser", new[] { "Microsoft Edge", "Google Chrome", "Firefox" } },
        { "edge", new[] { "Microsoft Edge" } },
        { "chrome", new[] { "Google Chrome" } },
    };

    // -> { found, window, text } or { found: false, windows: [titles of open windows] }.
    public static Dictionary<string, object> Read(string app)
    {
        Dictionary<string, object> answer = null;
        var worker = new Thread(() => answer = ReadNow(app ?? "")) { IsBackground = true };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        if (!worker.Join(12000)) return new Dictionary<string, object> { { "found", false }, { "error", "That window took too long to read." } };
        return answer;
    }

    static Dictionary<string, object> ReadNow(string app)
    {
        // "Read my screen": the window in front, under LightMoon's own.
        if (new[] { "screen", "front", "window", "this" }.Contains(app.Trim().ToLowerInvariant()))
        {
            var front = FrontWindow();
            if (front == null) return new Dictionary<string, object> { { "found", false }, { "error", "No window is open in front." } };
            return new Dictionary<string, object> { { "found", true }, { "window", front.Name }, { "minimized", false }, { "text", TextOf(front.Element) } };
        }
        string[] wanted;
        if (!Titles.TryGetValue(app.Trim(), out wanted)) wanted = new[] { app.Trim() };
        var windows = TopWindows();
        // LightMoon's own window never counts (its title is "LightMoon").
        var match = windows.Where(w => !w.Name.StartsWith("LightMoon", StringComparison.OrdinalIgnoreCase))
            .FirstOrDefault(w => wanted.Any(t => w.Name.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0));
        if (match == null)
        {
            return new Dictionary<string, object> { { "found", false }, { "windows", windows.Select(w => w.Name).Where(n => n.Length > 0).Distinct().Take(25).ToArray() } };
        }
        bool minimized = false;
        try
        {
            object pattern;
            if (match.Element.TryGetCurrentPattern(WindowPattern.Pattern, out pattern))
                minimized = ((WindowPattern)pattern).Current.WindowVisualState == WindowVisualState.Minimized;
        }
        catch (Exception) { }
        string text = TextOf(match.Element);
        // Some apps (Outlook) show nothing while minimized: open it without taking the focus, read, and minimize it again.
        if (text.Length == 0 && minimized)
        {
            var handle = new IntPtr(match.Element.Current.NativeWindowHandle);
            try
            {
                ShowWindow(handle, SW_SHOWNOACTIVATE);
                Thread.Sleep(1000);
                text = TextOf(match.Element);
            }
            catch (Exception) { }
            finally
            {
                ShowWindow(handle, SW_MINIMIZE); // UI Automation's own "minimize" is ignored by the new Outlook
            }
        }
        return new Dictionary<string, object> { { "found", true }, { "window", match.Name }, { "minimized", minimized }, { "text", text } };
    }

    class Window { public string Name; public AutomationElement Element; }

    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint how);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)]
    static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    const uint GW_HWNDNEXT = 2;

    // The window in front, going down the stack past LightMoon's own, the taskbar and untitled or hidden windows.
    static Window FrontWindow()
    {
        for (IntPtr handle = GetForegroundWindow(); handle != IntPtr.Zero; handle = GetWindow(handle, GW_HWNDNEXT))
        {
            if (!IsWindowVisible(handle) || IsIconic(handle)) continue;
            var title = new StringBuilder(512);
            GetWindowText(handle, title, title.Capacity);
            string name = title.ToString().Replace("​", "");
            if (name.Length == 0 || name.StartsWith("LightMoon", StringComparison.OrdinalIgnoreCase) || name == "Program Manager") continue;
            try { return new Window { Name = name, Element = AutomationElement.FromHandle(handle) }; }
            catch (Exception) { }
        }
        return null;
    }

    static List<Window> TopWindows()
    {
        var found = new List<Window>();
        foreach (AutomationElement element in AutomationElement.RootElement.FindAll(TreeScope.Children, Condition.TrueCondition))
        {
            // Edge writes "Microsoft​ Edge" in its titles: without the invisible space, so "Edge" matches.
            try { found.Add(new Window { Name = (element.Current.Name ?? "").Replace("​", ""), Element = element }); }
            catch (Exception) { } // closed meanwhile
        }
        return found;
    }

    // The words showing in a window, in reading order: texts, list items, links and edit boxes; not buttons or menus.
    static string TextOf(AutomationElement root)
    {
        var lines = new List<string>();
        var seen = new HashSet<string>();
        int chars = 0, nodes = 0;
        var walker = TreeWalker.ControlViewWalker;
        var stack = new Stack<AutomationElement>();
        stack.Push(root);
        while (stack.Count > 0 && nodes < MaxNodes && chars < MaxChars)
        {
            var element = stack.Pop();
            nodes++;
            try
            {
                var type = element.Current.ControlType;
                if (type == ControlType.Text || type == ControlType.ListItem || type == ControlType.DataItem
                    || type == ControlType.Hyperlink || type == ControlType.Edit || type == ControlType.TreeItem || type == ControlType.Document)
                {
                    string name = (element.Current.Name ?? "").Trim();
                    if (name.Length > 1 && seen.Add(name))
                    {
                        lines.Add(name);
                        chars += name.Length + 1;
                    }
                }
                // Children pushed last-first so they come out in order.
                var children = new List<AutomationElement>();
                for (var child = walker.GetFirstChild(element); child != null && children.Count < 400; child = walker.GetNextSibling(child)) children.Add(child);
                for (int i = children.Count - 1; i >= 0; i--) stack.Push(children[i]);
            }
            catch (Exception) { } // the element went away while reading
        }
        var all = string.Join("\n", lines);
        return all.Length > MaxChars ? all.Substring(0, MaxChars) : all;
    }

    // ---------- Pressing Send on a draft LightMoon wrote ----------

    // "Send it" after LightMoon opened a draft in Teams or Outlook: in that app's window, only if the draft's first
    // words are in it, press its Send button (UI Automation, the way a screen reader would). Tries for a few
    // seconds while the app finishes opening. -> "sent", "no window", "no draft" or "no send button".
    public static string PressSend(string app, string text)
    {
        string result = "no window";
        var worker = new Thread(() =>
        {
            string[] titles;
            if (!Titles.TryGetValue(app ?? "", out titles)) titles = new[] { app ?? "" };
            string start = (text ?? "").Trim();
            if (start.Length > 24) start = start.Substring(0, 24);
            for (int attempt = 0; attempt < 8; attempt++)
            {
                var window = TopWindows().FirstOrDefault(w => !w.Name.StartsWith("LightMoon", StringComparison.OrdinalIgnoreCase)
                    && titles.Any(t => w.Name.IndexOf(t, StringComparison.OrdinalIgnoreCase) >= 0));
                if (window != null)
                {
                    result = TryPressSend(window.Element, start);
                    if (result == "sent") return;
                }
                Thread.Sleep(1000);
            }
        }) { IsBackground = true };
        worker.SetApartmentState(ApartmentState.MTA);
        worker.Start();
        worker.Join(12000);
        return result;
    }

    static string TryPressSend(AutomationElement window, string start)
    {
        bool hasDraft = start.Length == 0;
        AutomationElement send = null;
        foreach (AutomationElement element in window.FindAll(TreeScope.Descendants, Condition.TrueCondition))
        {
            try
            {
                var type = element.Current.ControlType;
                string name = element.Current.Name ?? "";
                if (type == ControlType.Button && send == null && Regex.IsMatch(name, @"^Send\b", RegexOptions.IgnoreCase) && element.Current.IsEnabled) send = element;
                if (!hasDraft && (type == ControlType.Edit || type == ControlType.Document || type == ControlType.Text))
                {
                    if (name.IndexOf(start, StringComparison.OrdinalIgnoreCase) >= 0) hasDraft = true;
                    object pattern;
                    if (!hasDraft && element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern)
                        && (((ValuePattern)pattern).Current.Value ?? "").IndexOf(start, StringComparison.OrdinalIgnoreCase) >= 0) hasDraft = true;
                    if (!hasDraft && element.TryGetCurrentPattern(TextPattern.Pattern, out pattern)
                        && (((TextPattern)pattern).DocumentRange.GetText(2000) ?? "").IndexOf(start, StringComparison.OrdinalIgnoreCase) >= 0) hasDraft = true;
                }
            }
            catch (Exception) { } // the element went away
        }
        if (!hasDraft) return "no draft";
        if (send == null) return "no send button";
        try
        {
            object invoke;
            if (!send.TryGetCurrentPattern(InvokePattern.Pattern, out invoke)) return "no send button";
            ((InvokePattern)invoke).Invoke();
            return "sent";
        }
        catch (Exception) { return "no send button"; }
    }

    // ---------- Notifications ----------

    static readonly List<Dictionary<string, object>> notifications = new List<Dictionary<string, object>>();
    static string lastToast = "";

    // Watches for Windows' notification pop-ups ("New notification") and keeps their words.
    public static void WatchNotifications(Action<string> log)
    {
        var thread = new Thread(() =>
        {
            try
            {
                Automation.AddAutomationEventHandler(WindowPattern.WindowOpenedEvent, AutomationElement.RootElement, TreeScope.Subtree, (sender, e) =>
                {
                    try
                    {
                        var element = sender as AutomationElement;
                        if (element == null) return;
                        string name = element.Current.Name ?? "";
                        string cls = element.Current.ClassName ?? "";
                        if (name.IndexOf("notification", StringComparison.OrdinalIgnoreCase) < 0 && cls.IndexOf("Toast", StringComparison.OrdinalIgnoreCase) < 0) return;
                        Thread.Sleep(400); // its words arrive a moment after the window
                        Keep(TextOf(element));
                    }
                    catch (Exception) { }
                });
                log("screen: watching Windows notifications");
            }
            catch (Exception err)
            {
                log("screen: can't watch notifications: " + err.Message);
            }
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
    }

    static void Keep(string text)
    {
        text = (text ?? "").Trim();
        if (text.Length < 2 || text == lastToast) return;
        lastToast = text;
        lock (notifications)
        {
            notifications.Add(new Dictionary<string, object> { { "at", (long)(DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds }, { "text", text.Length > 600 ? text.Substring(0, 600) : text } });
            if (notifications.Count > KeepNotifications) notifications.RemoveAt(0);
        }
    }

    // Windows' own store first (everything in the notification centre, oldest first); what the watcher caught if it
    // can't be read.
    public static List<Dictionary<string, object>> Notifications()
    {
        var stored = NotificationStore.Recent(KeepNotifications);
        if (stored.Count > 0)
        {
            stored.Reverse();
            return stored;
        }
        lock (notifications) return notifications.ToList();
    }
}
