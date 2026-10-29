// LightMoon's desktop orb: a small moon that stays on top of other windows and shows the next reminder, e.g.
// "Take tablets · 9:30". When one goes off (or LightMoon checks in about it) the orb turns amber with Done and
// Snooze 10 min, so it can be answered without opening LightMoon. Clicking the orb wakes LightMoon to talk; drag it
// anywhere and it stays there. It steps aside while something is full screen (a film, a presentation).
// The LightMoon app tells the orb what's coming up and collects the answers through OrbBridge (below): a tiny web
// server on this computer only, because nothing outside the app can read it. What the orb knows is kept in orb.json
// next to the program, so it still shows the next reminder after a restart, before LightMoon is opened.
// Written for the C# 5 compiler that comes with Windows (.NET Framework 4), like LightMoonListener.cs.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Drawing.Text;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// A reminder (N = 0) or one of its check-ins (N = 1, 2, 3), as the app sends it. Check-in ids are the task's id
// plus "-c1", "-c2"... (parseAlertId in docs/js/announce.js).
class OrbAlert
{
    public string Id, TaskId, Title, Say;
    public int N;
    public long At; // ms since 1970, as in the app
}

// Done or Snooze pressed on the orb, waiting for the app to collect it.
class OrbAnswer
{
    public string Id, Action;
    public long At;
}

