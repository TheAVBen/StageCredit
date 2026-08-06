#!/usr/bin/env python3
"""StageCredit user guide — SCTV branded PDF.

Regenerate after a release:  pip install reportlab && python3 make-guide.py
Writes "StageCredit User Guide.pdf" next to this script.
"""
import os
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import HexColor
from reportlab.lib.units import mm
from reportlab.platypus import (BaseDocTemplate, PageTemplate, Frame, Paragraph,
                                Spacer, Table, TableStyle, NextPageTemplate, PageBreak,
                                KeepTogether)
from reportlab.lib.styles import ParagraphStyle

VERSION = '1.0.2'

NAVY = HexColor('#2c2b3b')
YELLOW = HexColor('#ffcc02')
OFFWHITE = HexColor('#f2f2f2')
INK = HexColor('#111111')
GREY = HexColor('#6b6a7d')
PANEL = HexColor('#efeef3')
RED = HexColor('#ff4d4f')
RULE = HexColor('#d8d7e0')

W, H = A4
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'StageCredit User Guide.pdf')

styles = {
    'h1': ParagraphStyle('h1', fontName='Helvetica-Bold', fontSize=19, leading=23,
                         textColor=NAVY, spaceBefore=16, spaceAfter=5),
    'h2': ParagraphStyle('h2', fontName='Helvetica-Bold', fontSize=12.5, leading=15,
                         textColor=NAVY, spaceBefore=11, spaceAfter=3),
    'body': ParagraphStyle('body', fontName='Helvetica', fontSize=9.8, leading=14.4,
                           textColor=INK, spaceAfter=5),
    'bullet': ParagraphStyle('bullet', fontName='Helvetica', fontSize=9.8, leading=14,
                             textColor=INK, spaceAfter=3, leftIndent=10, firstLineIndent=-10),
    'tip': ParagraphStyle('tip', fontName='Helvetica-Oblique', fontSize=9.3, leading=13.5,
                          textColor=NAVY, backColor=PANEL, borderPadding=7,
                          spaceBefore=4, spaceAfter=9),
    'th': ParagraphStyle('th', fontName='Helvetica-Bold', fontSize=8.6, textColor=OFFWHITE),
    'td': ParagraphStyle('td', fontName='Helvetica', fontSize=9.2, leading=12.5, textColor=INK),
    'tdb': ParagraphStyle('tdb', fontName='Helvetica-Bold', fontSize=9.2, leading=12.5, textColor=NAVY),
}


def rule():
    t = Table([['']], colWidths=[40 * mm], rowHeights=[2])
    t.setStyle(TableStyle([('BACKGROUND', (0, 0), (-1, -1), YELLOW)]))
    t.hAlign = 'LEFT'
    return t


def wordmark(c, x, y, size, light=False):
    c.setFont('Helvetica-Bold', size)
    c.setFillColor(OFFWHITE if light else NAVY)
    c.drawString(x, y, 'soundcredit')
    w = c.stringWidth('soundcredit', 'Helvetica-Bold', size)
    c.setFont('Helvetica-Bold', size * 0.5)
    c.setFillColor(YELLOW)
    c.drawString(x + w + size * 0.06, y + size * 0.45, '.tv')


def cover(c, doc):
    c.saveState()
    c.setFillColor(NAVY)
    c.rect(0, 0, W, H, fill=1, stroke=0)
    c.setFillColor(YELLOW)
    c.setFont('Helvetica-Bold', 92)
    c.drawCentredString(W / 2, H * 0.62, '13:26')
    bw, bh = W * 0.42, 5
    bx, by = (W - bw) / 2, H * 0.575
    c.setFillColor(HexColor('#454458'))
    c.roundRect(bx, by, bw, bh, bh / 2, fill=1, stroke=0)
    c.setFillColor(RED)
    c.roundRect(bx, by, bw * 0.35, bh, bh / 2, fill=1, stroke=0)
    c.setFillColor(OFFWHITE)
    c.setFont('Helvetica-Bold', 34)
    c.drawCentredString(W / 2, H * 0.46, 'StageCredit')
    c.setFillColor(YELLOW)
    c.setFont('Helvetica-Bold', 12)
    c.drawCentredString(W / 2, H * 0.425,
                        'U S E R   G U I D E   —   V ' + '  '.join(VERSION))
    wm_size = 16
    total = c.stringWidth('soundcredit', 'Helvetica-Bold', wm_size) + wm_size * 0.5
    wordmark(c, (W - total) / 2, H * 0.08, wm_size, light=True)
    c.restoreState()


