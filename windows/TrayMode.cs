// LightMoon kept in the tray: its window stays out of sight (off the screen and off the taskbar and Alt+Tab) while
// the page keeps running, and "LightMoon" wakes it there instead of bringing it to the front. While it listens,
// thinks or speaks, a tiny eye opens at the top of the screen (TrayEye), so it is clear LightMoon is at work
// without showing anything else. Clicking the tray icon shows or hides the window.
//
// The page and the Listener talk over the bridge (DesktopOrb.cs): the page waits on GET /events for a wake, posts
// what it is doing (POST /state), and asks for its window when it needs the user (POST /show: its lock screen).
// Browsers let a page speak only after a key press in it, so a page that hasn't had one (just opened, or reloaded
// for an update) gets one F13 press, a key nothing uses, while it is shown for a moment.
// The volume-down key stops LightMoon while it speaks (GET /events answers { stop }; the key is kept from Windows then,
// so the volume stays as it was). GET /busy says whether another app (Teams, WhatsApp, a browser call) has the
// microphone, so the page keeps scheduled things quiet during a call.
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
    static TrayEye glow;
    static SynchronizationContext ui; // the glow is a window: changed on the UI thread only

    // What the page last said: "idle", "listening", "thinking", "speaking"; whether it has had a key press.
    static volatile string pageState = "unknown";
    static volatile bool pageActivated;
    static DateTime pageSeen = DateTime.MinValue;
    static readonly ManualResetEvent wakeWaiting = new ManualResetEvent(false);
    static volatile bool wakePending;
    static volatile bool stopPending;
    delegate IntPtr KeyHook(int code, IntPtr message, IntPtr data);
    static KeyHook keyHook; // kept, so it isn't collected while Windows still calls it
    static IntPtr keyHookHandle = IntPtr.Zero;
    const int VolumeDown = 0xAE;

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
        // Off unless switched on in the tray menu: LightMoon shows itself when woken, and hides only when asked
        // ("go to the background", HideNow).
        On = File.Exists(settingFile) && File.ReadAllText(settingFile).Trim() == "on";
        glow = new TrayEye();
        ui = SynchronizationContext.Current;
        var keeper = new System.Windows.Forms.Timer { Interval = 3000 };
        keeper.Tick += (s, e) => Keep();
        keeper.Start();
        keyHook = KeyPressed;
        keyHookHandle = SetWindowsHookEx(13, keyHook, GetModuleHandle(null), 0); // WH_KEYBOARD_LL
        if (keyHookHandle == IntPtr.Zero) log("volume-down stop: couldn't watch the keyboard");
    }

    // Every key press goes through here (quickly: Windows gives up on a slow hook). Volume down while LightMoon is
    // speaking: it stops, and the key goes no further.
    static IntPtr KeyPressed(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0 && Marshal.ReadInt32(data) == VolumeDown && pageState == "speaking" && DateTime.Now - pageSeen < TimeSpan.FromSeconds(90))
        {
            int kind = message.ToInt32();
            if (kind == 0x100 || kind == 0x104) // key down
            {
                pageState = "idle"; // until the page says otherwise; the next press turns the volume down again
                stopPending = true;
                wakeWaiting.Set();
                log("volume down: LightMoon told to stop speaking");
                if (ui != null) ui.Post(_ => glow.Hide(), null);
            }
            return (IntPtr)1;
        }
        return CallNextHookEx(keyHookHandle, code, message, data);
    }

    // Who else has the microphone now (a call in Teams, WhatsApp, Zoom or a browser), or "" if nobody. Windows notes
    // each app's microphone use in the registry: LastUsedTimeStop is 0 while it is still using it. LightMoon's own
    // listening doesn't count (the Listener, or Edge while the page is listening).
    public static string MicrophoneUser()
    {
        const string store = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";
        try
        {
            using (var root = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(store))
            {
                if (root == null) return "";
                foreach (string name in root.GetSubKeyNames())
                {
                    if (name == "NonPackaged")
                    {
                        using (var desktop = root.OpenSubKey(name))
                            if (desktop != null)
                                foreach (string app in desktop.GetSubKeyNames())
                                {
                                    string found = InUse(desktop, app);
                                    if (found != "") return found;
                                }
                        continue;
                    }
                    string user = InUse(root, name);
                    if (user != "") return user;
                }
            }
        }
        catch (Exception) { }
        return "";
    }

    static string InUse(Microsoft.Win32.RegistryKey parent, string name)
    {
        using (var key = parent.OpenSubKey(name))
        {
            if (key == null) return "";
            object start = key.GetValue("LastUsedTimeStart"), stop = key.GetValue("LastUsedTimeStop");
            if (start == null || stop == null || Convert.ToInt64(start) == 0 || Convert.ToInt64(stop) != 0) return "";
        }
        string app = name.Contains("#") ? name.Substring(name.LastIndexOf('#') + 1) : name.Split('_')[0];
        if (app.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)) app = app.Substring(0, app.Length - 4);
        string lower = app.ToLowerInvariant();
        if (lower.Contains("lightmoon")) return "";
        if ((lower == "msedge" || lower.Contains("edge")) && pageState == "listening") return "";
        if (lower.Contains("teams")) return "Teams";
        if (lower.Contains("whatsapp")) return "WhatsApp";
        if (lower.Contains("zoom")) return "Zoom";
        if (lower == "msedge") return "Edge";
        if (lower == "chrome") return "Chrome";
        return app;
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
    static volatile string saidWithWake = "";

    public static bool Wake(Action open, string said = "")
    {
        IntPtr window = findWindow();
        if (window == IntPtr.Zero)
        {
            open(); // opened by the wake word, it listens straight away; Keep() puts it away after
            return true;
        }
        if (DateTime.Now - pageSeen > TimeSpan.FromSeconds(180))
        {
            // The page isn't talking to us (an older version, or still loading): the usual wake, with the window where it can be seen.
            log("tray mode: LightMoon page not connected, showing it");
            Show(window, false);
            shownByUser = window;
            return false;
        }
        if (!pageActivated) Prime(window);
        if (ui != null) ui.Post(_ => glow.Show("listening"), null); // heard on the recogniser's thread
        saidWithWake = said ?? "";
        wakePending = true;
        wakeWaiting.Set();
        log("tray mode: told LightMoon to listen");
        return true;
    }

    // GET /events: waits up to 20 s for a wake. -> true if one came.
    static DateTime eventsLogged = DateTime.MinValue;

    // What was said with the wake phrase, taken once (GET /events passes it on).
    public static string TakeSaid()
    {
        string said = saidWithWake;
        saidWithWake = "";
        return said;
    }

    // GET /events: "wake", "stop" (volume down while speaking), or null after 20 s of nothing.
    public static string WaitForEvent()
    {
        pageSeen = DateTime.Now;
        if (!wakePending && !stopPending) wakeWaiting.WaitOne(20000);
        if (stopPending)
        {
            stopPending = false;
            if (!wakePending) wakeWaiting.Reset();
            return "stop";
        }
        if (!wakePending) return null;
        wakePending = false;
        wakeWaiting.Reset();
        return "wake";
    }

    public static bool WaitForWake()
    {
        pageSeen = DateTime.Now; // waiting here means the page is alive (hidden pages post their state only now and then)
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
    static string lastProblem = "";

    public static void SetPageState(string state, bool activated, string problem = "")
    {
        if (!string.IsNullOrEmpty(problem) && problem != lastProblem) log("LightMoon page: " + problem);
        lastProblem = problem ?? "";
        if (state != pageState && pageState != "unknown") log("LightMoon: " + state);
        if (DateTime.Now - pageSeen > TimeSpan.FromSeconds(180)) log("tray mode: LightMoon page connected (" + state + (activated ? ", may speak" : ", needs a key press to speak") + ")");
        pageSeen = DateTime.Now;
        pageActivated = activated;
        pageState = state ?? "idle";
        // The eye only while LightMoon is out of sight: on screen, it shows what it is doing itself.
        IntPtr window = findWindow();
        bool unseen = window != IntPtr.Zero && hidden.Contains(window);
        if (unseen && (pageState == "listening" || pageState == "thinking" || pageState == "speaking")) glow.Show(pageState);
        else glow.Hide();
    }

    // POST /hide: "go to the background". Out of sight until the wake word or "show yourself".
    public static void HideNow()
    {
        IntPtr window = findWindow();
        if (window == IntPtr.Zero) return;
        shownByUser = IntPtr.Zero;
        Hide(window);
        log("LightMoon went to the background");
    }

    // Whether LightMoon's window is out of sight (so a wake shows it again).
    public static bool IsHidden(IntPtr window) { return hidden.Contains(window); }

    // POST /show: the page needs the user (its lock screen).
    public static void ShowWindow()
    {
        IntPtr window = findWindow();
        if (window == IntPtr.Zero) return;
        Show(window, true);
        shownByUser = window; // until they put it away
    }

    // The Listener is quitting (or tray mode switched off): LightMoon's window back on screen, in the taskbar,
    // so nothing keeps running where it can't be seen or closed.
    public static void ReleaseWindow()
    {
        IntPtr window = findWindow == null ? IntPtr.Zero : findWindow();
        if (window != IntPtr.Zero && hidden.Contains(window)) Show(window, false);
        if (glow != null) glow.Hide();
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
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int id, KeyHook hook, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    const int GWL_EXSTYLE = -20, WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000, SW_SHOWNOACTIVATE = 4;
    const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, KEYEVENTF_KEYUP = 2;
    const byte VK_MENU = 0x12, VK_F13 = 0x7C;
}

// A tiny eye at the top centre of the screen while LightMoon works out of sight. It opens when LightMoon wakes,
// blinks now and then, and shows what it is doing: amber and wide open while listening, violet and glancing about
// while thinking, cool blue with a pulsing iris while speaking; it closes again before going away. Drawn with soft
// edges on a see-through window (a layered window) that never takes clicks or the focus, and isn't in the taskbar.
class TrayEye : Form
{
    const int W = 46, H = 30;   // the window: the eye and its glow
    const int FromTop = 4;
    readonly System.Windows.Forms.Timer tick = new System.Windows.Forms.Timer { Interval = 33 };
    readonly Random random = new Random();
    string state = "listening";
    bool closing;
    double open, look, lookTo, pulse, t;
    DateTime blinkAt = DateTime.Now.AddSeconds(2), blinkStart = DateTime.MinValue, glanceAt = DateTime.MinValue;

    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr hwnd, IntPtr hdcDst, ref Point pptDst, ref Size psize, IntPtr hdcSrc, ref Point pprSrc, int crKey, ref Blend pblend, int dwFlags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr hDC);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr hdc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr hDC, IntPtr hObject);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr hObject);
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct Blend { public byte Op, Flags, Alpha, Format; }

    public TrayEye()
    {
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Place();
        tick.Tick += (s, e) => Step();
    }

    void Place()
    {
        var screen = Screen.PrimaryScreen.Bounds;
        Bounds = new Rectangle(screen.Left + (screen.Width - W) / 2, screen.Top + FromTop, W, H);
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override CreateParams CreateParams
    {
        get
        {
            var p = base.CreateParams;
            p.ExStyle |= 0x80 | 0x20 | 0x8000000 | 0x8 | 0x80000; // tool window, click-through, no activate, topmost, layered
            return p;
        }
    }

    public void Show(string newState)
    {
        state = newState;
        closing = false;
        Place();
        if (!Visible) { open = 0; base.Show(); }
        tick.Start();
    }

    // Closes the eye, then goes.
    public new void Hide()
    {
        if (Visible) closing = true;
    }

    static Color Tint(string state)
    {
        if (state == "listening") return Color.FromArgb(255, 181, 71);
        if (state == "thinking") return Color.FromArgb(178, 140, 255);
        return Color.FromArgb(63, 216, 255);
    }

    void Step()
    {
        t += 0.033;
        var now = DateTime.Now;
        double want = closing ? 0 : state == "listening" ? 1.05 : state == "thinking" ? 0.7 : 0.92;
        open += (want - open) * 0.22;
        if (closing && open < 0.04) { tick.Stop(); closing = false; base.Hide(); return; }
        // A blink every few seconds: down and up in about a quarter of a second.
        double shut = 0;
        if (!closing && now > blinkAt) { blinkStart = now; blinkAt = now.AddMilliseconds(2600 + random.Next(3200)); }
        double since = (now - blinkStart).TotalMilliseconds;
        if (since < 90) shut = since / 90; else if (since < 250) shut = 1 - (since - 90) / 160;
        // Thinking: glances from side to side; listening: looks at you; otherwise a small drift.
        if (now > glanceAt)
        {
            lookTo = state == "thinking" ? (lookTo > 0 ? -0.8 : 0.8) : state == "listening" ? 0 : (random.NextDouble() - 0.5) * 0.6;
            glanceAt = now.AddMilliseconds(state == "thinking" ? 550 + random.Next(400) : 1500 + random.Next(2500));
        }
        look += (lookTo - look) * 0.35;
        pulse = state == "speaking" ? 0.5 + 0.5 * Math.Sin(t * 14 + Math.Sin(t * 5) * 2) : state == "listening" ? 0.5 + 0.5 * Math.Sin(t * 4) : 0;
        Draw(Math.Max(0, open * (1 - shut)));
    }

    void Draw(double lid)
    {
        using (var bmp = new Bitmap(W, H, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
        {
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = SmoothingMode.AntiAlias;
                g.Clear(Color.Transparent);
                Color c = Tint(state);
                float cx = W / 2f, cy = H / 2f, half = 17f, tall = (float)(7.5 * lid);
                float bend = 1.6f * (1 - (float)Math.Min(1, lid));
                using (var eye = new GraphicsPath())
                {
                    // Almond: two curves meeting at the corners; shut, both bend down into a closed lid.
                    float up = cy - 2 * (tall - bend), down = cy + 2 * (tall * 0.95f + bend);
                    eye.AddBezier(cx - half, cy, cx - half / 2, up, cx + half / 2, up, cx + half, cy);
                    eye.AddBezier(cx + half, cy, cx + half / 2, down, cx - half / 2, down, cx - half, cy);
                    for (int i = 3; i >= 1; i--) // the glow
                        using (var glowPen = new Pen(Color.FromArgb((int)(28 + 22 * pulse) / i, c), 2 + i * 2.2f)) g.DrawPath(glowPen, eye);
                    using (var glass = new SolidBrush(Color.FromArgb(240, 6, 12, 22))) g.FillPath(glass, eye);
                    var keep = g.Clip;
                    g.SetClip(eye);
                    float r = (float)(6.2 + (state == "listening" ? 0.8 : 0) + pulse * 0.7), ix = cx + (float)(look * 6);
                    using (var iris = new SolidBrush(c)) g.FillEllipse(iris, ix - r, cy - r, r * 2, r * 2);
                    using (var inner = new SolidBrush(Color.FromArgb(150, 255, 255, 255))) g.FillEllipse(inner, ix - r * 0.55f, cy - r * 0.55f, r * 1.1f, r * 1.1f);
                    float p = r * (state == "listening" ? 0.55f : 0.42f);
                    using (var pupil = new SolidBrush(Color.FromArgb(255, 2, 5, 10))) g.FillEllipse(pupil, ix - p, cy - p, p * 2, p * 2);
                    using (var shine = new SolidBrush(Color.White)) g.FillEllipse(shine, ix - r * 0.55f, cy - r * 0.6f, 2.2f, 2.2f);
                    g.Clip = keep;
                    using (var rim = new Pen(c, 1.4f)) g.DrawPath(rim, eye);
                }
            }
            PutOnScreen(bmp);
        }
    }

    // Puts the drawing on the screen with its see-through edges (a layered window).
    void PutOnScreen(Bitmap bmp)
    {
        IntPtr screen = GetDC(IntPtr.Zero), mem = CreateCompatibleDC(screen), hbmp = IntPtr.Zero, old = IntPtr.Zero;
        try
        {
            hbmp = bmp.GetHbitmap(Color.FromArgb(0));
            old = SelectObject(mem, hbmp);
            var size = new Size(bmp.Width, bmp.Height);
            var from = new Point(0, 0);
            var to = new Point(Left, Top);
            var blend = new Blend { Op = 0, Flags = 0, Alpha = 255, Format = 1 }; // AC_SRC_OVER, AC_SRC_ALPHA
            UpdateLayeredWindow(Handle, screen, ref to, ref size, mem, ref from, 0, ref blend, 2); // ULW_ALPHA
        }
        finally
        {
            ReleaseDC(IntPtr.Zero, screen);
            if (hbmp != IntPtr.Zero) { SelectObject(mem, old); DeleteObject(hbmp); }
            DeleteDC(mem);
        }
    }
}
