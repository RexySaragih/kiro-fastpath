/**
 * Native folder picker for `fastpath ui`.
 * Browsers never expose an absolute OS path; this runs on the local machine.
 */
import { spawnSync } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';

export interface PickFolderResult {
  path: string | null;
  cancelled: boolean;
  error?: string;
}

function trimPicked(raw: string): string {
  let p = raw.trim().replace(/\r/g, '');
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) p = p.slice(0, -1);
  return p;
}

export function pickFolder(): PickFolderResult {
  const result =
    process.platform === 'darwin'
      ? spawnSync(
          'osascript',
          [
            '-e',
            'tell application "Finder" to activate',
            '-e',
            'POSIX path of (choose folder with prompt "Select a folder")',
          ],
          { encoding: 'utf8', timeout: 300_000 },
        )
      : process.platform === 'win32'
        ? spawnSync(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Select a folder"; if ($d.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { exit 1 }; $d.SelectedPath',
            ],
            { encoding: 'utf8', timeout: 300_000 },
          )
        : spawnZenityOrKdialog();

  if (result.error) {
    return { path: null, cancelled: false, error: result.error.message };
  }
  if (result.status !== 0) {
    const blob = `${result.stderr ?? ''}\n${result.stdout ?? ''}`.toLowerCase();
    if (result.status === 1 || /cancel/.test(blob)) {
      return { path: null, cancelled: true };
    }
    return {
      path: null,
      cancelled: false,
      error: (result.stderr || result.stdout || 'folder picker failed').trim(),
    };
  }
  const picked = trimPicked(result.stdout ?? '');
  if (!picked) return { path: null, cancelled: true };
  if (!isAbsolute(picked)) {
    return { path: null, cancelled: false, error: 'picker returned a relative path' };
  }
  return { path: resolve(picked), cancelled: false };
}

function spawnZenityOrKdialog() {
  const zenity = spawnSync(
    'zenity',
    ['--file-selection', '--directory', '--title=Select a folder'],
    { encoding: 'utf8', timeout: 300_000 },
  );
  if (!zenity.error && zenity.status !== 127) return zenity;
  return spawnSync('kdialog', ['--getexistingdirectory', '.'], {
    encoding: 'utf8',
    timeout: 300_000,
  });
}