def body_page(c, doc):
    c.saveState()
    c.setFillColor(NAVY)
    c.rect(0, H - 16 * mm, W, 16 * mm, fill=1, stroke=0)
    c.setFillColor(OFFWHITE)
    c.setFont('Helvetica-Bold', 10)
    c.drawString(18 * mm, H - 10 * mm, 'StageCredit — User Guide')
    wordmark(c, W - 52 * mm, H - 10 * mm, 9, light=True)
    c.setFillColor(GREY)
    c.setFont('Helvetica', 8)
    c.drawCentredString(W / 2, 10 * mm, str(doc.page - 1))
    c.setFillColor(YELLOW)
    c.rect(0, 0, W, 2.5, fill=1, stroke=0)
    c.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, title='StageCredit User Guide ' + VERSION,
                      author='Sound Credit TV')
doc.addPageTemplates([
    PageTemplate(id='cover', frames=[Frame(0, 0, W, H, id='cover')], onPage=cover),
    PageTemplate(id='body',
                 frames=[Frame(18 * mm, 16 * mm, W - 36 * mm, H - 38 * mm, id='body')],
                 onPage=body_page),
])

S = []
S.append(NextPageTemplate('body'))
S.append(PageBreak())


def sec(title):
    S.append(Paragraph(title, styles['h1']))
    S.append(rule())
    S.append(Spacer(1, 5))


def sub(title):
    S.append(Paragraph(title, styles['h2']))


def p(text):
    S.append(Paragraph(text, styles['body']))


def bullets(items):
    for i in items:
        S.append(Paragraph('•&nbsp;&nbsp;' + i, styles['bullet']))
    S.append(Spacer(1, 5))


def tip(text):
    S.append(Paragraph('Tip — ' + text, styles['tip']))


def table(rows, widths, head=True):
    data = []
    for n, r in enumerate(rows):
        style = styles['th'] if (head and n == 0) else styles['td']
        data.append([Paragraph(str(c), style) for c in r])
    t = Table(data, colWidths=widths)
    cmds = [
        ('GRID', (0, 0), (-1, -1), 0.5, RULE),
        ('TOPPADDING', (0, 0), (-1, -1), 4.5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 4.5),
        ('LEFTPADDING', (0, 0), (-1, -1), 7),
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
    ]
    if head:
        cmds += [('BACKGROUND', (0, 0), (-1, 0), NAVY),
                 ('ROWBACKGROUNDS', (0, 1), (-1, -1), [None, PANEL])]
    else:
        cmds += [('ROWBACKGROUNDS', (0, 0), (-1, -1), [None, PANEL])]
    t.setStyle(TableStyle(cmds))
    t.hAlign = 'LEFT'
    S.append(t)
    S.append(Spacer(1, 8))


# ---------------------------------------------------------------- Welcome
sec('Welcome to StageCredit')
p('StageCredit is Sound Credit TV’s stage timer. It runs a <b>control panel</b> for '
  'the operator and one or two <b>output windows</b> for the room — typically '
  'fullscreen on a comfort monitor, confidence screen or foldback TV. You build a cue '
  'list, fire cues, and send messages; the presenter just sees a big, clear countdown.')
p('Everything you change is saved automatically on that machine, and a whole show can be '
  'saved to a file and carried to another one.')

sub('Installing')
p('<b>Mac:</b> open the DMG and drag StageCredit into Applications. The app is unsigned, '
  'so the first launch needs a right-click → Open → Open. After that it opens normally.')
p('<b>Windows:</b> run the StageCredit Setup installer, or use the portable .exe straight '
  'from a USB stick. If SmartScreen appears, click More info → Run anyway.')

sub('The two output views')
p('<b>Presenter</b> shows everything: the clock, the cue name and speaker, messages and '
  '“next up”. <b>Clock</b> is a stripped view — the time and nothing else — for FOH, a '
  'director’s monitor or a lobby screen. Both follow the same timer; they are two '
  'presentations of one clock, not two timers.')

# ---------------------------------------------------------------- Control panel
sec('The control panel')
p('The left column runs the clock. The right column holds the cue list and messages. '
  'The top bar has the lock, undo, the Show menu and Settings, plus an output indicator '
  'that turns green once a display window is open.')

sub('The clock block')
p('The big readout carries a state line — <b>Running</b>, <b>Paused</b>, <b>Overtime</b>, '
  '<b>Time up</b>, <b>Blanked</b> — and whether a cue or manual owns the clock. To its '
  'right, <b>ends</b> shows the wall-clock time this cue finishes. A progress bar runs '
  'underneath, and any operator notes on the loaded cue appear just below.')