class DesktopOrb : Form
{
    public const long SnoozeMs = 10 * 60000;
    const long RecentMs = 30 * 60000; // the app sends what went off in the last half hour, and so the orb shows it
    const int MaxAlerts = 300;
    static readonly Regex AlertId = new Regex(@"^([a-z0-9]{1,40})(?:-c(\d{1,2}))?$");
    static readonly DateTime Epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static readonly StringFormat Typo = StringFormat.GenericTypographic;
    static readonly StringFormat Clipped = new StringFormat(StringFormat.GenericTypographic) { Trimming = StringTrimming.EllipsisCharacter, FormatFlags = StringFormatFlags.NoWrap };
    static readonly StringFormat Centered = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };

    // LightMoon's colours (docs/styles.css).
    static readonly Color Panel = Color.FromArgb(8, 18, 30), Shade = Color.FromArgb(16, 34, 52);
    static readonly Color Cyan = Color.FromArgb(63, 216, 255), Amber = Color.FromArgb(255, 181, 71);
    static readonly Color Ink = Color.FromArgb(214, 238, 248), Muted = Color.FromArgb(120, 150, 168);

    readonly string stateFile;
    readonly Action wake;
    readonly Action<string> log;
    readonly Action showMenu;
    readonly ToolTip tip = new ToolTip { InitialDelay = 600, AutoPopDelay = 15000, ShowAlways = true }; // the orb is never the active window
    readonly System.Windows.Forms.Timer clock = new System.Windows.Forms.Timer { Interval = 1000 };
    readonly System.Windows.Forms.Timer pulser = new System.Windows.Forms.Timer { Interval = 40 };
    readonly float scale;

    List<OrbAlert> alerts = new List<OrbAlert>();
    readonly List<OrbAnswer> answers = new List<OrbAnswer>();
    readonly Dictionary<string, long> rang = new Dictionary<string, long>();       // task -> when it last went off
    readonly Dictionary<string, long> quietUntil = new Dictionary<string, long>(); // task -> end of its snooze
    readonly HashSet<string> doneHere = new HashSet<string>();                    // Done pressed, not yet applied
    readonly HashSet<string> handedOver = new HashSet<string>();                  // answers the app has collected
    bool heardFromApp, shown = true;
    Point? home; // where the user put it
    Point placed; // where it is now
    long pulseUntil;

    View view = new View();
    string drawn = "";
    Rectangle doneButton, snoozeButton;
    string hover = "", pressed = "";
    Point pressAt, pressFrom;
    bool down, dragging;

    // What the orb shows. Empty Text: just the moon.
    class View
    {
        public string Text = "", When = "", Tip = "", AlertId = "", TaskId = "";
        public bool Ringing;
        public string Key { get { return string.Join("|", Text, When, Tip, AlertId, Ringing); } }
    }

    // `wake` brings LightMoon up to talk; `showMenu` opens the tray icon's menu (a right-click on the orb).
    public DesktopOrb(string folder, Action wake, Action showMenu, Action<string> log)
    {
        stateFile = Path.Combine(folder, "orb.json");
        this.wake = wake;
        this.showMenu = showMenu;
        this.log = log;
        using (var screen = Graphics.FromHwnd(IntPtr.Zero)) scale = screen.DpiX / 96f;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        Text = "LightMoon orb";
        Restore();
        clock.Tick += (s, e) => Tick();
        pulser.Tick += (s, e) => { if (Now() > pulseUntil) pulser.Stop(); Render(true); };
        Microsoft.Win32.SystemEvents.DisplaySettingsChanged += (s, e) => Render(true);
        clock.Start();
        Tick();
    }

    public bool OrbShown
    {
        get { return shown; }
        set
        {
            if (shown == value) return;
            shown = value;
            log(shown ? "orb shown" : "orb hidden");
            Save();
            Tick();
        }
    }

    // ---------- What the app sends and collects (on the UI thread, through OrbBridge) ----------

    // The app's upcoming alerts, replacing what it sent before.
    public void TakeAlerts(object list)
    {
        alerts = ParseAlerts(list);
        heardFromApp = true;
        // The app has applied the answers it collected, so its list now says what's left.
        foreach (var task in handedOver) { doneHere.Remove(task); quietUntil.Remove(task); }
        handedOver.Clear();
        var tasks = new HashSet<string>(alerts.Select(a => a.TaskId));
        foreach (var task in rang.Keys.Where(t => !tasks.Contains(t)).ToList()) rang.Remove(task);
        foreach (var task in quietUntil.Keys.Where(t => !tasks.Contains(t)).ToList()) quietUntil.Remove(task);
        doneHere.RemoveWhere(t => !tasks.Contains(t));
        Save();
        Tick();
    }

    // Done and Snooze pressed since the app last asked, each handed over once.
    public List<Dictionary<string, object>> TakeAnswers()
    {
        var taken = answers.Select(a => new Dictionary<string, object> { { "id", a.Id }, { "action", a.Action }, { "at", a.At } }).ToList();
        if (taken.Count == 0) return taken;
        foreach (var answer in answers) handedOver.Add(TaskOf(answer.Id));
        log(string.Format("orb: LightMoon collected {0} answer(s)", taken.Count));
        answers.Clear();
        Save();
        return taken;
    }

    public Dictionary<string, object> Status()
    {
        return new Dictionary<string, object>
        {
            { "shown", shown && Visible }, { "text", view.Text }, { "when", view.When }, { "ringing", view.Ringing },
            { "alerts", alerts.Count }, { "waitingToBeCollected", answers.Count },
        };
    }

    static List<OrbAlert> ParseAlerts(object list)
    {
        var parsed = new List<OrbAlert>();
        var items = list as object[] ?? (list is System.Collections.ArrayList ? ((System.Collections.ArrayList)list).ToArray() : null);
        if (items == null) throw new FormatException("expected a list of alerts");
        foreach (var item in items.Take(MaxAlerts))
        {
            var alert = item as Dictionary<string, object>;
            if (alert == null) continue;
            var id = Field(alert, "id");
            var match = AlertId.Match(id);
            object at;
            if (!match.Success || !alert.TryGetValue("at", out at) || at == null) continue;
            double ms;
            try { ms = Convert.ToDouble(at, CultureInfo.InvariantCulture); } catch { continue; }
            if (double.IsNaN(ms) || double.IsInfinity(ms)) continue;
            parsed.Add(new OrbAlert
            {
                Id = id, TaskId = match.Groups[1].Value, N = match.Groups[2].Success ? int.Parse(match.Groups[2].Value) : 0,
                Title = Clip(Field(alert, "title"), 120), Say = Clip(Field(alert, "say"), 400), At = (long)ms,
            });
        }
        return parsed;
    }

    static string Field(Dictionary<string, object> record, string name)
    {
        object value;
        return record.TryGetValue(name, out value) && value != null ? value.ToString().Trim() : "";
    }

    static string Clip(string text, int max) { return text.Length > max ? text.Substring(0, max) : text; }

    static string TaskOf(string alertId)
    {
        var match = AlertId.Match(alertId);
        return match.Success ? match.Groups[1].Value : alertId;
    }

    // ---------- Deciding what to show ----------

    // Once a second: note what has just gone off, then show the newest one waiting for an answer, or else the next
    // one coming up.
    void Tick()
    {
        long now = Now();
        bool newlyRang = false;
        foreach (var alert in alerts)
        {
            if (alert.At > now || alert.At <= now - RecentMs || doneHere.Contains(alert.TaskId)) continue;
            long quiet, was;
            if (quietUntil.TryGetValue(alert.TaskId, out quiet) && alert.At <= quiet) continue;
            if (rang.TryGetValue(alert.TaskId, out was) && was >= alert.At) continue;
            rang[alert.TaskId] = alert.At;
            newlyRang = true;
        }
        // Snoozed here: it goes off again when the snooze is over, whether or not LightMoon is open to move it.
        foreach (var snoozed in quietUntil.Where(q => q.Value <= now).ToList())
        {
            quietUntil.Remove(snoozed.Key);
            if (doneHere.Contains(snoozed.Key) || !alerts.Any(a => a.TaskId == snoozed.Key)) continue;
            rang[snoozed.Key] = snoozed.Value;
            newlyRang = true;
        }
        // It keeps waiting for an answer while more check-ins are to come, and for half an hour after the last one.
        foreach (var task in rang.Keys.ToList())
        {
            bool more = alerts.Any(a => a.TaskId == task && a.At > now);
            if (doneHere.Contains(task) || (!more && rang[task] <= now - RecentMs)) rang.Remove(task);
        }
        if (newlyRang)
        {
            pulseUntil = now + 60000;
            pulser.Start();
        }

        var tipWas = view.Tip;
        view = Decide(now);
        if (view.Tip != tipWas) tip.SetToolTip(this, view.Tip);
        bool visible = shown && !FullScreenAppRunning();
        if (visible && !Visible) { Show(); drawn = ""; }
        if (!visible && Visible) Hide();
        Render(false);
    }

    View Decide(long now)
    {
        var result = new View { Tip = heardFromApp ? "Nothing coming up. Click to talk to LightMoon." : "Open LightMoon once to see your reminders here. Click to talk to LightMoon." };
        var waiting = rang.Where(r => alerts.Any(a => a.TaskId == r.Key)).OrderByDescending(r => r.Value).Select(r => r.Key).ToList();
        if (waiting.Count > 0)
        {
            var task = waiting[0];
            var alert = alerts.Where(a => a.TaskId == task && a.At <= now).OrderByDescending(a => a.At).FirstOrDefault()
                ?? alerts.Where(a => a.TaskId == task).OrderBy(a => a.At).First();
            var main = alerts.FirstOrDefault(a => a.TaskId == task && a.N == 0);
            result.Ringing = true;
            result.TaskId = task;
            result.AlertId = alert.Id;
            result.Text = alert.Title.Length > 0 ? alert.Title : "Reminder";
            result.When = When(main != null && main.At <= now ? main.At : alert.At) + (waiting.Count > 1 ? string.Format(" · +{0} more", waiting.Count - 1) : "");
            result.Tip = (alert.Say.Length > 0 ? alert.Say + "\n" : "") + "Done or Snooze here, or click the orb to talk to LightMoon.";
            return result;
        }
        var upcoming = alerts.Where(a => a.At > now && !doneHere.Contains(a.TaskId) && !rang.ContainsKey(a.TaskId))
            .Where(a => { long quiet; return !quietUntil.TryGetValue(a.TaskId, out quiet) || a.At > quiet; })
            .Select(a => new { Alert = a, At = a.At }).ToList();
        // Snoozed here, before LightMoon has moved the reminder: it's next at the end of the snooze.
        foreach (var snoozed in quietUntil.Where(q => q.Value > now && !doneHere.Contains(q.Key)))
        {
            var alert = alerts.FirstOrDefault(a => a.TaskId == snoozed.Key);
            if (alert != null) upcoming.Add(new { Alert = alert, At = snoozed.Value });
        }
        var next = upcoming.OrderBy(u => u.At).FirstOrDefault();
        if (next != null)
        {
            result.TaskId = next.Alert.TaskId;
            result.AlertId = next.Alert.Id;
            result.Text = next.Alert.Title.Length > 0 ? next.Alert.Title : "Reminder";
            result.When = When(next.At);
            result.Tip = string.Format("Next: {0} at {1}.\nClick the orb to talk to LightMoon.", result.Text, result.When);
        }
        return result;
    }

    // "9:30" today (in this computer's time format), "tomorrow 9:30", "Sat 9:30", "12 Nov 9:30".
    static string When(long ms)
    {
        var at = Epoch.AddMilliseconds(ms).ToLocalTime();
        var time = at.ToString(CultureInfo.CurrentCulture.DateTimeFormat.ShortTimePattern);
        var days = (at.Date - DateTime.Today).Days;
        if (days == 0) return time;
        if (days == 1) return "tomorrow " + time;
        if (days > 1 && days < 7) return at.ToString("ddd ") + time;
        return at.ToString("d MMM ") + time;
    }

    static long Now() { return (long)(DateTime.UtcNow - Epoch).TotalMilliseconds; }

    // ---------- Done, Snooze, talk, drag ----------

    void Answer(string action)
    {
        if (!view.Ringing) return;
        long now = Now();
        answers.RemoveAll(a => TaskOf(a.Id) == view.TaskId);
        answers.Add(new OrbAnswer { Id = view.AlertId, Action = action, At = now });
        rang.Remove(view.TaskId);
        handedOver.Remove(view.TaskId);
        if (action == "done") doneHere.Add(view.TaskId);
        else quietUntil[view.TaskId] = now + SnoozeMs;
        log(string.Format("orb: {0} pressed for {1}", action, view.AlertId));
        Save();
        Tick();
    }

    protected override void OnMouseDown(MouseEventArgs e)
    {
        if (e.Button != MouseButtons.Left) return;
        down = true;
        dragging = false;
        pressed = HitTest(e.Location);
        pressAt = Cursor.Position;
        pressFrom = placed;
    }

    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (down)
        {
            var at = Cursor.Position;
            int dx = at.X - pressAt.X, dy = at.Y - pressAt.Y;
            if (!dragging && (Math.Abs(dx) > SystemInformation.DragSize.Width || Math.Abs(dy) > SystemInformation.DragSize.Height)) dragging = true;
            if (dragging)
            {
                home = new Point(pressFrom.X + dx, pressFrom.Y + dy);
                Render(true);
            }
            return;
        }
        var hit = HitTest(e.Location);
        if (hit == hover) return;
        hover = hit;
        Cursor = hit == "" ? Cursors.Default : Cursors.Hand;
        Render(true);
    }

    protected override void OnMouseLeave(EventArgs e)
    {
        if (hover == "") return;
        hover = "";
        Render(true);
    }

    protected override void OnMouseUp(MouseEventArgs e)
    {
        if (e.Button == MouseButtons.Right) { showMenu(); return; }
        if (e.Button != MouseButtons.Left || !down) return;
        down = false;
        if (dragging)
        {
            dragging = false;
            Render(true); // kept on the screen
            home = placed;
            Save();
            return;
        }
        var hit = HitTest(e.Location);
        if (hit != pressed) return;
        if (hit == "done") Answer("done");
        else if (hit == "snooze") Answer("snooze");
        else { log("orb clicked"); wake(); }
    }

    string HitTest(Point at)
    {
        if (view.Ringing && doneButton.Contains(at)) return "done";
        if (view.Ringing && snoozeButton.Contains(at)) return "snooze";
        return "";
    }

    // ---------- Drawing: a window with soft, see-through edges (a "layered" window) ----------

    int S(float px) { return (int)Math.Round(px * scale); }

    void Render(bool force)
    {
        if (!IsHandleCreated || !Visible) return;
        long now = Now();
        bool pulsing = now < pulseUntil;
        var key = view.Key + hover + (dragging ? "drag" : "");
        if (!force && !pulsing && key == drawn) return;
        drawn = key;
        float pulse = pulsing ? 0.5f + 0.5f * (float)Math.Sin(now / 1600.0 * 2 * Math.PI) : 0f;
        Color accent = view.Ringing ? Amber : Cyan;

        int margin = S(7), head = S(44);
        using (var titleFont = new Font("Segoe UI Semibold", 13 * scale, GraphicsUnit.Pixel))
        using (var smallFont = new Font("Segoe UI", 12 * scale, GraphicsUnit.Pixel))
        using (var buttonFont = new Font("Segoe UI Semibold", 12 * scale, GraphicsUnit.Pixel))
        using (var measure = new Bitmap(1, 1))
        using (var m = Graphics.FromImage(measure))
        {
            m.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
            var typo = Typo;
            bool hasText = view.Text.Length > 0;
            float titleW = hasText ? Math.Min(m.MeasureString(view.Text, titleFont, PointF.Empty, typo).Width + 2, S(210)) : 0;
            float whenW = hasText && view.When.Length > 0 ? m.MeasureString(view.When, smallFont, PointF.Empty, typo).Width + 2 : 0;
            float dotW = whenW > 0 ? m.MeasureString(" · ", smallFont, PointF.Empty, typo).Width + S(6) : 0;
            int width = hasText ? head + (int)Math.Ceiling(titleW + dotW + whenW) + S(18) : head;
            int height = head;
            float doneW = 0, snoozeW = 0;
            int buttonH = S(28), gap = S(8);
            if (view.Ringing)
            {
                doneW = m.MeasureString("Done", buttonFont, PointF.Empty, typo).Width + S(30);
                snoozeW = m.MeasureString("Snooze 10 min", buttonFont, PointF.Empty, typo).Width + S(26);
                width = Math.Max(width, head + (int)Math.Ceiling(doneW + gap + snoozeW) + S(14));
                height = head + buttonH + S(10);
            }

            var size = new Size(width + 2 * margin, height + 2 * margin);
            using (var bitmap = new Bitmap(size.Width, size.Height, PixelFormat.Format32bppArgb))
            {
                using (var g = Graphics.FromImage(bitmap))
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);
                    var body = new RectangleF(margin, margin, width, height);
                    float radius = head / 2f;

                    // A soft shadow, or a glow in the accent colour while a reminder waits for an answer.
                    for (int i = margin; i >= 1; i--)
                    {
                        int alpha = view.Ringing ? (int)(10 + 14 * pulse) : 7;
                        using (var path = Rounded(RectangleF.Inflate(body, i, i), radius + i))
                        using (var brush = new SolidBrush(Color.FromArgb(alpha, view.Ringing ? accent : Color.Black)))
                            g.FillPath(brush, path);
                    }
                    using (var path = Rounded(body, radius))
                    {
                        using (var brush = new SolidBrush(Color.FromArgb(246, Panel))) g.FillPath(brush, path);
                        int edge = view.Ringing ? (int)(150 + 100 * pulse) : hover == "" && !dragging ? 80 : 130;
                        using (var pen = new Pen(Color.FromArgb(edge, accent), Math.Max(1f, scale))) g.DrawPath(pen, path);
                    }

                    DrawMoon(g, new PointF(margin + radius, margin + radius), head, accent, pulse);

                    if (hasText)
                    {
                        float x = margin + head - S(2), y = margin + (head - titleFont.Height) / 2f;
                        using (var ink = new SolidBrush(Ink)) g.DrawString(view.Text, titleFont, ink, new RectangleF(x, y, titleW, titleFont.Height + S(2)), Clipped);
                        if (whenW > 0)
                        {
                            float sy = margin + (head - smallFont.Height) / 2f + S(1);
                            using (var muted = new SolidBrush(Muted)) g.DrawString("·", smallFont, muted, x + titleW + S(3), sy, typo);
                            using (var when = new SolidBrush(view.Ringing ? Amber : Muted)) g.DrawString(view.When, smallFont, when, x + titleW + dotW, sy, typo);
                        }
                    }

                    if (view.Ringing)
                    {
                        float bx = margin + head - S(2), by = margin + head - S(2);
                        doneButton = Rectangle.Round(new RectangleF(bx, by, doneW, buttonH));
                        snoozeButton = Rectangle.Round(new RectangleF(bx + doneW + gap, by, snoozeW, buttonH));
                        DrawButton(g, doneButton, "Done", buttonFont, Cyan, true, hover == "done");
                        DrawButton(g, snoozeButton, "Snooze 10 min", buttonFont, Muted, false, hover == "snooze");
                    }
                    else
                    {
                        doneButton = snoozeButton = Rectangle.Empty;
                    }
                }
                placed = Place(size);
                Blit(bitmap, placed);
            }
        }
    }

    // The LightMoon moon (docs/icons/icon.svg): a crescent inside a dashed ring, with a glow. The crescent is the
    // lit disc with a bite of the background colour taken out (drawn shapes have smooth edges; clipped ones don't).
    void DrawMoon(Graphics g, PointF center, int head, Color accent, float pulse)
    {
        float ring = head * 0.40f, disc = ring * 0.62f;
        var lit = new RectangleF(center.X - disc, center.Y - disc, 2 * disc, 2 * disc);
        bool amber = accent == Amber;
        using (var light = new LinearGradientBrush(lit, amber ? Color.FromArgb(255, 248, 232) : Color.FromArgb(239, 252, 255), amber ? Amber : Color.FromArgb(127, 228, 255), 0f))
            g.FillEllipse(light, lit);
        float r = disc * 0.86f, cx = center.X + disc * 0.45f, cy = center.Y - disc * 0.32f;
        using (var bite = new SolidBrush(Panel)) g.FillEllipse(bite, cx - r, cy - r, 2 * r, 2 * r);
        using (var dark = new SolidBrush(Color.FromArgb(28, accent))) g.FillEllipse(dark, lit);
        using (var halo = new GraphicsPath())
        {
            float glow = ring + S(2);
            halo.AddEllipse(center.X - glow, center.Y - glow, 2 * glow, 2 * glow);
            using (var brush = new PathGradientBrush(halo) { CenterColor = Color.FromArgb((int)(50 + 60 * pulse), accent), SurroundColors = new[] { Color.FromArgb(0, accent) } })
                g.FillPath(brush, halo);
        }
        using (var pen = new Pen(Color.FromArgb(170, accent), Math.Max(1.2f, 1.6f * scale)) { DashPattern = new[] { 3.2f, 1.2f } })
            g.DrawEllipse(pen, center.X - ring, center.Y - ring, 2 * ring, 2 * ring);
    }

    void DrawButton(Graphics g, Rectangle box, string label, Font font, Color color, bool primary, bool hovered)
    {
        using (var path = Rounded(box, box.Height / 2f))
        {
            int fill = primary ? (hovered ? 95 : 55) : (hovered ? 45 : 18);
            using (var brush = new SolidBrush(Color.FromArgb(fill, primary ? color : Ink))) g.FillPath(brush, path);
            using (var pen = new Pen(Color.FromArgb(hovered ? 230 : 160, color), Math.Max(1f, scale))) g.DrawPath(pen, path);
        }
        using (var ink = new SolidBrush(primary ? Color.White : Ink)) g.DrawString(label, font, ink, box, Centered);
    }

    static GraphicsPath Rounded(RectangleF box, float radius)
    {
        radius = Math.Min(radius, Math.Min(box.Width, box.Height) / 2f);
        float d = 2 * radius;
        var path = new GraphicsPath();
        path.AddArc(box.Left, box.Top, d, d, 180, 90);
        path.AddArc(box.Right - d, box.Top, d, d, 270, 90);
        path.AddArc(box.Right - d, box.Bottom - d, d, d, 0, 90);
        path.AddArc(box.Left, box.Bottom - d, d, d, 90, 90);
        path.CloseFigure();
        return path;
    }

    // Where the user put it, moved in just enough to fit on that screen when it's wider (showing a reminder).
    // Bottom right of the main screen until it's moved.
    Point Place(Size size)
    {
        var area = Screen.FromPoint(home ?? Point.Empty).WorkingArea;
        if (home == null) area = Screen.PrimaryScreen.WorkingArea;
        var at = home ?? new Point(area.Right - S(58) - S(18), area.Bottom - S(58) - S(18));
        if (dragging) return at;
        return new Point(Math.Max(area.Left, Math.Min(at.X, area.Right - size.Width)), Math.Max(area.Top, Math.Min(at.Y, area.Bottom - size.Height)));
    }

    void Blit(Bitmap bitmap, Point at)
    {
        IntPtr screen = GetDC(IntPtr.Zero), memory = CreateCompatibleDC(screen);
        IntPtr picture = bitmap.GetHbitmap(Color.FromArgb(0)), old = SelectObject(memory, picture);
        try
        {
            var size = new SIZE { cx = bitmap.Width, cy = bitmap.Height };
            var source = new POINT();
            var place = new POINT { x = at.X, y = at.Y };
            var blend = new BLENDFUNCTION { BlendOp = 0, BlendFlags = 0, SourceConstantAlpha = 255, AlphaFormat = 1 };
            UpdateLayeredWindow(Handle, screen, ref place, ref size, memory, ref source, 0, ref blend, ULW_ALPHA);
        }
        finally
        {
            SelectObject(memory, old);
            DeleteObject(picture);
            DeleteDC(memory);
            ReleaseDC(IntPtr.Zero, screen);
        }
    }

    // On top, out of the taskbar and Alt+Tab, and never taking the keyboard from what you're typing in.
    protected override CreateParams CreateParams
    {
        get
        {
            var settings = base.CreateParams;
            settings.ExStyle |= WS_EX_LAYERED | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TOPMOST;
            return settings;
        }
    }

    protected override bool ShowWithoutActivation { get { return true; } }

    protected override void WndProc(ref Message message)
    {
        if (message.Msg == WM_MOUSEACTIVATE) { message.Result = (IntPtr)MA_NOACTIVATE; return; }
        base.WndProc(ref message);
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Render(true);
    }

    // A film, game or presentation filling the screen.
    static bool FullScreenAppRunning()
    {
        int state;
        try { return SHQueryUserNotificationState(out state) == 0 && (state == 2 || state == 3 || state == 4); }
        catch { return false; }
    }

    // ---------- orb.json: where it is, whether it's shown, and the reminders and answers it holds ----------

    void Restore()
    {
        try
        {
            if (!File.Exists(stateFile)) return;
            var saved = Json.DeserializeObject(File.ReadAllText(stateFile)) as Dictionary<string, object>;
            if (saved == null) return;
            object value;
            if (saved.TryGetValue("shown", out value) && value is bool) shown = (bool)value;
            object x, y;
            if (saved.TryGetValue("x", out x) && saved.TryGetValue("y", out y) && x != null && y != null)
            {
                var at = new Point(Convert.ToInt32(x), Convert.ToInt32(y));
                if (Screen.AllScreens.Any(s => s.WorkingArea.Contains(at))) home = at;
            }
            if (saved.TryGetValue("alerts", out value) && value != null) { alerts = ParseAlerts(value); heardFromApp = true; }
            if (saved.TryGetValue("answers", out value) && value is object[])
            {
                foreach (var item in ((object[])value).OfType<Dictionary<string, object>>())
                {
                    var answer = new OrbAnswer { Id = Field(item, "id"), Action = Field(item, "action") };
                    long at;
                    if (!long.TryParse(Field(item, "at"), out at) || !AlertId.IsMatch(answer.Id)) continue;
                    answer.At = at;
                    answers.Add(answer);
                    if (answer.Action == "done") doneHere.Add(TaskOf(answer.Id));
                    else quietUntil[TaskOf(answer.Id)] = at + SnoozeMs;
                }
            }
        }
        catch (Exception err)
        {
            log("orb: couldn't read orb.json: " + err.Message);
        }
    }

    public void Save()
    {
        try
        {
            var saved = new Dictionary<string, object>
            {
                { "shown", shown },
                { "x", home.HasValue ? (object)home.Value.X : null },
                { "y", home.HasValue ? (object)home.Value.Y : null },
                { "alerts", alerts.Select(a => new Dictionary<string, object> { { "id", a.Id }, { "title", a.Title }, { "at", a.At }, { "say", a.Say } }).ToList() },
                { "answers", answers.Select(a => new Dictionary<string, object> { { "id", a.Id }, { "action", a.Action }, { "at", a.At } }).ToList() },
            };
            File.WriteAllText(stateFile, Json.Serialize(saved), Encoding.UTF8);
        }
        catch (Exception err)
        {
            log("orb: couldn't save orb.json: " + err.Message);
        }
    }

    // ---------- Windows ----------

    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
    [StructLayout(LayoutKind.Sequential, Pack = 1)] struct BLENDFUNCTION { public byte BlendOp, BlendFlags, SourceConstantAlpha, AlphaFormat; }
    [DllImport("user32.dll")] static extern bool UpdateLayeredWindow(IntPtr window, IntPtr screenDc, ref POINT place, ref SIZE size, IntPtr sourceDc, ref POINT source, int key, ref BLENDFUNCTION blend, int flags);
    [DllImport("user32.dll")] static extern IntPtr GetDC(IntPtr window);
    [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr window, IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
    [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr thing);
    [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr thing);
    [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
    const int WS_EX_LAYERED = 0x80000, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x8000000, WS_EX_TOPMOST = 0x8;
    const int ULW_ALPHA = 2, WM_MOUSEACTIVATE = 0x21, MA_NOACTIVATE = 3;
}

// The orb's side of the conversation with the LightMoon app, at http://127.0.0.1:47611 (this computer only):
//   POST /alerts   the app's upcoming reminders and check-ins: [{id, title, at, say}]
//   GET /answers   Done and Snooze pressed on the orb since the last time: [{id, action, at}], each once
//   GET /status    what the orb is showing (for testing)
// Only LightMoon's own pages may use it from a browser (CORS), including Chrome's and Edge's check for a public site
// reaching this computer (Private Network Access). A plain TcpListener, because Windows' HttpListener needs an
// administrator to reserve the address first.
class OrbBridge
{
    public const int Port = 47611;
    const int MaxBody = 512 * 1024;
    static readonly string[] Origins = { "https://rajeshpasalapudi1815-cyber.github.io", "http://localhost:3000", "http://127.0.0.1:3000" };
    static readonly string[] Hosts = { "127.0.0.1:" + Port, "localhost:" + Port };
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = MaxBody };

    readonly DesktopOrb orb;
    readonly SynchronizationContext ui;
    readonly Action<string> log;
    TcpListener server;

    public OrbBridge(DesktopOrb orb, SynchronizationContext ui, Action<string> log)
    {
        this.orb = orb;
        this.ui = ui;
        this.log = log;
    }

    public void Start()
    {
        try
        {
            server = new TcpListener(IPAddress.Loopback, Port) { ExclusiveAddressUse = true };
            server.Start();
        }
        catch (SocketException err)
        {
            log(string.Format("orb: can't take port {0} ({1}), so LightMoon can't reach the orb", Port, err.Message));
            server = null;
            return;
        }
        new Thread(Serve) { IsBackground = true, Name = "orb bridge" }.Start();
        log("orb: LightMoon can reach it at http://127.0.0.1:" + Port);
    }

    public void Stop()
    {
        if (server != null) server.Stop();
    }

    void Serve()
    {
        while (true)
        {
            TcpClient client;
            try { client = server.AcceptTcpClient(); }
            catch { return; } // stopped
            ThreadPool.QueueUserWorkItem(_ => Handle(client));
        }
    }

    void Handle(TcpClient client)
    {
        using (client)
        {
            try
            {
                client.ReceiveTimeout = 5000;
                client.SendTimeout = 5000;
                var stream = client.GetStream();
                string method, path;
                Dictionary<string, string> headers;
                byte[] body;
                int problem = Read(stream, out method, out path, out headers, out body);
                Answer(stream, problem, method, path, headers, body);
            }
            catch (Exception)
            {
                // The page went away mid-request: nothing to do.
            }
        }
    }

    // Reads one request. Returns 0, or the HTTP status to refuse it with.
    static int Read(NetworkStream stream, out string method, out string path, out Dictionary<string, string> headers, out byte[] body)
    {
        method = path = "";
        headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        body = new byte[0];
        var received = new MemoryStream();
        var chunk = new byte[8192];
        int end = -1;
        while (end < 0)
        {
            int count = stream.Read(chunk, 0, chunk.Length);
            if (count <= 0) return 400;
            received.Write(chunk, 0, count);
            end = HeadersEnd(received.GetBuffer(), (int)received.Length);
            if (end < 0 && received.Length > 16384) return 431;
        }
        var all = received.ToArray();
        var lines = Encoding.ASCII.GetString(all, 0, end).Split(new[] { "\r\n" }, StringSplitOptions.None);
        var first = lines[0].Split(' ');
        if (first.Length < 3) return 400;
        method = first[0].ToUpperInvariant();
        path = first[1].Split('?')[0];
        foreach (var line in lines.Skip(1))
        {
            int colon = line.IndexOf(':');
            if (colon > 0) headers[line.Substring(0, colon).Trim()] = line.Substring(colon + 1).Trim();
        }
        string lengthText;
        int length = 0;
        if (headers.TryGetValue("Content-Length", out lengthText) && (!int.TryParse(lengthText, out length) || length < 0)) return 400;
        if (length > MaxBody) return 413;
        int start = end + 4;
        var content = new MemoryStream();
        content.Write(all, start, Math.Min(all.Length - start, length));
        while (content.Length < length)
        {
            int count = stream.Read(chunk, 0, (int)Math.Min(chunk.Length, length - content.Length));
            if (count <= 0) return 400;
            content.Write(chunk, 0, count);
        }
        body = content.ToArray();
        return 0;
    }

    static int HeadersEnd(byte[] data, int length)
    {
        for (int i = 0; i + 3 < length; i++)
            if (data[i] == '\r' && data[i + 1] == '\n' && data[i + 2] == '\r' && data[i + 3] == '\n') return i;
        return -1;
    }

    void Answer(NetworkStream stream, int problem, string method, string path, Dictionary<string, string> headers, byte[] body)
    {
        if (problem != 0) { Send(stream, problem, null, null, false); return; }
        string origin, host;
        headers.TryGetValue("Origin", out origin);
        headers.TryGetValue("Host", out host);
        // Another website (or one pretending to be this computer) may not use it.
        if (host == null || !Hosts.Contains(host.ToLowerInvariant())) { Send(stream, 403, null, null, false); return; }
        if (origin != null && !Origins.Contains(origin)) { Send(stream, 403, null, null, false); return; }

        if (method == "OPTIONS") { Send(stream, 204, origin, null, true); return; }
        if (method == "POST" && path == "/alerts")
        {
            object list;
            try { list = Json.DeserializeObject(Encoding.UTF8.GetString(body)); }
            catch (Exception) { Send(stream, 400, origin, null, false); return; }
            Exception failed = null;
            ui.Send(_ => { try { orb.TakeAlerts(list); } catch (Exception err) { failed = err; } }, null);
            Send(stream, failed == null ? 204 : 400, origin, null, false);
            return;
        }
        if (method == "GET" && path == "/answers")
        {
            List<Dictionary<string, object>> answers = null;
            ui.Send(_ => answers = orb.TakeAnswers(), null);
            Send(stream, 200, origin, Json.Serialize(answers), false);
            return;
        }
        if (method == "GET" && (path == "/status" || path == "/"))
        {
            Dictionary<string, object> status = null;
            ui.Send(_ => status = orb.Status(), null);
            status["app"] = "LightMoon Listener";
            Send(stream, 200, origin, Json.Serialize(status), false);
            return;
        }
        Send(stream, 404, origin, null, false);
    }

    static void Send(NetworkStream stream, int status, string origin, string json, bool preflight)
    {
        var reasons = new Dictionary<int, string> { { 200, "OK" }, { 204, "No Content" }, { 400, "Bad Request" }, { 403, "Forbidden" }, { 404, "Not Found" }, { 413, "Payload Too Large" }, { 431, "Request Header Fields Too Large" } };
        var content = json == null ? new byte[0] : Encoding.UTF8.GetBytes(json);
        var head = new StringBuilder();
        head.AppendFormat("HTTP/1.1 {0} {1}\r\n", status, reasons.ContainsKey(status) ? reasons[status] : "Error");
        if (json != null) head.Append("Content-Type: application/json; charset=utf-8\r\n");
        head.AppendFormat("Content-Length: {0}\r\nCache-Control: no-store\r\nConnection: close\r\n", content.Length);
        if (origin != null)
        {
            head.AppendFormat("Access-Control-Allow-Origin: {0}\r\nVary: Origin\r\n", origin);
            if (preflight)
            {
                head.Append("Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: Content-Type\r\n");
                head.Append("Access-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n");
            }
        }
        head.Append("\r\n");
        var bytes = Encoding.ASCII.GetBytes(head.ToString());
        stream.Write(bytes, 0, bytes.Length);
        if (content.Length > 0) stream.Write(content, 0, content.Length);
        stream.Flush();
    }
}
