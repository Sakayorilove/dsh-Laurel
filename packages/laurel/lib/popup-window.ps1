# Laurel · 自绘通知窗
#
# 为什么不用 Windows 系统通知：`new Notification()` 在这台机器上确实发出去了
# （宿主 events.log 里是 `已弹出 · permission granted`），但 Windows 把
# `ai.deepseek.dsh.desktop` 这条身份的通知开关设成了 Enabled=0，横幅根本不显示。
# 通知类插件不该依赖一个用户看不见、也说不清为什么被关掉的东西，
# 所以这里自己画：一个置顶、不进任务栏、不抢焦点的窗口。
#
# 协议（一行一个 JSON，UTF-8）：
#   stdin  ← {id, title, body, hint, accent, seconds, corner, width, sound}
#   stdout → {event:"ready"}
#            {event:"shown",   id}
#            {event:"clicked", id}
#            {event:"closed",  id, reason:"timeout"|"click"|"manual"|"replaced"}
#            {event:"error",   id, message}
#
# 纪律：
#   - 起不来的话**必须**在 stdout 上说清楚（宿主据此决定是否退回 Windows 通知），
#     而不是静默退出 —— 静默失败正是这个功能要解决的问题本身。
#   - 不抢焦点（ShowActivated=false）：通知弹出来不该打断你正在打的字。
#   - 点一下就回到 DSH 那个窗口。

param(
  [int]$Width = 360,
  [int]$Margin = 16,
  [int]$Gap = 10,
  [int]$MaxWindows = 5
)

$ErrorActionPreference = 'Stop'

# ── 输出：自己包一层 UTF-8 writer，绕开控制台代码页（中文标题在这个系统上是 GBK 控制台） ──
$utf8 = New-Object System.Text.UTF8Encoding($false)
$out = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput(), $utf8)
$out.AutoFlush = $true
$err = New-Object System.IO.StreamWriter([Console]::OpenStandardError(), $utf8)
$err.AutoFlush = $true

function Emit($payload) {
  try { $out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 4)) } catch { }
}

function Fail($id, $message) {
  Emit @{ event = 'error'; id = $id; message = "$message" }
}

try {
  Add-Type -AssemblyName PresentationFramework
  Add-Type -AssemblyName PresentationCore
  Add-Type -AssemblyName WindowsBase
  Add-Type -AssemblyName System.Windows.Forms
} catch {
  Fail $null "WPF 不可用：$($_.Exception.Message)"
  exit 3
}

# 回到 DSH 窗口用的两个 Win32 调用。
try {
  Add-Type -Namespace Laurel -Name Win -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr hWnd);
'@
} catch {
  Fail $null "Win32 绑定失败：$($_.Exception.Message)"
  exit 3
}

# ── 找出 DSH 自己的窗口 ────────────────────────────────────────────────
# 宿主半边是 DSH 主进程的子孙进程，所以优先沿父链往上找第一个"有主窗口"的祖先；
# 找不到再按进程名兜底。两条都失败就只是不能"点一下跳回去"，不影响弹窗本身。
$script:AppHandle = [IntPtr]::Zero
function Resolve-AppHandle {
  if ($script:AppHandle -ne [IntPtr]::Zero) { return $script:AppHandle }
  try {
    $current = $PID
    for ($depth = 0; $depth -lt 8; $depth++) {
      $record = Get-CimInstance Win32_Process -Filter "ProcessId=$current" -ErrorAction SilentlyContinue
      if ($null -eq $record) { break }
      $parentId = [int]$record.ParentProcessId
      if ($parentId -le 0) { break }
      $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
      if ($null -ne $parent -and $parent.MainWindowHandle -ne 0) {
        $script:AppHandle = $parent.MainWindowHandle
        return $script:AppHandle
      }
      $current = $parentId
    }
  } catch { }
  try {
    $candidate = Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($null -ne $candidate) { $script:AppHandle = $candidate.MainWindowHandle }
  } catch { }
  return $script:AppHandle
}