sub('Transport')
table([
    ['Control', 'What it does'],
    ['Start / Pause', 'Runs and holds the clock. Space by default.'],
    ['Reset', 'Back to the loaded cue’s duration, or the manual time. R by default.'],
    ['TOD', 'Switches the output to a live clock — handy before doors or during a break. T by default.'],
    ['Hold to blank', 'Press and hold for half a second to blank the output; tap once to bring it back. '
                      'Deliberate to blank, instant to restore — a slip on the desk can’t take the screen out.'],
    ['GO', 'Loads <i>and</i> starts the next cue. The Next line above it shows what that will be.'],
    ['Take manual', 'Hands the clock back to you: the mm/ss boxes go live and no cue owns the output. '
                    'Editing the boxes no longer unloads a cue by accident — you have to ask for manual.'],
], [38 * mm, 132 * mm])

sub('Clock speed')
p('The clock speed slider makes each on-screen second run slightly fast or slow, from '
  '0.8× to 1.2×. It is covered by a guard you must click before it will move, and the '
  'panel flags the multiplier whenever it isn’t 1.00×. The output never shows it. '
  'Officially, this is for gentle schedule correction.')
tip('Only the operator knows. Use responsibly, or at least with a straight face.')

# ---------------------------------------------------------------- Cue list
sec('The cue list')
p('Cues are named timers prepared before the show. Type a name, minutes and seconds, then '
  '<b>Add</b>. Toggle <b>TOD</b> first (it glows yellow) to add a time-of-day cue instead. '
  '<b>Load</b> arms a cue paused — press Start, or use GO to load and start in one move. '
  'The loaded cue’s Load button becomes <b>Clear</b>, and ✕ deletes.')
p('<b>Reorder</b> switches the list to drag and drop: grab a cue, drop it where it belongs, '
  'press Done. The loaded cue keeps its place in the running order as things move around it.')

sub('Arming a cue')
p('Digits <b>1–9</b> (0 for cue 10) <i>arm</i> a cue rather than loading it. The Next line '
  'shows ARMED and the cue is highlighted, but nothing reaches the output until you press '
  'GO. A stray keypress can’t stop a live clock or change the presenter’s number.')

sub('The cue editor')
p('The ✎ button on any cue opens the full editor:')
bullets([
    '<b>Type</b> — countdown, count up (a stopwatch for open-ended segments), or time of day.',
    '<b>Speaker / subtitle</b> and <b>Show name on display</b> — puts the cue name, and the '
    'speaker under it, above the timer on the presenter view.',
    '<b>Timer colour</b> and <b>background tint</b> — nine swatches each; coloured cues get a '
    'dot in the list. Warning and overtime colours still take over when they apply.',
    '<b>Warning threshold</b> — per-cue override of when the digits change colour.',
    '<b>At zero</b> — count overtime (+1:23, flashing) or stop and hold 0:00.',
    '<b>Auto-follow</b> — at zero, the next cue loads and starts itself. Chain a block and '
    'it runs hands-free.',
    '<b>Scheduled start</b> — the cue fires itself at a time of day, marked with a clock '
    'symbol in the list. Set 09:00 on the opening cue and the morning starts without you.',
    '<b>Auto message</b> — show, say, “WRAP UP” automatically at 2:00 remaining; it clears '
    'itself at zero. On a cue shorter than the trigger it appears straight away.',
    '<b>Notes</b> — operator-only, shown under the clock while that cue is loaded.',
    '<b>Duplicate</b> — copies the cue as a starting point.',
])

sub('Locking the rundown')
p('The <b>Unlocked / Locked</b> button in the top bar freezes the cue list and messages '
  'read-only, so nothing can be edited or dragged by accident once the show is up. '
  'Settings → Behaviour can lock it automatically on the first GO. Locking is never '
  'inherited from last night — every session starts unlocked.')

# ---------------------------------------------------------------- Backtiming
sec('Backtiming')
p('Set a <b>planned start</b> and a <b>hard out</b> under Show schedule, and the strip '
  'above the transport reports three numbers, refreshed every second:')
