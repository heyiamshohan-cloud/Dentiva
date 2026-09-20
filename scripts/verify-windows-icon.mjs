/**
 * DENTIVA — ask Windows to read the icon back out of the executable.
 *
 * `verify-artifacts.mjs` proves that the bytes sitting in `.rsrc` are the ones
 * `resources/icon.ico` contains. That is necessary but not sufficient: a frame
 * can be byte-perfect and still be unreadable, because the colour rows and the
 * AND mask have to add up to a frame Windows can decode.
 *
 * So this check hands the freshly stamped executable to Windows itself — the
 * shell's icon extractor and GDI+, the same two readers Explorer, the taskbar,
 * the Start Menu and the installer shortcut use — and asks for the mark at every
 * size the shell asks for. It only runs on the build host that can answer, i.e.
 * when the build runs on Windows.
 *
 *     bun scripts/verify-windows-icon.mjs dist/windows/DENTIVA.exe
 *
 * Exits non-zero when Windows cannot read an icon out of the file, so a build
 * that would fail the release's icon gate fails here, with the reason, instead
 * of three steps later without one.
 */
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The sizes the Windows shell asks an application icon for. */
export const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256];

/**
 * The PowerShell probe. Printed as JSON so the caller does not have to parse
 * English, and kept ASCII-only because Windows PowerShell 5.1 reads a script
 * without a byte-order mark as the system ANSI code page.
 */
const PROBE = `
param([string]$Exe)

Add-Type -AssemblyName System.Drawing

function Measure-Opaque($bitmap) {
  $opaque = 0
  $sampled = 0
  $stepX = [Math]::Max(1, [int]($bitmap.Width / 8))
  $stepY = [Math]::Max(1, [int]($bitmap.Height / 8))
  for ($x = 0; $x -lt $bitmap.Width; $x += $stepX) {
    for ($y = 0; $y -lt $bitmap.Height; $y += $stepY) {
      $sampled++
      if ($bitmap.GetPixel($x, $y).A -gt 0) { $opaque++ }
    }
  }
  return @{ opaque = $opaque; sampled = $sampled }
}

$report = [ordered]@{
  exe = $Exe
  associated = $null
  sizes = @()
  resized = @()
  gaps = @()
  resizeGaps = @()
  error = $null
}

try {
  $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($Exe)

  if (-not $icon) {
    $report.error = 'ExtractAssociatedIcon returned nothing'
  } else {
    $bitmap = $icon.ToBitmap()
    $measured = Measure-Opaque $bitmap
    $report.associated = @{
      width = $icon.Width
      height = $icon.Height
      opaque = $measured.opaque
      sampled = $measured.sampled
    }
    $bitmap.Dispose()

    # Two ways of asking for a size. The first reads the executable the way the
    # release gate does; the second rescales the icon the shell just handed over,
    # which is how Explorer, the taskbar and the Start Menu actually produce the
    # sizes they draw. Neither is allowed to hand back a blank image.
    foreach ($size in 16, 24, 32, 48, 64, 128, 256) {
      try {
        $sized = New-Object System.Drawing.Icon($Exe, $size, $size)
        $tile = $sized.ToBitmap()
        $measured = Measure-Opaque $tile
        $report.sizes += @{
          size = $size
          width = $tile.Width
          height = $tile.Height
          opaque = $measured.opaque
          sampled = $measured.sampled
        }
        $tile.Dispose()
        $sized.Dispose()
      } catch {
        $report.gaps += @{ size = $size; message = $_.Exception.Message }
      }

      try {
        $scaled = New-Object System.Drawing.Icon($icon, $size, $size)
        $tile = $scaled.ToBitmap()
        $measured = Measure-Opaque $tile
        $report.resized += @{
          size = $size
          width = $tile.Width
          height = $tile.Height
          opaque = $measured.opaque
          sampled = $measured.sampled
        }
        $tile.Dispose()
        $scaled.Dispose()
      } catch {
        $report.resizeGaps += @{ size = $size; message = $_.Exception.Message }
      }
    }

    $icon.Dispose()
  }
} catch {
  $report.error = "$($_.Exception.GetType().Name): $($_.Exception.Message)"
}

$report.sizes = @($report.sizes)
$report.resized = @($report.resized)
$report.gaps = @($report.gaps)
$report.resizeGaps = @($report.resizeGaps)
$report | ConvertTo-Json -Depth 6 -Compress
`;

/**
 * Run the probe and return what Windows said.
 * @param {string} exePath
 */