function Focus-App {
  $handle = Resolve-AppHandle
  if ($handle -eq [IntPtr]::Zero) { return }
  try {
    if ([Laurel.Win]::IsIconic($handle)) { [void][Laurel.Win]::ShowWindow($handle, 9) }  # SW_RESTORE
    [void][Laurel.Win]::SetForegroundWindow($handle)
  } catch { }
}

# ── 配色 ──────────────────────────────────────────────────────────────
$Palette = @{
  surface = '#F21C1D21'
  stroke  = '#33FFFFFF'
  title   = '#F5FFFFFF'
  body    = '#C4FFFFFF'
  hint    = '#70FFFFFF'
  hover   = '#14FFFFFF'
  close   = '#8AFFFFFF'
}

function Brush($hex) {
  $converted = [System.Windows.Media.BrushConverter]::new()
  return $converted.ConvertFromString($hex)
}

$script:Windows = New-Object System.Collections.ArrayList

# ── 排版 ──────────────────────────────────────────────────────────────
# Windows 的 WorkArea 是主屏工作区（已扣掉任务栏），单位与 WPF 的 Left/Top 一致。
function Update-Layout {
  $area = [System.Windows.SystemParameters]::WorkArea
  $stackFromBottom = $true
  foreach ($item in $script:Windows) { if ($item.Corner -like 'top-*') { $stackFromBottom = $false } }
  $offset = $Margin
  for ($i = 0; $i -lt $script:Windows.Count; $i++) {
    $item = $script:Windows[$i]
    $w = $item.Window
    $height = if ($w.ActualHeight -gt 0) { $w.ActualHeight } else { 84 }
    if ($item.Corner -like '*-left') { $w.Left = $area.Left + $Margin } else { $w.Left = $area.Right - $Width - $Margin }
    if ($stackFromBottom) { $w.Top = $area.Bottom - $offset - $height } else { $w.Top = $area.Top + $offset }
    $offset += $height + $Gap
  }
}

function Close-Notify($item, $reason) {
  $window = $item.Window
  try {
    if ($null -ne $item.Timer) { $item.Timer.Stop() }
    if ($item.Closing -eq $false) {
      $item.Closing = $true
      [void]$script:Windows.Remove($item)
      $window.Close()
      Emit @{ event = 'closed'; id = $item.Id; reason = $reason }
      Update-Layout
    }
  } catch { }
}