table([
    ['Projected end', 'When the rundown now finishes, from the live clock and every cue after it.'],
    ['Drift vs plan', 'How far off the planned finish you are. Within a minute either way it reads '
                      '<i>on plan</i>; before the show starts it stays on plan rather than counting '
                      'the time until your start.'],
    ['Slack to hard out', 'How much room is left before the latest you can finish. Turns red once '
                          'you are over.'],
], [38 * mm, 132 * mm], head=False)
p('Every cue in the list also carries its projected clock time, so you can see at a glance '
  'that the 3pm panel is now starting at 3:12. Count-up and time-of-day cues have no '
  'knowable length, so anything after one is marked <i>est</i>.')
tip('The plan travels in the show file. Load a show and its times come with it.')

# ---------------------------------------------------------------- Messages
sec('Messages')
p('The custom field sends a one-off message to the output. Preset messages are saved '
  'buttons for the regulars — “WRAP UP”, “5 MINUTES LEFT” — and you can add as many as '
  'you like. Any <b>Send</b> button becomes a red <b>Clear</b> while its message is live, so '
  'the same button takes it down. Sending from another slot replaces what is on screen.')

# ---------------------------------------------------------------- Customise
sec('Customising the output')
p('Settings → Style changes the output live: font, timer size, and colours for '
  'background, digits, messages, warning and overtime. You can also:')
bullets([
    'upload a <b>custom logo</b> to replace the soundcredit.tv wordmark, or hide branding entirely',
    'set the global <b>warning threshold</b> and turn the <b>flash at zero</b> off',
    'choose 12 or 24-hour format for time of day',
    'put a small <b>time-of-day clock</b> in any corner alongside the countdown',
    'show a <b>next up</b> band, at the top or bottom, either for the whole cue or only '
    'inside the last few minutes',
])
p('<b>Reset to defaults</b> undoes an over-enthusiastic styling session.')

# ---------------------------------------------------------------- Simple mode
sec('Simple mode')
p('Show menu → <b>Simple mode</b> strips the panel back to a timer and a display: no cues, '
  'no messages, no backtiming, no clock speed. Useful for a quick session where a rundown '
  'would be overkill, or for handing the machine to someone who just needs a countdown.')
p('Switching to simple never stops a running clock — it hands the time over to the manual '
  'boxes and carries on.')

# ---------------------------------------------------------------- Show files
sec('Show files, CSV and undo')
sub('Show files')
p('<b>Save show</b> writes the whole show — cue stack, preset messages, styling including '
  'your logo, shortcuts, and the planned start and hard out — to a <b>.stagecredit</b> '
  'file. <b>Load show</b> restores one; <b>New show</b> resets to defaults. Files are plain '
  'JSON, so they travel by email or USB.')
tip('Build the show at the office, save it, load it on the show machine at the venue.')

sub('Importing a rundown')
p('Show menu → <b>Import rundown (CSV)</b> takes a running order straight out of a '
  'spreadsheet. Download the template from the same dialog for the exact column names. '
  'Every row is checked and previewed before anything is applied, and you choose whether '
  'to <b>append</b> to the current list or <b>replace</b> it. Durations can be written '
  '<i>mm:ss</i>, <i>h:mm:ss</i>, or as bare seconds.')

sub('Undo')
p('<b>Undo</b> in the top bar (⌘Z) goes twelve steps back over cue and message edits, '
  'including New show and Load show. It deliberately never touches the running clock: '
  'undoing an edit can’t stop, start or rewind what the presenter is looking at.')

# ---------------------------------------------------------------- Outputs and network
sec('Outputs, phone remote and Companion')
sub('Putting the clock on a screen')
p('Settings → Output picks the view (presenter or clock) and the screen, then '
  '<b>Fullscreen on selected</b>. <b>Exit fullscreen</b> windows it again, <b>Open</b> '
  'reopens a closed one. StageCredit remembers where each output was: quit with the '
  'presenter view fullscreen on screen 3 and it comes back there. If that screen isn’t '
  'connected at launch, the output stays closed and a dialog tells you why, rather than '
  'opening somewhere you can’t see.')

sub('Over the venue network')
p('Settings → Network starts a small built-in server. Any phone or laptop on the same '
  'network can then open the display, the clock view, or a <b>remote</b> with transport, '
  'cue list and messages. Click any link in the panel to copy it.')
p('Viewer links are open — the worst case is someone watching your countdown. Anything '
  'that can <i>change</i> the output needs the session token, which is in the remote link '
  'and regenerated every time the server starts.')

