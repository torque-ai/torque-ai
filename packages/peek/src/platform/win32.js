'use strict';

const BasePlatformAdapter = require('./base');

const POWERSHELL_ARGS = Object.freeze(['-NoProfile', '-Command']);
const DEFAULT_CAPABILITIES = Object.freeze(['capture', 'compare', 'interact', 'launch', 'windows']);

const LIST_WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class PeekWin32Windows {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
}
"@

$windows = @(
  Get-Process |
    Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) } |
    ForEach-Object {
      $handle = [IntPtr]$_.MainWindowHandle
      if ([PeekWin32Windows]::IsWindowVisible($handle)) {
        $rect = New-Object PeekWin32Windows+RECT
        if ([PeekWin32Windows]::GetWindowRect($handle, [ref]$rect)) {
          $width = [Math]::Max(0, $rect.Right - $rect.Left)
          $height = [Math]::Max(0, $rect.Bottom - $rect.Top)
          if ($width -gt 0 -and $height -gt 0) {
            [PSCustomObject]@{
              title = $_.MainWindowTitle
              process = $_.ProcessName
              pid = $_.Id
              hwnd = ('0x{0:X}' -f $handle.ToInt64())
              geometry = [PSCustomObject]@{
                x = $rect.Left
                y = $rect.Top
                width = $width
                height = $height
              }
            }
          }
        }
      }
    }
)

