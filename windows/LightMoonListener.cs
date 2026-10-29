// LightMoon Listener for Windows: hears "LightMoon" while LightMoon is closed or in the background, and brings it
// up ready to talk. A browser can't listen for a page that is closed or minimized, so this small program does it,
// with Windows' own offline speech recognizer (nothing is recorded or sent anywhere).
//   - LightMoon minimized or behind other windows: brought to the front, then Space (LightMoon's "tap to talk").
//   - LightMoon not open: opened in its Edge app window with ?action=talk, which starts listening.
//   - LightMoon already in front: left alone (you're talking to it, or it's saying its own name).
// It lives in the tray (pause, open LightMoon, quit) and starts with Windows. Build: windows/build.sh.
// Written for the C# 5 compiler that comes with Windows (.NET Framework 4).
using System;
using System.Diagnostics;
using System.Drawing;
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
    const float WakeConfidence = 0.80f;      // the "light moon" phrase itself
    const float DictationConfidence = 0.60f; // "light moon" heard inside other speech
    static readonly Regex Name = new Regex(@"\blight\s*moon\b", RegexOptions.IgnoreCase);

    // Its own folder (%USERPROFILE%\LightMoon): the log and the "talk" shortcut live next to the program.
    static readonly string Folder = Path.GetDirectoryName(Application.ExecutablePath);
    static readonly string LogFile = Path.Combine(Folder, "listener.log");

    static SpeechRecognitionEngine engine;
    static NotifyIcon tray;
    static ToolStripMenuItem listenItem;
    static bool paused;
    static DateTime lastWake = DateTime.MinValue;
    static SynchronizationContext ui;

    [STAThread]
    static void Main(string[] args)
    {
        Directory.CreateDirectory(Folder);
        if (args.Length > 0 && args[0] == "--self-test") { Environment.Exit(SelfTest()); return; }
        if (args.Length > 0 && args[0] == "--wake") { Wake(); return; } // as if "LightMoon" had been heard (for testing)

        bool first;
        using (new Mutex(true, "LightMoonListener", out first))
        {
            if (!first) return; // already running
            Application.EnableVisualStyles();
            ui = new WindowsFormsSynchronizationContext();
            SynchronizationContext.SetSynchronizationContext(ui);
            Log("starting");
            MakeTray();
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
            Application.Run();
            if (engine != null) engine.Dispose();
            tray.Visible = false;
        }
    }

    // The wake phrase as its own small grammar, plus free dictation so other speech is matched there instead of
    // being forced onto "light moon" (fewer false wakes).
    static SpeechRecognitionEngine MakeEngine()
    {
        var recognizer = new SpeechRecognitionEngine(new CultureInfo("en-US"));
        var wake = new Grammar(new GrammarBuilder(new Choices("light moon", "hey light moon", "okay light moon", "hi light moon")));
        wake.Name = "wake";
        recognizer.LoadGrammar(wake);
        var dictation = new DictationGrammar();
        dictation.Name = "dictation";
        dictation.Weight = 0.3f;
        recognizer.LoadGrammar(dictation);
        recognizer.SpeechRecognized += (sender, e) =>
        {
            if (paused || !IsWake(e.Result)) return;
            Log(string.Format("heard \"{0}\" ({1:0.00}, {2})", e.Result.Text, e.Result.Confidence, e.Result.Grammar.Name));
            ui.Post(_ => Wake(), null);
        };
        return recognizer;
    }

    static bool IsWake(RecognitionResult result)
    {
        if (result == null || result.Grammar == null) return false;
        if (result.Grammar.Name == "wake") return result.Confidence >= WakeConfidence;
        return Name.IsMatch(result.Text) && result.Confidence >= DictationConfidence;
    }

    // ---------- Waking LightMoon ----------

    static void Wake()
    {
        if ((DateTime.Now - lastWake).TotalSeconds < 4) return; // one wake per call
        lastWake = DateTime.Now;
        IntPtr window = FindLightMoon();
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
        menu.Items.Add("Open LightMoon", null, (s, e) => Wake());
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quit", null, (s, e) => Application.Exit());
        tray = new NotifyIcon
        {
            Icon = AppIcon(),
            Text = "LightMoon Listener: say \"LightMoon\"",
            ContextMenuStrip = menu,
            Visible = true,
        };
        tray.DoubleClick += (s, e) => Wake();
    }

    static Icon AppIcon()
    {
        try { return Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { return SystemIcons.Application; }
    }

    // ---------- Self-test (no microphone): Windows' own voice says phrases into a file, the recognizer checks them ----------

    static int SelfTest()
    {
        string[] shouldWake = { "LightMoon", "Hey LightMoon", "Light moon, what's on my list today?" };
        string[] shouldNot = { "I like the moonlight tonight", "Turn on the light please", "What a lovely evening" };
        int wrong = 0;
        foreach (var phrase in shouldWake) if (!Heard(phrase)) { wrong++; Log("self-test MISSED: " + phrase); }
        foreach (var phrase in shouldNot) if (Heard(phrase)) { wrong++; Log("self-test FALSE WAKE: " + phrase); }
        Log(string.Format("self-test done: {0} of {1} right", shouldWake.Length + shouldNot.Length - wrong, shouldWake.Length + shouldNot.Length));
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
        var wake = new Grammar(new GrammarBuilder(new Choices("light moon", "hey light moon", "okay light moon", "hi light moon")));
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
    const int SW_RESTORE = 9;
    const byte VK_MENU = 0x12, VK_SPACE = 0x20;
    const uint KEYEVENTF_KEYUP = 0x2;
}