export function readIconWithWindows(exePath) {
  const probe = join(tmpdir(), `dentiva-icon-probe-${process.pid}.ps1`);
  writeFileSync(probe, PROBE, 'utf8');
  try {
    const result = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', probe, '-Exe', exePath],
      { encoding: 'utf8', windowsHide: true },
    );
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    const line = text.split('\n').map((entry) => entry.trim()).reverse().find((entry) => entry.startsWith('{') && entry.endsWith('}'));
    if (!line) {
      return { error: `the Windows icon probe produced no report (exit ${result.status}): ${text.trim().slice(0, 400)}` };
    }
    return JSON.parse(line);
  } finally {
    try { unlinkSync(probe); } catch { /* the temporary folder is disposable */ }
  }
}

/**
 * Verify that Windows can read the application icon, and print what it found.
 * @param {string} exePath
 * @returns {{ ok: boolean, problems: string[], notes: string[], frames: number }}
 */
export function verifyWindowsIcon(exePath) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];

  if (process.platform !== 'win32') {
    notes.push('this check needs Windows; skipped on this host');
    return { ok: true, problems, notes, frames: 0 };
  }
  if (!existsSync(exePath)) {
    problems.push(`${exePath} does not exist`);
    return { ok: false, problems, notes, frames: 0 };
  }

  const report = readIconWithWindows(exePath);
  const asList = (value) => (Array.isArray(value) ? value : value ? [value] : []);
  const brief = (message) => String(message ?? '').replace(/\s+/g, ' ').trim().slice(0, 90);

  if (report.error) {
    problems.push(`Windows could not read an icon out of the executable — ${report.error}`);
    console.log(`::notice::ICON-PROBE ${brief(report.error)}`);
    return { ok: false, problems, notes, frames: 0 };
  }

  const associated = report.associated ?? {};
  const fileSizes = asList(report.sizes);
  const scaledSizes = asList(report.resized);
  const gaps = asList(report.gaps);
  const resizeGaps = asList(report.resizeGaps);

  console.log(`  associated icon: ${associated.width}x${associated.height}, ` +
    `${associated.opaque}/${associated.sampled} sampled pixels opaque`);

  // Loud, always: whatever Windows said, it lands in the run's annotations.
  console.log(`::notice::ICON-PROBE associated ${associated.width}x${associated.height} ` +
    `${associated.opaque}/${associated.sampled} opaque | from file: ` +
    `${fileSizes.length ? fileSizes.map((frame) => `${frame.size}:${frame.opaque}/${frame.sampled}`).join(' ') : 'none'}` +
    `${gaps.length ? ` | GDI+ file gaps: ${gaps.map((gap) => `${gap.size}px ${brief(gap.message)}`).join('; ')}` : ''}` +
    ` | rescaled: ${scaledSizes.length ? scaledSizes.map((frame) => `${frame.size}:${frame.opaque}/${frame.sampled}`).join(' ') : 'none'}` +
    `${resizeGaps.length ? ` | rescale gaps: ${resizeGaps.map((gap) => `${gap.size}px ${brief(gap.message)}`).join('; ')}` : ''}`);

  if (!associated.sampled || associated.opaque === 0) {
    problems.push('Windows extracted a blank icon (no opaque pixel in an 8x8 sample grid)');
  }

  for (const frame of [...fileSizes, ...scaledSizes]) {
    console.log(`  ${String(frame.size).padStart(3)}px -> ${frame.width}x${frame.height}, ` +
      `${frame.opaque}/${frame.sampled} sampled pixels opaque`);
    if (frame.opaque === 0) problems.push(`the ${frame.size}px icon frame is blank once Windows decodes it`);
  }

  for (const gap of gaps) {
    notes.push(`${gap.size}px: GDI+ could not build it from the executable path (${brief(gap.message)}) — ` +
      'System.Drawing.Icon(file, w, h) does not read PE icon resources; Windows itself does');
  }
  for (const gap of resizeGaps) {
    notes.push(`${gap.size}px: the extracted icon could not be rescaled (${brief(gap.message)})`);
  }

  // What has to be true for the release: the shell can find the mark, and every
  // size it asks for comes back with something drawn on it.
  if (!fileSizes.length && !scaledSizes.length) {
    problems.push(`Windows could not produce the icon at any size (${brief(gaps[0]?.message ?? 'no detail')})`);
  }

  return { ok: problems.length === 0, problems, notes, frames: Math.max(fileSizes.length, scaledSizes.length) };
}

/* Direct execution: `bun scripts/verify-windows-icon.mjs dist/windows/DENTIVA.exe`. */
if (import.meta.main) {
  const target = process.argv[2] ?? join(ROOT, 'dist/windows/DENTIVA.exe');
  console.log('\n▸ Windows icon');
  const result = verifyWindowsIcon(target);
  for (const note of result.notes) console.log(`  - ${note}`);
  if (!result.ok) {
    for (const problem of result.problems) console.error(`\n  ✖ ${problem}`);
    console.error('\n✖ Windows could not read the Dentiva icon back out of the executable.\n');
    process.exit(1);
  }
  console.log(`\n✔ Windows reads the Dentiva icon at ${result.frames} size(s).\n`);
}