[PSCustomObject]@{
  platform = 'win32'
  windows = $windows
} | ConvertTo-Json -Compress -Depth 6
`;

const CAPTURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class PeekWin32Capture {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);

  [DllImport("user32.dll")]
  public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);

  [DllImport("user32.dll")]
  public static extern bool SetProcessDPIAware();
}
"@

try { [PeekWin32Capture]::SetProcessDPIAware() | Out-Null } catch {}

function Read-PeekInput {
  $json = [Environment]::GetEnvironmentVariable('PEEK_INPUT')
  if ([string]::IsNullOrWhiteSpace($json)) { return [PSCustomObject]@{} }
  return $json | ConvertFrom-Json
}

function Resolve-ImageFormat($value) {
  $format = if ([string]::IsNullOrWhiteSpace($value)) { 'png' } else { ([string]$value).ToLowerInvariant() }
  if ($format -eq 'jpg') { return 'jpeg' }
  if ($format -ne 'png' -and $format -ne 'jpeg') { throw "Unsupported image format: $value" }
  return $format
}

function Get-WindowRectObject([IntPtr]$handle) {
  $rect = New-Object PeekWin32Capture+RECT
  if (-not [PeekWin32Capture]::GetWindowRect($handle, [ref]$rect)) { throw "Unable to read window geometry" }
  $width = [Math]::Max(0, $rect.Right - $rect.Left)
  $height = [Math]::Max(0, $rect.Bottom - $rect.Top)
  if ($width -le 0 -or $height -le 0) { throw "Window has empty geometry" }
  return [PSCustomObject]@{ x = $rect.Left; y = $rect.Top; width = $width; height = $height }
}

function Find-PeekWindow($request) {
  if ($request.hwnd) {
    $raw = ([string]$request.hwnd).Trim()
    $handleValue = if ($raw.StartsWith('0x', [StringComparison]::OrdinalIgnoreCase)) {
      [Convert]::ToInt64($raw.Substring(2), 16)
    } else {
      [Convert]::ToInt64($raw, 10)
    }
    foreach ($process in Get-Process) {
      if ($process.MainWindowHandle -ne 0 -and $process.MainWindowHandle.ToInt64() -eq $handleValue) { return $process }
    }
    throw "Window not found for hwnd: $raw"
  }

  $mode = if ($request.mode) { ([string]$request.mode).ToLowerInvariant() } else { 'screen' }
  $name = if ($request.name) { ([string]$request.name).ToLowerInvariant() } else { '' }
  if ([string]::IsNullOrWhiteSpace($name)) { throw "Window capture requires name or hwnd" }
  $candidates = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })

  if ($mode -eq 'process') {
    $exact = @($candidates | Where-Object {
      $processName = $_.ProcessName.ToLowerInvariant()
      $processName -eq $name -or "$processName.exe" -eq $name
    })
    if ($exact.Count -gt 0) { return $exact[0] }
    $partial = @($candidates | Where-Object { $_.ProcessName.ToLowerInvariant().Contains($name) })
    if ($partial.Count -gt 0) { return $partial[0] }
  } else {
    $titleMatches = @($candidates | Where-Object { $_.MainWindowTitle.ToLowerInvariant().Contains($name) })
    if ($titleMatches.Count -gt 0) { return $titleMatches[0] }
  }
  throw "Window not found: $($request.mode) $($request.name)"
}

function Copy-BitmapRegion($source, $crop) {
  if ($null -eq $crop) { return $source }
  $x = [Math]::Max(0, [int]$crop.x)
  $y = [Math]::Max(0, [int]$crop.y)
  $width = if ($null -ne $crop.w) { [int]$crop.w } else { [int]$crop.width }
  $height = if ($null -ne $crop.h) { [int]$crop.h } else { [int]$crop.height }
  if ($width -le 0 -or $height -le 0) { throw "Crop width and height must be positive" }
  $width = [Math]::Min($width, $source.Width - $x)
  $height = [Math]::Min($height, $source.Height - $y)
  if ($width -le 0 -or $height -le 0) { throw "Crop is outside the captured image" }
  $target = [System.Drawing.Bitmap]::new($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  try {
    $graphics.DrawImage(
      $source,
      ([System.Drawing.Rectangle]::new(0, 0, $width, $height)),
      ([System.Drawing.Rectangle]::new($x, $y, $width, $height)),
      [System.Drawing.GraphicsUnit]::Pixel
    )
  } finally {
    $graphics.Dispose()
  }
  $source.Dispose()
  return $target
}

function Resize-Bitmap($source, $maxWidth) {
  if ($null -eq $maxWidth -or [int]$maxWidth -le 0 -or $source.Width -le [int]$maxWidth) { return $source }
  $targetWidth = [int]$maxWidth
  $targetHeight = [Math]::Max(1, [int][Math]::Round($source.Height * ($targetWidth / $source.Width)))
  $target = [System.Drawing.Bitmap]::new($targetWidth, $targetHeight)
  $graphics = [System.Drawing.Graphics]::FromImage($target)
  try {
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $graphics.DrawImage($source, 0, 0, $targetWidth, $targetHeight)
  } finally {
    $graphics.Dispose()
  }
  $source.Dispose()
  return $target
}

function Encode-Bitmap($bitmap, $format, $quality) {
  $stream = [System.IO.MemoryStream]::new()
  try {
    if ($format -eq 'jpeg') {
      $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' } | Select-Object -First 1
      $encoderParams = [System.Drawing.Imaging.EncoderParameters]::new(1)
      $encoderParams.Param[0] = [System.Drawing.Imaging.EncoderParameter]::new([System.Drawing.Imaging.Encoder]::Quality, [int64]$quality)
      $bitmap.Save($stream, $codec, $encoderParams)
    } else {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    $bytes = $stream.ToArray()
    return [PSCustomObject]@{ base64 = [Convert]::ToBase64String($bytes); size_bytes = $bytes.Length }
  } finally {
    $stream.Dispose()
  }
}

$request = Read-PeekInput
$mode = if ($request.mode) { ([string]$request.mode).ToLowerInvariant() } else { 'screen' }
$format = Resolve-ImageFormat $request.format
$quality = if ($request.quality) { [Math]::Min(100, [Math]::Max(1, [int]$request.quality)) } else { 80 }
$bitmap = $null
$targetTitle = $null
$targetProcess = $null
$targetPid = $null
$targetHwnd = $null

try {
  if ($mode -eq 'screen') {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $bitmap = [System.Drawing.Bitmap]::new($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try { $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size) } finally { $graphics.Dispose() }
  } else {
    $process = Find-PeekWindow $request
    $handle = [IntPtr]$process.MainWindowHandle
    if (-not [PeekWin32Capture]::IsWindowVisible($handle)) { throw "Window is not visible: $($process.MainWindowTitle)" }
    $rect = Get-WindowRectObject $handle
    $bitmap = [System.Drawing.Bitmap]::new($rect.width, $rect.height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
      $hdc = $graphics.GetHdc()
      try { $printed = [PeekWin32Capture]::PrintWindow($handle, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
      if (-not $printed) { $graphics.CopyFromScreen($rect.x, $rect.y, 0, 0, $bitmap.Size) }
    } finally {
      $graphics.Dispose()
    }
    $targetTitle = $process.MainWindowTitle
    $targetProcess = $process.ProcessName
    $targetPid = $process.Id
    $targetHwnd = ('0x{0:X}' -f $handle.ToInt64())
  }

  $bitmap = Copy-BitmapRegion $bitmap $request.crop
  $bitmap = Resize-Bitmap $bitmap $request.max_width
  $encoded = Encode-Bitmap $bitmap $format $quality
  [PSCustomObject]@{
    image = $encoded.base64
    mode = $mode
    title = $targetTitle
    process = $targetProcess
    pid = $targetPid
    hwnd = $targetHwnd
    width = $bitmap.Width
    height = $bitmap.Height
    size_bytes = $encoded.size_bytes
    format = $format
    mime_type = if ($format -eq 'jpeg') { 'image/jpeg' } else { 'image/png' }
    annotated_image = $null
    annotated_mime_type = 'image/png'
  } | ConvertTo-Json -Compress -Depth 6
} finally {
  if ($null -ne $bitmap) { $bitmap.Dispose() }
}
`;

