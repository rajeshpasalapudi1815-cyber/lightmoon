// LightMoon kept in the tray: its window stays out of sight (off the screen and off the taskbar and Alt+Tab) while
// the page keeps running, and "LightMoon" wakes it there instead of bringing it to the front. While it listens,
// thinks or speaks, a thin line glows along the top of the screen (EdgeGlow), so it is clear LightMoon is at work
// without showing anything else. Clicking the tray icon shows or hides the window.
//
// The page and the Listener talk over the bridge (DesktopOrb.cs): the page waits on GET /events for a wake, posts
// what it is doing (POST /state), and asks for its window when it needs the user (POST /show: its lock screen).
// Browsers let a page speak only after a key press in it, so a page that hasn't had one (just opened, or reloaded
// for an update) gets one F13 press, a key nothing uses, while it is shown for a moment.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

static class TrayMode
{
    static string settingFile;
    static Action<string> log;
    static Func<IntPtr> findWindow;
    static EdgeGlow glow;
    static SynchronizationContext ui; // the glow is a window: changed on the UI thread only

    // What the page last said: "idle", "listening", "thinking", "speaking"; whether it has had a key press.
    static volatile string pageState = "unknown";
    static volatile bool pageActivated;
    static DateTime pageSeen = DateTime.MinValue;
    static readonly ManualResetEvent wakeWaiting = new ManualResetEvent(false);
    static volatile bool wakePending;

    // Where the window was before it was put out of sight, to show it there again.
    static readonly Dictionary<IntPtr, Rectangle> placeOf = new Dictionary<IntPtr, Rectangle>();
    static readonly HashSet<IntPtr> hidden = new HashSet<IntPtr>();
    static IntPtr shownByUser = IntPtr.Zero; // opened from the tray: stays until they put it away

    public static bool On { get; private set; }

    public static void Start(string folder, Func<IntPtr> find, Action<string> logger)
    {
        settingFile = Path.Combine(folder, "tray-only.txt");
        findWindow = find;
        log = logger;
        On = !File.Exists(settingFile) || File.ReadAllText(settingFile).Trim() != "off"; // on unless switched off
        glow = new EdgeGlow();
        ui = SynchronizationContext.Current;
        var keeper = new System.Windows.Forms.Timer { Interval = 3000 };
        keeper.Tick += (s, e) => Keep();
        keeper.Start();
    }

    public static void SetOn(bool on)
    {
        On = on;
        try { File.WriteAllText(settingFile, on ? "on" : "off"); } catch (Exception) { }
        IntPtr window = findWindow();
        if (window == IntPtr.Zero) return;
        if (on) Hide(window);
        else Show(window, false);
        log(on ? "tray mode: LightMoon kept in the tray" : "tray mode off: LightMoon shown as a window");
    }

    // Every few seconds: a LightMoon window that turned up (opened, or Edge put it back) goes out of sight again.
    static void Keep()
    {
        if (!On) return;
        IntPtr window = findWindow();
        if (window != IntPtr.Zero && window != shownByUser && !hidden.Contains(window) && GetForegroundWindow() != window) Hide(window);
        if (pageState != "idle" && pageState != "unknown" && DateTime.Now - pageSeen > TimeSpan.FromSeconds(90)) { pageState = "idle"; glow.Hide(); } // the page went away
    }

    // The tray icon was clicked: show LightMoon if it's out of sight, else put it away.
    public static void Toggle(Action open)
    {
        IntPtr window = findWindow();
        if (window == IntPtr.Zero) { open(); return; }
        if (hidden.Contains(window))
        {
            Show(window, true);
            shownByUser = window;
        }
        else if (On)
        {
            shownByUser = IntPtr.Zero;
            Hide(window);
        }
    }

    // "LightMoon" heard. -> true when the page was told (it listens where it is); false: wake it the usual way.
    public static bool Wake(Action open)
    {
        IntPtr window = findWindow();
        if (window == IntPtr.Zero)
        {
            open(); // opened by the wake word, it listens straight away; Keep() puts it away after
            return true;
        }
        if (DateTime.Now - pageSeen > TimeSpan.FromSeconds(60))
        {
            // The page isn't talking to us (an older version, or still loading): the usual wake, with the window where it can be seen.
            log("tray mode: LightMoon page not connected, showing it");
            Show(window, false);
            shownByUser = window;
            return false;
        }
        if (!pageActivated) Prime(window);
        if (ui != null) ui.Post(_ => glow.Show("listening"), null); // heard on the recogniser's thread
        wakePending = true;
        wakeWaiting.Set();
        log("tray mode: told LightMoon to listen");
        return true;
    }

    // GET /events: waits up to 20 s for a wake. -> true if one came.
    static DateTime eventsLogged = DateTime.MinValue;

    public static bool WaitForWake()
    {
        if (DateTime.Now - eventsLogged > TimeSpan.FromMinutes(5))
        {
            eventsLogged = DateTime.Now;
            log("tray mode: LightMoon page is waiting for wakes");
        }
        if (!wakePending) wakeWaiting.WaitOne(20000);
        if (!wakePending) return false;
        wakePending = false;
        wakeWaiting.Reset();
        return true;
    }