# ── 造一张通知卡片 ─────────────────────────────────────────────────────
function New-NotifyWindow($n) {
  $now = Get-Date
  $id = if ($n.id) { "$($n.id)" } else { [guid]::NewGuid().ToString('n') }
  $seconds = if ($null -ne $n.seconds) { [double]$n.seconds } else { 8 }
  $corner = if ("$($n.corner)" -match '^(top|bottom)-(left|right)$') { "$($n.corner)" } else { 'bottom-right' }
  $accent = if ("$($n.accent)" -match '^#[0-9A-Fa-f]{6,8}$') { "$($n.accent)" } else { '#7CC4FF' }

  $window = New-Object System.Windows.Window
  $window.WindowStyle = 'None'
  $window.AllowsTransparency = $true
  $window.Background = [System.Windows.Media.Brushes]::Transparent
  $window.Topmost = $true
  $window.ShowActivated = $false          # 不抢焦点
  $window.ShowInTaskbar = $false
  $window.Width = $Width
  $window.SizeToContent = 'Height'
  $window.ResizeMode = 'NoResize'
  $window.Opacity = 0

  $border = New-Object System.Windows.Controls.Border
  $border.CornerRadius = New-Object System.Windows.CornerRadius(12)
  $border.Background = Brush $Palette.surface
  $border.BorderThickness = New-Object System.Windows.Thickness(1)
  $border.BorderBrush = Brush $Palette.stroke
  $border.Padding = New-Object System.Windows.Thickness(0)
  $border.Cursor = [System.Windows.Input.Cursors]::Hand
  $window.Content = $border

  $grid = New-Object System.Windows.Controls.Grid
  $colAccent = New-Object System.Windows.Controls.ColumnDefinition
  $colAccent.Width = New-Object System.Windows.GridLength(3)
  $colBody = New-Object System.Windows.Controls.ColumnDefinition
  $colClose = New-Object System.Windows.Controls.ColumnDefinition
  $colClose.Width = New-Object System.Windows.GridLength(28)
  [void]$grid.ColumnDefinitions.Add($colAccent)
  [void]$grid.ColumnDefinitions.Add($colBody)
  [void]$grid.ColumnDefinitions.Add($colClose)
  $border.Child = $grid

  $stripe = New-Object System.Windows.Shapes.Rectangle
  $stripe.Fill = Brush $accent
  $stripe.RadiusX = 1.5
  $stripe.RadiusY = 1.5
  $stripe.Margin = New-Object System.Windows.Thickness(0, 10, 0, 10)
  [System.Windows.Controls.Grid]::SetColumn($stripe, 0)
  [void]$grid.Children.Add($stripe)

  $stack = New-Object System.Windows.Controls.StackPanel
  $stack.Margin = New-Object System.Windows.Thickness(13, 11, 4, 12)
  [System.Windows.Controls.Grid]::SetColumn($stack, 1)
  [void]$grid.Children.Add($stack)

  $titleBlock = New-Object System.Windows.Controls.TextBlock
  $titleBlock.Text = "$($n.title)"
  $titleBlock.FontFamily = New-Object System.Windows.Media.FontFamily('Microsoft YaHei UI, Segoe UI')
  $titleBlock.FontSize = 13.5
  $titleBlock.FontWeight = 'SemiBold'
  $titleBlock.Foreground = Brush $Palette.title
  $titleBlock.TextTrimming = 'CharacterEllipsis'
  [void]$stack.Children.Add($titleBlock)

  if ("$($n.body)" -ne '') {
    $bodyBlock = New-Object System.Windows.Controls.TextBlock
    $bodyBlock.Text = "$($n.body)"
    $bodyBlock.FontFamily = $titleBlock.FontFamily
    $bodyBlock.FontSize = 12.5
    $bodyBlock.Foreground = Brush $Palette.body
    $bodyBlock.TextWrapping = 'Wrap'
    $bodyBlock.MaxHeight = 92
    $bodyBlock.Margin = New-Object System.Windows.Thickness(0, 4, 0, 0)
    [void]$stack.Children.Add($bodyBlock)
  }

  $hintText = if ("$($n.hint)" -ne '') { "$($n.hint)" } else { '点一下回到 DSH' }
  $hintBlock = New-Object System.Windows.Controls.TextBlock
  $hintBlock.Text = $hintText
  $hintBlock.FontFamily = $titleBlock.FontFamily
  $hintBlock.FontSize = 11
  $hintBlock.Foreground = Brush $Palette.hint
  $hintBlock.Margin = New-Object System.Windows.Thickness(0, 7, 0, 0)
  [void]$stack.Children.Add($hintBlock)

  $close = New-Object System.Windows.Controls.Button
  $close.Content = '✕'
  $close.FontSize = 11
  $close.Foreground = Brush $Palette.close
  $close.Background = [System.Windows.Media.Brushes]::Transparent
  $close.BorderThickness = New-Object System.Windows.Thickness(0)
  $close.Width = 22
  $close.Height = 22
  $close.Cursor = [System.Windows.Input.Cursors]::Hand
  $close.HorizontalAlignment = 'Right'
  $close.VerticalAlignment = 'Top'
  $close.Margin = New-Object System.Windows.Thickness(0, 8, 8, 0)
  [System.Windows.Controls.Grid]::SetColumn($close, 2)
  [void]$grid.Children.Add($close)

  $item = [pscustomobject]@{
    Id = $id; Window = $window; Corner = $corner; Timer = $null; Closing = $false; Seconds = $seconds
  }

  # 事件处理里一律走 `$this.Tag`（= 本张卡片），不闭包捕获局部变量 ——
  # 闭包读函数局部变量在 PowerShell 里靠作用域链，触发时机一晚会读到空值。
  $window.Tag = $item
  $border.Tag = $item
  $close.Tag = $item

  # 点卡片 / 点 ✕
  $border.Add_MouseLeftButtonUp({ Focus-App; Close-Notify $this.Tag 'click' })
  $close.Add_Click({ Close-Notify $this.Tag 'manual' })

  # 悬停时别消失（正在看 / 正要点的东西不该这时候跑掉）
  $window.Add_MouseEnter({ if ($null -ne $this.Tag.Timer) { $this.Tag.Timer.Stop() } })
  $window.Add_MouseLeave({
    $entry = $this.Tag
    if ($null -ne $entry.Timer -and $entry.Seconds -gt 0) {
      $entry.Timer.Interval = [TimeSpan]::FromSeconds([Math]::Min(2.5, $entry.Seconds))
      $entry.Timer.Start()
    }
  })
  $window.Add_MouseLeftButtonUp({ Focus-App; Close-Notify $this.Tag 'click' })

  if ($seconds -gt 0) {
    $timer = New-Object System.Windows.Threading.DispatcherTimer
    $timer.Interval = [TimeSpan]::FromSeconds($seconds)
    $timer.Tag = $item
    $timer.Add_Tick({ Close-Notify $this.Tag 'timeout' })
    $item.Timer = $timer
  }

  return $item
}