const INTERACTION_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class PeekWin32Input {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public int type; public InputUnion U; }

  [StructLayout(LayoutKind.Explicit)]
  public struct InputUnion {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public int mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
  }

  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr hWnd, int X, int Y, int nWidth, int nHeight, bool bRepaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

  public static void Mouse(uint flags, int data) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 0;
    inputs[0].U.mi = new MOUSEINPUT { dx = 0, dy = 0, mouseData = data, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("SendInput mouse event failed");
  }

  public static void Key(ushort vk, uint flags) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 1;
    inputs[0].U.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags, time = 0, dwExtraInfo = IntPtr.Zero };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("SendInput key event failed");
  }

  public static void Unicode(char ch, uint flags) {
    INPUT[] inputs = new INPUT[1];
    inputs[0].type = 1;
    inputs[0].U.ki = new KEYBDINPUT { wVk = 0, wScan = (ushort)ch, dwFlags = flags | 0x0004, time = 0, dwExtraInfo = IntPtr.Zero };
    if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) == 0) throw new InvalidOperationException("SendInput unicode event failed");
  }
}
"@

function Read-PeekInput {
  $json = [Environment]::GetEnvironmentVariable('PEEK_INPUT')
  if ([string]::IsNullOrWhiteSpace($json)) { return [PSCustomObject]@{} }
  return $json | ConvertFrom-Json
}

function Convert-HwndToIntPtr($raw) {
  if ([string]::IsNullOrWhiteSpace($raw)) { throw "Window handle is required" }
  $value = ([string]$raw).Trim()
  if ($value.StartsWith('0x', [StringComparison]::OrdinalIgnoreCase)) {
    return [IntPtr][Convert]::ToInt64($value.Substring(2), 16)
  }
  return [IntPtr][Convert]::ToInt64($value, 10)
}

function Find-PeekWindow($request) {
  if ($request.hwnd) { return Convert-HwndToIntPtr $request.hwnd }
  $mode = if ($request.mode) { ([string]$request.mode).ToLowerInvariant() } else { 'title' }
  $name = if ($request.name) { ([string]$request.name).ToLowerInvariant() } else { '' }
  if ([string]::IsNullOrWhiteSpace($name)) { throw "Window target requires name or hwnd" }
  $candidates = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })
  if ($mode -eq 'process') {
    $match = @($candidates | Where-Object {
      $processName = $_.ProcessName.ToLowerInvariant()
      $processName -eq $name -or "$processName.exe" -eq $name -or $processName.Contains($name)
    } | Select-Object -First 1)
  } else {
    $match = @($candidates | Where-Object { $_.MainWindowTitle.ToLowerInvariant().Contains($name) } | Select-Object -First 1)
  }
  if ($match.Count -eq 0) { throw "Window not found: $mode $name" }
  return [IntPtr]$match[0].MainWindowHandle
}

function Get-RectObject([IntPtr]$handle) {
  $rect = New-Object PeekWin32Input+RECT
  if (-not [PeekWin32Input]::GetWindowRect($handle, [ref]$rect)) { throw "Unable to read window geometry" }
  return [PSCustomObject]@{
    x = $rect.Left
    y = $rect.Top
    width = [Math]::Max(0, $rect.Right - $rect.Left)
    height = [Math]::Max(0, $rect.Bottom - $rect.Top)
  }
}