    // POST /state from the page.
    public static void SetPageState(string state, bool activated)
    {
        if (DateTime.Now - pageSeen > TimeSpan.FromSeconds(60)) log("tray mode: LightMoon page connected (" + state + (activated ? ", may speak" : ", needs a key press to speak") + ")");
        pageSeen = DateTime.Now;
        pageActivated = activated;
        pageState = state ?? "idle";
        if (pageState == "listening" || pageState == "thinking" || pageState == "speaking") glow.Show(pageState);
        else glow.Hide();
    }

    // POST /show: the page needs the user (its lock screen).
    public static void ShowWindow()
    {
        IntPtr window = findWindow();
        if (window == IntPtr.Zero) return;
        Show(window, true);
        shownByUser = window; // until they put it away
    }

    // ---------- Out of sight and back ----------

    static void Hide(IntPtr window)
    {
        RECT r;
        if (GetWindowRect(window, out r) && r.Left > -10000) placeOf[window] = new Rectangle(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
        if (IsIconic(window)) ShowWindowNative(window, SW_SHOWNOACTIVATE); // minimized pages stop more than off-screen ones
        int style = GetWindowLong(window, GWL_EXSTYLE);
        SetWindowLong(window, GWL_EXSTYLE, (style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW); // no taskbar button, no Alt+Tab
        SetWindowPos(window, IntPtr.Zero, -32000, -32000, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
        hidden.Add(window);
    }

    static void Show(IntPtr window, bool front)
    {
        int style = GetWindowLong(window, GWL_EXSTYLE);
        SetWindowLong(window, GWL_EXSTYLE, (style & ~WS_EX_TOOLWINDOW) | WS_EX_APPWINDOW);
        Rectangle place;
        if (!placeOf.TryGetValue(window, out place)) place = new Rectangle(200, 120, 1000, 760);
        SetWindowPos(window, IntPtr.Zero, place.X, place.Y, place.Width, place.Height, SWP_NOZORDER);
        hidden.Remove(window);
        if (front)
        {
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            SetForegroundWindow(window);
        }
    }

    // One F13 press in the page so it may speak (shown for under a second, then out of sight again).
    static void Prime(IntPtr window)
    {
        IntPtr was = GetForegroundWindow();
        Show(window, true);
        Thread.Sleep(450);
        if (GetForegroundWindow() == window)
        {
            keybd_event(VK_F13, 0, 0, UIntPtr.Zero);
            keybd_event(VK_F13, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            Thread.Sleep(150);
            pageActivated = true;
        }
        Hide(window);
        if (was != IntPtr.Zero) SetForegroundWindow(was); // back to what they were using
        log("tray mode: gave LightMoon its key press");
    }

    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "ShowWindow")] static extern bool ShowWindowNative(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, SW_SHOWNOACTIVATE = 4;
    const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, KEYEVENTF_KEYUP = 2;
    const byte VK_MENU = 0x12, VK_F13 = 0x7C;
}

// A thin line along the top of the screen while LightMoon works: blue listening, violet thinking, teal speaking,
// gently breathing. It never takes clicks or the focus, and isn't in the taskbar.
class EdgeGlow : Form
{
    const int Height_ = 3;
    readonly System.Windows.Forms.Timer breathe = new System.Windows.Forms.Timer { Interval = 50 };
    Color color = Color.DeepSkyBlue;
    double phase;

    public EdgeGlow()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Color.Black;
        var screen = Screen.PrimaryScreen.Bounds;
        Bounds = new Rectangle(screen.Left, screen.Top, screen.Width, Height_);
        breathe.Tick += (s, e) =>
        {
            phase += 0.12;
            Opacity = 0.55 + 0.35 * Math.Sin(phase);
            Invalidate();
        };
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var p = base.CreateParams;
            p.ExStyle |= 0x80 | 0x20 | 0x8000000 | 0x8; // tool window, click-through, no activate, topmost
            return p;
        }
    }

    public void Show(string state)
    {
        color = state == "thinking" ? Color.MediumPurple : state == "speaking" ? Color.MediumAquamarine : Color.DeepSkyBlue;
        var screen = Screen.PrimaryScreen.Bounds;
        Bounds = new Rectangle(screen.Left, screen.Top, screen.Width, Height_);
        if (!Visible) base.Show();
        breathe.Start();
        Invalidate();
    }

    public new void Hide()
    {
        breathe.Stop();
        if (Visible) base.Hide();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        // Brightest in the middle: a glow rather than a flat bar.
        using (var brush = new LinearGradientBrush(ClientRectangle, Color.Black, Color.Black, LinearGradientMode.Horizontal))
        {
            var blend = new ColorBlend
            {
                Colors = new[] { color, Color.White, color },
                Positions = new[] { 0f, 0.5f, 1f },
            };
            brush.InterpolationColors = blend;
            e.Graphics.FillRectangle(brush, ClientRectangle);
        }
    }
}