sub('Bitfocus Companion')
p('Point Companion’s Generic HTTP module at:')
p('<font face="Courier">http://&lt;ip&gt;:&lt;port&gt;/api/action?a=&lt;action&gt;&amp;t=&lt;token&gt;</font>')
table([
    ['Action', 'Effect'],
    ['start, pause, toggle', 'Run, hold, or flip the clock'],
    ['reset', 'Back to the cue duration'],
    ['go, next, prev', 'Load and start the next cue / step without starting'],
    ['cue &amp; v=<i>n</i>', 'Load cue <i>n</i>, numbered as shown in the list (v=1 is the first cue)'],
    ['tod', 'Toggle the time-of-day clock'],
    ['blank, blankon, blankoff', 'Blank or restore the output'],
    ['add &amp; v=<i>secs</i>', 'Add or subtract time (v=-60 takes a minute off)'],
    ['message &amp; v=<i>text</i>', 'Put a message up'],
    ['preset &amp; v=<i>n</i>', 'Send preset message <i>n</i> (v=1 is the first)'],
    ['clearmessage', 'Take the message down'],
], [46 * mm, 124 * mm])

sub('As-run log')
p('Every load, start, pause, reset and blackout is written as it happens, with planned '
  'versus actual duration for each cue. It is recorded outside the control panel, so it '
  'survives a crash or a force-quit — exactly when you most want to know what went out. '
  'Show menu → <b>Export as-run log</b> writes it to CSV and offers to clear it ready for '
  'the next show.')

# ---------------------------------------------------------------- Shortcuts
sec('Keyboard shortcuts')
p('Settings → Keys lists every binding. Click a key chip, press the new key, done — Esc '
  'cancels, and a key already in use moves to the new action. Shortcuts are ignored while '
  'you are typing in a field or a panel is open.')
table([
    ['Action', 'Key'],
    ['Start / pause', 'Space'],
    ['Reset', 'R'],
    ['Time of day toggle', 'T'],
    ['+1 minute', '↑'],
    ['−1 minute', '↓'],
    ['+5 minutes', '→'],
    ['Clear message', 'C'],
    ['Arm cue 1–9 (0 = cue 10)', 'Digit keys — press GO to fire'],
    ['Undo', '⌘Z / Ctrl+Z — fixed, not remappable'],
], [70 * mm, 60 * mm])

# ---------------------------------------------------------------- Troubleshooting
sec('Troubleshooting')
for q, a in [
    ('“A display output stayed closed” at launch',
     'The screen that output was on last time isn’t connected. Plug it in, or pick another '
     'screen under Settings → Output.'),
    ('The timer changed colour earlier than I expected',
     'Check that cue’s own warning threshold in the cue editor — it overrides the global '
     'one. And check nobody has been at the clock speed slider; the panel flags it when it '
     'isn’t 1.00×.'),
    ('The cue list won’t let me edit anything',
     'The rundown is locked — click Locked in the top bar to unlock. If it locks itself when '
     'you press GO, that’s the option in Settings → Behaviour.'),
    ('Shortcuts aren’t firing',
     'A text field probably has focus, or a panel is open. Click empty space first.'),
    ('A phone on the network can watch but not control',
     'Controlling needs the token. Open the remote link exactly as shown in Settings → '
     'Network — it carries the token — rather than typing the address by hand.'),
    ('The display looks frozen on a browser',
     'It says so: the page dims and reconnects by itself when the wifi returns. The Electron '
     'output windows aren’t affected.'),
    ('macOS or Windows warns about the app',
     'Expected for an unsigned app — right-click → Open on Mac, or More info → Run anyway on '
     'Windows. Once only.'),
]:
    sub(q)
    p(a)

# ---------------------------------------------------------------- Changes
sec('What changed in ' + VERSION)
bullets([
    'The remote and Companion <b>blank</b> commands work again — they used to fail silently.',
    'Show files now carry the planned start and hard out, so drift is measured against '
    '<i>your</i> schedule rather than whatever was last used on that machine.',
    'Deleting the cue that owns the clock no longer leaves the output stuck showing a '
    'time-of-day clock with nothing loaded.',
    'Auto messages fire on cues shorter than their trigger.',
    'The as-run log closes a cue’s entry when you clear or delete it, so actual durations '
    'no longer swallow the gap.',
    'Drift reads <i>on plan</i> before the show starts.',
    'Cue and preset numbers in the remote API now match the numbers on screen.',
])

S.append(Spacer(1, 14))
S.append(Paragraph('StageCredit v' + VERSION + ' — built by Sound Credit TV.',
                   ParagraphStyle('end', fontName='Helvetica-Oblique', fontSize=9,
                                  textColor=GREY)))

doc.build(S)
print('PDF written:', OUT)