function Focus-Window($request) {
  $handle = Find-PeekWindow $request
  [PeekWin32Input]::ShowWindow($handle, 9) | Out-Null
  if (-not [PeekWin32Input]::SetForegroundWindow($handle)) { throw "Unable to focus window" }
  return $handle
}

function Resolve-KeyCode($key) {
  $name = ([string]$key).Trim().ToLowerInvariant()
  $special = @{
    'backspace' = 0x08; 'tab' = 0x09; 'enter' = 0x0D; 'return' = 0x0D; 'shift' = 0x10;
    'ctrl' = 0x11; 'control' = 0x11; 'alt' = 0x12; 'pause' = 0x13; 'capslock' = 0x14;
    'esc' = 0x1B; 'escape' = 0x1B; 'space' = 0x20; 'pageup' = 0x21; 'pagedown' = 0x22;
    'end' = 0x23; 'home' = 0x24; 'left' = 0x25; 'up' = 0x26; 'right' = 0x27; 'down' = 0x28;
    'insert' = 0x2D; 'delete' = 0x2E; 'win' = 0x5B; 'meta' = 0x5B
  }
  for ($i = 1; $i -le 24; $i++) { $special["f$i"] = 0x6F + $i }
  if ($special.ContainsKey($name)) { return [ushort]$special[$name] }
  if ($name.Length -eq 1) { return [ushort][byte][char]::ToUpperInvariant($name[0]) }
  throw "Unsupported key: $key"
}

function Send-KeyChord($keys) {
  $parts = @($keys)
  if ($parts.Count -eq 0) { throw "Hotkey requires at least one key" }
  $down = @()
  foreach ($part in $parts) {
    $code = Resolve-KeyCode $part
    $down += $code
    [PeekWin32Input]::Key($code, 0)
  }
  for ($i = $down.Count - 1; $i -ge 0; $i--) {
    [PeekWin32Input]::Key($down[$i], 0x0002)
  }
}

$request = Read-PeekInput
$action = if ($request.action) { ([string]$request.action).ToLowerInvariant() } else { '' }

