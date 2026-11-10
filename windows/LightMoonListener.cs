// LightMoon Listener for Windows: hears "LightMoon" while LightMoon is closed or in the background, and brings it
// up ready to talk. A browser can't listen for a page that is closed or minimized, so this small program does it,
// with Windows' own offline speech recognizer (nothing is recorded or sent anywhere).
//   - LightMoon minimized or behind other windows: brought to the front, then Space (LightMoon's "tap to talk").
//   - LightMoon not open: opened in its Edge app window with ?action=talk, which starts listening.
//   - LightMoon already in front: left alone (you're talking to it, or it's saying its own name).
// It lives in the tray (pause, open LightMoon, show or hide the orb, quit) and starts with Windows. Its desktop orb
// shows the next reminder and answers it (DesktopOrb.cs). Build: windows/build.sh.
// Written for the C# 5 compiler that comes with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.Drawing;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Speech.Recognition;
using System.Speech.Synthesis;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class LightMoonListener
{
    const string AppUrl = "https://rajeshpasalapudi1815-cyber.github.io/lightmoon/?action=talk";
    const string WindowTitle = "LightMoon";
    const float WakeConfidence = 0.72f;      // the "light moon" phrase itself (0.80 missed Indian-English speakers)
    const float NearMiss = 0.40f;            // below the bar but worth a line in the log, to tune it
    const int RestartAfterQuietMinutes = 20; // no speech at all for this long: start the recognizer afresh
    const float DictationConfidence = 0.60f; // "light moon" heard inside other speech
    static readonly Regex Name = new Regex(@"\blight\s*moon\b", RegexOptions.IgnoreCase);

    // Its own folder (%USERPROFILE%\LightMoon): the log and the "talk" shortcut live next to the program.
    static readonly string Folder = Path.GetDirectoryName(Application.ExecutablePath);
    static readonly string LogFile = Path.Combine(Folder, "listener.log");
    // The user's own wake word ("sunshine"), set in LightMoon on the phone and passed on by LightMoon here.
    static readonly string OwnWakeFile = Path.Combine(Folder, "own-wake.txt");
    static string ownWake = "";
    static DateTime lastSound = DateTime.Now;
    static System.Windows.Forms.Timer watchdog;

    static SpeechRecognitionEngine engine;
    static NotifyIcon tray;
    static ToolStripMenuItem listenItem, orbItem;
    static DesktopOrb orb;
    static OrbBridge bridge;
    static bool paused;
    static bool pausedByLock; // paused because Windows was locked: listening again on unlock
    static DateTime lastWake = DateTime.MinValue;
    static SynchronizationContext ui;

    [STAThread]
    static void Main(string[] args)
    {
        Directory.CreateDirectory(Folder);
        try { ownWake = Tidy(File.ReadAllText(OwnWakeFile)); } catch { }
        if (args.Length > 0 && args[0] == "--self-test") { Environment.Exit(SelfTest()); return; }
        if (args.Length > 0 && args[0] == "--wake") { Wake(); return; } // as if "LightMoon" had been heard (for testing)
        bool voice = Array.IndexOf(args, "--no-voice") < 0; // just the orb (a test copy beside the real Listener)

        bool first;
        using (new Mutex(true, MutexName(), out first))
        {
            if (!first) return; // already running
            SetProcessDPIAware(); // the orb's text sharp on large-text screens
            Application.EnableVisualStyles();
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            Log("starting");
            MakeTray();
            orb = new DesktopOrb(Folder, Wake, ShowTrayMenu, Log);
            bridge = new OrbBridge(orb, ui, Log);
            bridge.OnWakePhrase = SetOwnWake;
            bridge.OnListen = on => { if (listenItem.Enabled) { pausedByLock = false; listenItem.Checked = on; Log(on ? "wake word turned on by voice" : "wake word turned off by voice"); } };
            bridge.Start();
            ScreenReader.WatchNotifications(Log);
            TrayMode.Start(Folder, FindLightMoon, Log);
            try { ownWake = Tidy(File.ReadAllText(OwnWakeFile)); } catch { }
            if (voice)
            {
                StartListening();
                // Windows' recognizer can go deaf after sleep or a microphone change, without saying so.
                Microsoft.Win32.SystemEvents.PowerModeChanged += (s, e) =>
                {
                    if (e.Mode == Microsoft.Win32.PowerModes.Resume) ui.Post(_ => { Log("woke from sleep: listening afresh"); Restart(); }, null);
                };
                // Locked (Windows key + L, or the screen locking by itself): nobody can wake LightMoon until it's
                // unlocked, so someone at the desk can't have it read out their messages.
                Microsoft.Win32.SystemEvents.SessionSwitch += (s, e) =>
                {
                    if (e.Reason == Microsoft.Win32.SessionSwitchReason.SessionLock)
                        ui.Post(_ => { if (listenItem.Checked) { pausedByLock = true; listenItem.Checked = false; Log("Windows locked: wake word paused"); } }, null);
                    else if (e.Reason == Microsoft.Win32.SessionSwitchReason.SessionUnlock)
                        ui.Post(_ => { if (pausedByLock) { pausedByLock = false; listenItem.Checked = true; Log("Windows unlocked: listening again"); } }, null);
                };
                watchdog = new System.Windows.Forms.Timer { Interval = 60000 };
                watchdog.Tick += (s, e) =>
                {
                    if (paused || (DateTime.Now - lastSound).TotalMinutes < RestartAfterQuietMinutes) return;
                    Log("nothing heard for a while: listening afresh");
                    Restart();
                };
                watchdog.Start();
            }
            else { listenItem.Checked = false; listenItem.Enabled = false; tray.Text = "LightMoon Listener: orb only"; }
            Application.Run();
            bridge.Stop();
            orb.Save();
            if (engine != null) engine.Dispose();
            tray.Visible = false;
        }
    }

    static void Restart()
    {
        lastSound = DateTime.Now;
        if (engine != null)
        {
            try { engine.RecognizeAsyncCancel(); } catch { }
            try { engine.Dispose(); } catch { }
            engine = null;
        }
        StartListening();
    }

    // "Sun Shine!" -> "sun shine", or "" if it isn't one to four plain words.
    static string Tidy(string phrase)
    {
        string text = Regex.Replace(Regex.Replace((phrase ?? "").ToLowerInvariant().Replace("lightmoon", "light moon"), "[^a-z ]", " "), @"\s+", " ").Trim();
        int words = text.Length == 0 ? 0 : text.Split(' ').Length;
        return words >= 1 && words <= 4 && text.Length >= 3 ? text : "";
    }

    // LightMoon passed on the user's own wake word: keep it and listen for it too.
    static void SetOwnWake(string phrase)
    {
        string tidy = Tidy(phrase);
        if (tidy == ownWake) return;
        ownWake = tidy;
        try { File.WriteAllText(OwnWakeFile, ownWake); } catch { }
        Log(ownWake.Length > 0 ? "own wake word: \"" + ownWake + "\"" : "own wake word removed");
        if (engine != null) Restart();
    }

    static string[] WakePhrases()
    {
        var phrases = new List<string> { "light moon", "hey light moon", "okay light moon", "hi light moon" };
        if (ownWake.Length > 0 && !phrases.Contains(ownWake)) phrases.Add(ownWake);
        return phrases.ToArray();
    }

    static void StartListening()
    {
        try
        {
            engine = MakeEngine();
            Log("recognizer ready");
            engine.SetInputToDefaultAudioDevice();
            Log("microphone ready");
            engine.RecognizeAsync(RecognizeMode.Multiple);
            Log("listening");
        }
        catch (Exception err)
        {
            Log("can't listen: " + err.Message);
            tray.Text = "LightMoon Listener: no microphone";
            tray.ShowBalloonTip(5000, "LightMoon Listener", "No microphone to listen with. Check Windows Settings → Privacy → Microphone.", ToolTipIcon.Warning);
        }
    }

    // One Listener at a time. A copy built into another folder (windows/build.sh <folder>) is a separate one, so it
    // can be tried out beside the real one.
    static string MutexName()
    {
        string home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "LightMoon");
        if (string.Equals(Folder.TrimEnd('\\'), home, StringComparison.OrdinalIgnoreCase)) return "LightMoonListener";
        return "LightMoonListener " + Folder.Replace('\\', '/');
    }

    // The wake phrase as its own small grammar, plus free dictation so other speech is matched there instead of
    // being forced onto "light moon" (fewer false wakes).
    static SpeechRecognitionEngine MakeEngine()
    {
        var recognizer = new SpeechRecognitionEngine(new CultureInfo("en-US"));
        var wake = new Grammar(new GrammarBuilder(new Choices(WakePhrases())));
        wake.Name = "wake";
        recognizer.LoadGrammar(wake);
        var dictation = new DictationGrammar();
        dictation.Name = "dictation";
        dictation.Weight = 0.3f;
        recognizer.LoadGrammar(dictation);
        recognizer.SpeechDetected += (sender, e) => lastSound = DateTime.Now;
        recognizer.SpeechRecognized += (sender, e) =>
        {
            if (!paused && !IsWake(e.Result) && e.Result.Grammar != null && e.Result.Grammar.Name == "wake" && e.Result.Confidence >= NearMiss)
                Log(string.Format("near miss \"{0}\" ({1:0.00})", e.Result.Text, e.Result.Confidence));
            if (paused || !IsWake(e.Result)) return;
            Log(string.Format("heard \"{0}\" ({1:0.00}, {2})", e.Result.Text, e.Result.Confidence, e.Result.Grammar.Name));
            string said = AfterWakePhrase(e.Result.Text);
            ui.Post(_ => Wake(said), null);
        };
        return recognizer;
    }

    static bool IsWake(RecognitionResult result)
    {
        if (result == null || result.Grammar == null) return false;
        if (result.Grammar.Name == "wake") return result.Confidence >= WakeConfidence;
        if (ownWake.Length > 0 && Regex.IsMatch(result.Text, @"\b" + Regex.Escape(ownWake).Replace("\\ ", @"\s*") + @"\b", RegexOptions.IgnoreCase)
            && result.Confidence >= DictationConfidence) return true;
        return Name.IsMatch(result.Text) && result.Confidence >= DictationConfidence;
    }

    // ---------- Waking LightMoon ----------

    // What was said straight after the wake phrase in one breath ("LightMoon, WhatsApp wife I'm on my way"), or "".
    static string AfterWakePhrase(string text)
    {
        string heard = text ?? "";
        int end = -1;
        var name = Name.Match(heard);
        if (name.Success) end = name.Index + name.Length;
        if (ownWake.Length > 0)
        {
            var own = Regex.Match(heard, Regex.Escape(ownWake).Replace("\\ ", @"\s*"), RegexOptions.IgnoreCase);
            if (own.Success) end = Math.Max(end, own.Index + own.Length);
        }
        return end < 0 ? "" : heard.Substring(end).Trim(' ', ',', '.', '!', '?');
    }

    static void Wake() { Wake(""); }

    static void Wake(string said)
    {
        if ((DateTime.Now - lastWake).TotalSeconds < 4) return; // one wake per call
        lastWake = DateTime.Now;
        DesktopApps.Remember(); // the box they were typing in, for "improve this" (before LightMoon comes to the front)
        // Kept in the tray: it listens where it is, with the dot at the top of the screen (TrayMode.cs).
        if (TrayMode.On && TrayMode.Wake(OpenLightMoon, said)) return;
        IntPtr window = FindLightMoon();
        // Sent to the background ("go to the background"): woken, it comes back on screen.
        if (window != IntPtr.Zero && TrayMode.IsHidden(window)) TrayMode.ShowWindow();
        if (window != IntPtr.Zero && GetForegroundWindow() == window) { Log("LightMoon is in front: left alone"); return; }
        if (window == IntPtr.Zero) { Log("opening LightMoon"); OpenLightMoon(); return; }
        if (IsIconic(window)) ShowWindow(window, SW_RESTORE);
        BringToFront(window);
        Thread.Sleep(400); // the page becomes visible before it can take the key
        // Space only if LightMoon really is in front: otherwise it would land in whatever you're using.
        if (GetForegroundWindow() != window) { Log("Windows kept another window in front: LightMoon shown, Space not pressed"); return; }
        PressSpace();
        Log("brought LightMoon to the front and pressed Space");
    }

    // Through Explorer and a shortcut next to this program ("LightMoon talk.lnk": Edge, --app=...?action=talk), so
    // Edge opens LightMoon with the user's own profile whatever started this program.
    static void OpenLightMoon()
    {
        string talk = Path.Combine(Folder, "LightMoon talk.lnk");
        string edge = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), @"Microsoft\Edge\Application\msedge.exe");
        if (File.Exists(talk)) Process.Start("explorer.exe", "\"" + talk + "\"");
        else if (File.Exists(edge)) Process.Start(edge, "--app=" + AppUrl);
        else Process.Start(AppUrl);
    }

    // LightMoon's own app window (Edge or Chrome: their windows are all of this class), not a browser tab.
    static IntPtr FindLightMoon()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((h, p) =>
        {
            if (!IsWindowVisible(h)) return true;
            var title = new StringBuilder(256);
            GetWindowText(h, title, title.Capacity);
            var kind = new StringBuilder(64);
            GetClassName(h, kind, kind.Capacity);
            if (title.ToString() == WindowTitle && kind.ToString() == "Chrome_WidgetWin_1") { found = h; return false; }
            return true;
        }, IntPtr.Zero);
        return found;
    }

    // Windows only lets the program in front give the focus away; a quick Alt press counts as the user's input.
    static void BringToFront(IntPtr window)
    {
        keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
        SetForegroundWindow(window);
    }

    static void PressSpace()
    {
        keybd_event(VK_SPACE, 0, 0, UIntPtr.Zero);
        keybd_event(VK_SPACE, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
    }

    // ---------- The tray icon ----------

    static void MakeTray()
    {
        var menu = new ContextMenuStrip();
        listenItem = new ToolStripMenuItem("Listening for \"LightMoon\"") { Checked = true, CheckOnClick = true };
        listenItem.CheckedChanged += (s, e) =>
        {
            paused = !listenItem.Checked;
            tray.Text = paused ? "LightMoon Listener: paused" : "LightMoon Listener: say \"LightMoon\"";
            Log(paused ? "paused" : "listening again");
        };
        menu.Items.Add(listenItem);
        menu.Items.Add("Show or hide LightMoon", null, (s, e) => TrayMode.Toggle(OpenLightMoon));
        var trayItem = new ToolStripMenuItem("Keep LightMoon in the tray") { CheckOnClick = true };
        trayItem.CheckedChanged += (s, e) => TrayMode.SetOn(trayItem.Checked);
        menu.Opening += (s, e) => trayItem.Checked = TrayMode.On;
        menu.Items.Add(trayItem);
        orbItem = new ToolStripMenuItem("Hide the orb", null, (s, e) => orb.OrbShown = !orb.OrbShown);
        menu.Items.Add(orbItem);
        menu.Opening += (s, e) => orbItem.Text = orb.OrbShown ? "Hide the orb" : "Show the orb";
        menu.Items.Add(new ToolStripSeparator());
        // Quitting never leaves LightMoon running out of sight: its window comes back on screen first.
        menu.Items.Add("Quit", null, (s, e) => { TrayMode.ReleaseWindow(); Application.Exit(); });
        tray = new NotifyIcon
        {
            Icon = AppIcon(),
            Text = "LightMoon Listener: say \"LightMoon\"",
            ContextMenuStrip = menu,
            Visible = true,
        };
        // A click shows LightMoon, or puts it away again (the menu is on the right button).
        tray.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) TrayMode.Toggle(OpenLightMoon); };
    }

    // The tray menu at the pointer, the way the tray icon opens it (so it closes when you click elsewhere).
    static void ShowTrayMenu()
    {
        var show = typeof(NotifyIcon).GetMethod("ShowContextMenu", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        if (show != null) show.Invoke(tray, null);
        else tray.ContextMenuStrip.Show(Cursor.Position);
    }

    static Icon AppIcon()
    {
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; }
    }

    // ---------- Self-test (no microphone): Windows' own voice says phrases into a file, the recognizer checks them ----------

    static int SelfTest()
    {
        var shouldWake = new List<string> { "LightMoon", "Hey LightMoon", "Light moon, what's on my list today?" };
        if (ownWake.Length > 0) shouldWake.Add(ownWake);
        string[] shouldNot = { "I like the moonlight tonight", "Turn on the light please", "What a lovely evening" };
        int wrong = 0;
        foreach (var phrase in shouldWake) if (!Heard(phrase)) { wrong++; Log("self-test MISSED: " + phrase); }
        foreach (var phrase in shouldNot) if (Heard(phrase)) { wrong++; Log("self-test FALSE WAKE: " + phrase); }
        Log(string.Format("self-test done: {0} of {1} right", shouldWake.Count + shouldNot.Length - wrong, shouldWake.Count + shouldNot.Length));
        return wrong;
    }

    static bool Heard(string phrase)
    {
        string wav = Path.Combine(Path.GetTempPath(), "lightmoon-selftest.wav");
        using (var voice = new SpeechSynthesizer()) { voice.SetOutputToWaveFile(wav); voice.Speak(phrase); }
        bool woke = false;
        using (var recognizer = MakeTestEngine())
        {
            recognizer.SetInputToWaveFile(wav);
            while (true)
            {
                RecognitionResult result;
                try { result = recognizer.Recognize(); }
                catch (InvalidOperationException) { break; } // the end of the recording
                if (result == null) break;
                Log(string.Format("self-test \"{0}\" -> \"{1}\" ({2:0.00}, {3})", phrase, result.Text, result.Confidence, result.Grammar.Name));
                if (IsWake(result)) woke = true;
            }
        }
        File.Delete(wav);
        return woke;
    }

    static SpeechRecognitionEngine MakeTestEngine()
    {
        var recognizer = new SpeechRecognitionEngine(new CultureInfo("en-US"));
        var wake = new Grammar(new GrammarBuilder(new Choices(WakePhrases())));
        wake.Name = "wake";
        recognizer.LoadGrammar(wake);
        var dictation = new DictationGrammar();
        dictation.Name = "dictation";
        dictation.Weight = 0.3f;
        recognizer.LoadGrammar(dictation);
        return recognizer;
    }

    // ---------- A short log (what was heard and done; never any audio), kept under 100 KB ----------

    static void Log(string line)
    {
        try
        {
            if (File.Exists(LogFile) && new FileInfo(LogFile).Length > 100000) File.Delete(LogFile);
            File.AppendAllText(LogFile, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss ") + line + Environment.NewLine);
        }
        catch { }
    }

    // ---------- Windows ----------

    delegate bool EnumWindowsProc(IntPtr window, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    const int SW_RESTORE = 9;
    const byte VK_MENU = 0x12, VK_SPACE = 0x20;
    const uint KEYEVENTF_KEYUP = 0x2;
}