function Show-Notify($payload) {
  try {
    if ($script:Windows.Count -ge $MaxWindows) {
      Close-Notify $script:Windows[0] 'replaced'
    }
    $item = New-NotifyWindow $payload
    [void]$script:Windows.Add($item)

    # 入场：淡入 + 从角落方向滑进来
    $window = $item.Window
    $slide = New-Object System.Windows.Media.TranslateTransform
    if ($item.Corner -like '*-right') { $slide.X = 24 } else { $slide.X = -24 }
    $window.RenderTransform = $slide
    $window.Show()
    Update-Layout
    $fade = New-Object System.Windows.Media.Animation.DoubleAnimation(0.0, 1.0, [TimeSpan]::FromMilliseconds(160))
    $window.BeginAnimation([System.Windows.Window]::OpacityProperty, $fade)
    $slide.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty,
      (New-Object System.Windows.Media.Animation.DoubleAnimation($slide.X, 0.0, [TimeSpan]::FromMilliseconds(180))))
    if ($null -ne $item.Timer) { $item.Timer.Start() }

    if ("$($payload.sound)" -eq 'true') {
      try { [System.Media.SystemSounds]::Asterisk.Play() } catch { }
    }
    Emit @{ event = 'shown'; id = $item.Id }
  } catch {
    Fail $(if ($payload) { $payload.id } else { $null }) "建窗失败：$($_.Exception.Message)"
  }
}

# ── 主循环：stdin 读 JSON 行，UI 线程负责画 ────────────────────────────
$application = New-Object System.Windows.Application
$application.ShutdownMode = 'OnExplicitShutdown'
$script:Dispatcher = [System.Windows.Threading.Dispatcher]::CurrentDispatcher

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$reader = New-Object System.Threading.Thread([System.Threading.ThreadStart]{
  try {
    while ($null -ne ($line = $stdin.ReadLine())) {
      if ($line.Trim() -eq '') { continue }
      if ($line.Trim() -eq '{"event":"quit"}') { break }
      try {
        $payload = $line | ConvertFrom-Json
      } catch {
        Fail $null "看不懂的一行：$($_.Exception.Message)"
        continue
      }
      [void]$script:Dispatcher.Invoke([Action]{ Show-Notify $payload })
    }
  } catch {
    Fail $null "读 stdin 出错：$($_.Exception.Message)"
  } finally {
    try { [void]$script:Dispatcher.Invoke([Action]{ [System.Windows.Application]::Current.Shutdown() }) } catch { }
  }
})
$reader.IsBackground = $true

# 应用先跑起来，再开读线程 —— 否则第一行可能在 UI 线程就绪前到达。
$application.Add_Startup({
  Emit @{ event = 'ready' }
  $reader.Start()
})
[void]$application.Run()
Emit @{ event = 'bye' }