switch ($action) {
  'click' {
    if ($request.name -or $request.hwnd) { Focus-Window $request | Out-Null }
    [PeekWin32Input]::SetCursorPos([int]$request.x, [int]$request.y) | Out-Null
    $button = if ($request.button) { ([string]$request.button).ToLowerInvariant() } else { 'left' }
    if ($button -eq 'right') { $down = 0x0008; $up = 0x0010 }
    elseif ($button -eq 'middle') { $down = 0x0020; $up = 0x0040 }
    else { $down = 0x0002; $up = 0x0004 }
    $count = if ($request.double) { 2 } else { 1 }
    for ($i = 0; $i -lt $count; $i++) {
      [PeekWin32Input]::Mouse($down, 0)
      [PeekWin32Input]::Mouse($up, 0)
    }
    [PSCustomObject]@{ success = $true; action = $action; x = [int]$request.x; y = [int]$request.y; button = $button } | ConvertTo-Json -Compress -Depth 4
  }
  'drag' {
    if ($request.name -or $request.hwnd) { Focus-Window $request | Out-Null }
    [PeekWin32Input]::SetCursorPos([int]$request.from_x, [int]$request.from_y) | Out-Null
    [PeekWin32Input]::Mouse(0x0002, 0)
    Start-Sleep -Milliseconds ([Math]::Max(0, [int]$request.duration_ms))
    [PeekWin32Input]::SetCursorPos([int]$request.to_x, [int]$request.to_y) | Out-Null
    [PeekWin32Input]::Mouse(0x0004, 0)
    [PSCustomObject]@{ success = $true; action = $action } | ConvertTo-Json -Compress -Depth 4
  }
  'type' {
    if ($request.name -or $request.hwnd) { Focus-Window $request | Out-Null }
    foreach ($char in ([string]$request.text).ToCharArray()) {
      [PeekWin32Input]::Unicode($char, 0)
      [PeekWin32Input]::Unicode($char, 0x0002)
    }
    [PSCustomObject]@{ success = $true; action = $action; length = ([string]$request.text).Length } | ConvertTo-Json -Compress -Depth 4
  }
  'scroll' {
    if ($request.name -or $request.hwnd) { Focus-Window $request | Out-Null }
    if ($null -ne $request.x -and $null -ne $request.y) {
      [PeekWin32Input]::SetCursorPos([int]$request.x, [int]$request.y) | Out-Null
    }
    [PeekWin32Input]::Mouse(0x0800, [int]$request.delta)
    [PSCustomObject]@{ success = $true; action = $action; delta = [int]$request.delta } | ConvertTo-Json -Compress -Depth 4
  }
  'hotkey' {
    if ($request.name -or $request.hwnd) { Focus-Window $request | Out-Null }
    Send-KeyChord $request.keys
    [PSCustomObject]@{ success = $true; action = $action; keys = $request.keys } | ConvertTo-Json -Compress -Depth 4
  }
  'focus' {
    $handle = Focus-Window $request
    [PSCustomObject]@{ success = $true; action = $action; hwnd = ('0x{0:X}' -f $handle.ToInt64()); rect = (Get-RectObject $handle) } | ConvertTo-Json -Compress -Depth 5
  }
  'move' {
    $handle = Find-PeekWindow $request
    $rect = Get-RectObject $handle
    if (-not [PeekWin32Input]::MoveWindow($handle, [int]$request.x, [int]$request.y, $rect.width, $rect.height, $true)) { throw "Unable to move window" }
    [PSCustomObject]@{ success = $true; action = $action; rect = (Get-RectObject $handle) } | ConvertTo-Json -Compress -Depth 5
  }
  'resize' {
    $handle = Find-PeekWindow $request
    $rect = Get-RectObject $handle
    if (-not [PeekWin32Input]::MoveWindow($handle, $rect.x, $rect.y, [int]$request.width, [int]$request.height, $true)) { throw "Unable to resize window" }
    [PSCustomObject]@{ success = $true; action = $action; rect = (Get-RectObject $handle) } | ConvertTo-Json -Compress -Depth 5
  }
  'maximize' {
    $handle = Find-PeekWindow $request
    [PeekWin32Input]::ShowWindow($handle, 3) | Out-Null
    [PSCustomObject]@{ success = $true; action = $action; rect = (Get-RectObject $handle) } | ConvertTo-Json -Compress -Depth 5
  }
  'minimize' {
    $handle = Find-PeekWindow $request
    [PeekWin32Input]::ShowWindow($handle, 6) | Out-Null
    [PSCustomObject]@{ success = $true; action = $action } | ConvertTo-Json -Compress -Depth 4
  }
  'clipboard' {
    $operation = if ($request.operation) { ([string]$request.operation).ToLowerInvariant() } else { 'get' }
    if ($operation -eq 'set') {
      Set-Clipboard -Value ([string]$request.text)
      [PSCustomObject]@{ success = $true; action = $action; operation = $operation; length = ([string]$request.text).Length } | ConvertTo-Json -Compress -Depth 4
    } elseif ($operation -eq 'get') {
      $text = Get-Clipboard -Raw
      [PSCustomObject]@{ success = $true; action = $action; operation = $operation; text = $text; length = ([string]$text).Length } | ConvertTo-Json -Compress -Depth 4
    } else {
      throw "Unsupported clipboard action: $operation"
    }
  }
  default {
    throw "Unsupported interaction action: $action"
  }
}
`;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOutputText(output) {
  const text = Buffer.isBuffer(output) ? output.toString('utf8') : String(output || '');
  return text.replace(/^\uFEFF/, '').trim();
}

function parseJsonOutput(output, fallback) {
  const text = normalizeOutputText(output);
  if (!text) return fallback;

  try {
    return JSON.parse(text);
  } catch (error) {
    error.message = `Invalid PowerShell JSON output: ${error.message}`;
    error.output = text;
    throw error;
  }
}

function assertFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return number;
}

function assertPositiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return number;
}

function optionalPositiveInteger(value, name) {
  if (value === undefined || value === null || value === '') return undefined;
  return assertPositiveInteger(Number(value), name);
}

function assertString(value, name) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizeImageFormat(value = 'png') {
  const format = String(value || 'png').toLowerCase();
  if (format === 'jpg') return 'jpeg';
  if (format !== 'png' && format !== 'jpeg') {
    throw new TypeError('format must be png, jpeg, or jpg');
  }
  return format;
}

function normalizeQuality(value = 80) {
  if (value === undefined || value === null || value === '') return 80;
  const quality = Number(value);
  if (!Number.isInteger(quality) || quality < 1 || quality > 100) {
    throw new TypeError('quality must be an integer from 1 to 100');
  }
  return quality;
}

function normalizeCrop(crop) {
  if (crop === undefined || crop === null || crop === '') return undefined;

  if (typeof crop === 'string') {
    const parts = crop.split(',').map((part) => Number(part.trim()));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
      throw new TypeError('crop must be "x,y,w,h" or an object');
    }
    return {
      x: parts[0],
      y: parts[1],
      w: parts[2],
      h: parts[3],
    };
  }

  if (!isPlainObject(crop)) {
    throw new TypeError('crop must be "x,y,w,h" or an object');
  }

  const width = crop.w ?? crop.width;
  const height = crop.h ?? crop.height;
  return {
    x: assertFiniteNumber(crop.x, 'crop.x'),
    y: assertFiniteNumber(crop.y, 'crop.y'),
    w: assertPositiveInteger(Number(width), 'crop.w'),
    h: assertPositiveInteger(Number(height), 'crop.h'),
  };
}

function normalizeTarget(options = {}, fallbackMode = 'title') {
  const source = isPlainObject(options.window)
    ? { ...options, ...options.window }
    : { ...options };

  if (typeof options.window === 'string' && !source.name && !source.title && !source.process) {
    source.name = options.window;
    source.mode = source.mode || fallbackMode;
  }

  if (source.hwnd !== undefined && source.hwnd !== null && source.hwnd !== '') {
    return { hwnd: String(source.hwnd) };
  }

  if (source.process) {
    return { mode: 'process', name: assertNonEmptyString(String(source.process), 'process') };
  }

  if (source.title) {
    return { mode: 'title', name: assertNonEmptyString(String(source.title), 'title') };
  }

  if (source.name) {
    return {
      mode: String(source.mode || fallbackMode).toLowerCase(),
      name: assertNonEmptyString(String(source.name), 'name'),
    };
  }

  return {};
}

function normalizeCaptureOptions(options = {}) {
  const target = normalizeTarget(options, options.mode === 'process' ? 'process' : 'title');
  const mode = target.hwnd ? 'window' : String(options.mode || target.mode || 'screen').toLowerCase();
  const normalized = {
    mode,
    ...target,
    format: normalizeImageFormat(options.format),
    quality: normalizeQuality(options.quality),
  };

  const maxWidth = optionalPositiveInteger(options.max_width ?? options.maxWidth, 'max_width');
  if (maxWidth !== undefined) normalized.max_width = maxWidth;

  const crop = normalizeCrop(options.crop);
  if (crop) normalized.crop = crop;

  if (normalized.mode !== 'screen' && !normalized.hwnd && !normalized.name) {
    throw new TypeError('window capture requires name, process, title, or hwnd');
  }

  return normalized;
}

function normalizeButton(button = 'left') {
  const normalized = String(button || 'left').toLowerCase();
  if (!['left', 'right', 'middle'].includes(normalized)) {
    throw new TypeError('button must be left, right, or middle');
  }
  return normalized;
}

function normalizeClickOptions(options = {}) {
  return {
    ...normalizeTarget(options),
    x: assertFiniteNumber(options.x, 'x'),
    y: assertFiniteNumber(options.y, 'y'),
    button: normalizeButton(options.button),
    double: Boolean(options.double),
  };
}

function normalizeDragOptions(options = {}) {
  return {
    ...normalizeTarget(options),
    from_x: assertFiniteNumber(options.from_x ?? options.fromX, 'from_x'),
    from_y: assertFiniteNumber(options.from_y ?? options.fromY, 'from_y'),
    to_x: assertFiniteNumber(options.to_x ?? options.toX, 'to_x'),
    to_y: assertFiniteNumber(options.to_y ?? options.toY, 'to_y'),
    duration_ms: Math.max(0, Number(options.duration_ms ?? options.duration ?? 100)),
  };
}

function normalizeTypeOptions(options = {}) {
  return {
    ...normalizeTarget(options),
    text: assertString(options.text ?? '', 'text'),
  };
}

function normalizeScrollOptions(options = {}) {
  const normalized = {
    ...normalizeTarget(options),
    delta: assertFiniteNumber(options.delta, 'delta'),
  };

  if (options.x !== undefined && options.x !== null) normalized.x = assertFiniteNumber(options.x, 'x');
  if (options.y !== undefined && options.y !== null) normalized.y = assertFiniteNumber(options.y, 'y');
  return normalized;
}

function normalizeHotkeyOptions(options = {}) {
  const rawKeys = Array.isArray(options.keys)
    ? options.keys
    : assertNonEmptyString(String(options.keys || ''), 'keys').split('+');
  const keys = rawKeys.map((key, index) => assertNonEmptyString(String(key).trim(), `keys[${index}]`));
  return {
    ...normalizeTarget(options),
    keys,
  };
}

function normalizeWindowActionOptions(options = {}) {
  const target = normalizeTarget(options);
  if (!target.hwnd && !target.name) {
    throw new TypeError('window action requires name, process, title, window, or hwnd');
  }
  return target;
}

function normalizeMoveOptions(options = {}) {
  return {
    ...normalizeWindowActionOptions(options),
    x: assertFiniteNumber(options.x, 'x'),
    y: assertFiniteNumber(options.y, 'y'),
  };
}

function normalizeResizeOptions(options = {}) {
  return {
    ...normalizeWindowActionOptions(options),
    width: assertPositiveInteger(Number(options.width), 'width'),
    height: assertPositiveInteger(Number(options.height), 'height'),
  };
}

function normalizeClipboardOptions(options = {}) {
  const operation = String(options.action || options.operation || 'get').toLowerCase();
  if (!['get', 'set'].includes(operation)) {
    throw new TypeError('clipboard action must be get or set');
  }

  const normalized = { operation };
  if (operation === 'set') {
    normalized.text = assertString(options.text ?? '', 'text');
  }
  return normalized;
}

class WindowsPlatformAdapter extends BasePlatformAdapter {
  constructor(options = {}) {
    super({
      ...options,
      platform: 'win32',
      name: options.name || 'Windows',
      capabilities: options.capabilities || DEFAULT_CAPABILITIES,
    });
    this.powerShellCommand = options.powerShellCommand || options.powershellCommand || 'powershell';
  }

  runPowerShell(script, input = {}, options = {}) {
    const env = {
      ...process.env,
      ...(options.env || {}),
      PEEK_INPUT: JSON.stringify(input || {}),
    };

    return this.execTool(this.powerShellCommand, [...POWERSHELL_ARGS, script], {
      ...options,
      env,
    });
  }

  runPowerShellJson(script, input = {}, options = {}, fallback = null) {
    return parseJsonOutput(this.runPowerShell(script, input, options), fallback);
  }

  async listWindows(options = {}) {
    const result = this.runPowerShellJson(LIST_WINDOWS_SCRIPT, options, {}, { windows: [] });
    return Array.isArray(result) ? result : result.windows || [];
  }

  async capture(options = {}) {
    const request = normalizeCaptureOptions(options);
    const result = this.runPowerShellJson(CAPTURE_SCRIPT, request);

    if (!result || typeof result.image !== 'string' || result.image.length === 0) {
      throw new Error('Windows capture did not return image data');
    }

    return result;
  }

  async runInteraction(action, payload = {}, options = {}) {
    const result = this.runPowerShellJson(INTERACTION_SCRIPT, { action, ...payload }, options);
    if (!result || result.success !== true) {
      throw new Error(`Windows interaction failed: ${action}`);
    }
    return result;
  }

  async click(options = {}) {
    return this.runInteraction('click', normalizeClickOptions(options));
  }

  async drag(options = {}) {
    return this.runInteraction('drag', normalizeDragOptions(options));
  }

  async type(options = {}) {
    return this.runInteraction('type', normalizeTypeOptions(options));
  }

  async scroll(options = {}) {
    return this.runInteraction('scroll', normalizeScrollOptions(options));
  }

  async hotkey(options = {}) {
    return this.runInteraction('hotkey', normalizeHotkeyOptions(options));
  }

  async focus(options = {}) {
    return this.runInteraction('focus', normalizeWindowActionOptions(options));
  }

  async move(options = {}) {
    return this.runInteraction('move', normalizeMoveOptions(options));
  }

  async resize(options = {}) {
    return this.runInteraction('resize', normalizeResizeOptions(options));
  }

  async maximize(options = {}) {
    return this.runInteraction('maximize', normalizeWindowActionOptions(options));
  }

  async minimize(options = {}) {
    return this.runInteraction('minimize', normalizeWindowActionOptions(options));
  }

  async clipboard(options = {}) {
    return this.runInteraction('clipboard', normalizeClipboardOptions(options));
  }
}

module.exports = WindowsPlatformAdapter;
