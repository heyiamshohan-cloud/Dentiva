# Installing Dentiva 1.0.0

Dentiva is a Windows desktop application for a single clinic computer. It has no server
component, no internet requirement and no administrator password to remember: everything is
installed for the current user.

---

## 1. What you need

| Item | Requirement |
| --- | --- |
| Windows | Windows 10 (1809 or later) or Windows 11, 64-bit |
| Memory | 2 GB RAM minimum, 4 GB recommended |
| Disk | ~250 MB for the application plus space for your patient database and attachments |
| Display | 1280 × 720 minimum; scales correctly at 100 %, 125 %, 150 %, 175 % and 200 % |
| Printer | Any Windows-installed printer; thermal 80 mm / 58 mm receipt printers supported |
| Internet | Not required at any point — not for installation and not for use |

Legal paper at 100 % scale is the *only* thing that needs a larger screen: for the A5 and
A4 documents below 1280 px wide the app lays documents out on their own print page and the
screen layout stays intact.

---

## 2. Install from the release archive

1. Copy `DENTIVA-1.0.0-win-x64.zip` to the clinic computer and extract it (right-click →
   *Extract All…*). Do not run the installer from inside the zip preview.
2. Open the extracted folder and double-click **`install.cmd`**.
3. The installer writes the application to `%LOCALAPPDATA%\Programs\Dentiva`, creates a
   **Start Menu** shortcut, a **Desktop** shortcut, and registers an entry in
   *Settings → Apps → Installed apps* so it can be removed the normal Windows way.
4. Start Dentiva from the Start Menu. The first launch opens the setup wizard and asks for
   **your** clinic details and **your** owner account. Nothing is pre-filled with sample data.

The installer never touches patient data: your database lives outside the installation folder
and survives upgrades, repairs and uninstalls.

### Installer options

Run from an elevated or normal PowerShell window:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1                 # per-user (default)
powershell -ExecutionPolicy Bypass -File install.ps1 -Desktop:$false # no desktop shortcut
powershell -ExecutionPolicy Bypass -File install.ps1 -AllUsers       # Program Files (admin)
powershell -ExecutionPolicy Bypass -File install.ps1 -InstallDir 'D:\Apps\Dentiva'
powershell -ExecutionPolicy Bypass -File install.ps1 -Portable       # USB stick mode
```

---

The installed `DENTIVA.exe` is byte-identical to the one in the archive, so the identity checks in
§10 apply to the installed copy as well.

---

## 3. Portable / USB mode

Extract the archive anywhere — a USB stick, a network folder, a second computer — and run
`DENTIVA.exe` directly. With no other arguments Dentiva stores its data next to the
executable in a `data` folder, so the whole practice (program + database + attachments) travels
on the stick.

Create the folder explicitly first if you want to be sure:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1 -Portable
```

---

## 4. First run

| Step | What happens |
| --- | --- |
| 1 | `DENTIVA.exe` starts, creates your data folder and opens the application window. |
| 2 | The setup wizard asks for clinic name, code, phone/e-mail, address, country, currency, language and date/time format. |
| 3 | It asks for the treating practitioner (dentist) name and designation. |
| 4 | It asks for the owner account: username, display name and password. Choose a password you trust — the application cannot recover it for you. |
| 5 | You are signed in and taken to the Dashboard. Clinic defaults (expense/income categories, appointment types, inventory categories, payment methods) are installed automatically. |

The wizard appears only while the database has no user account. Afterwards, change clinic
details in **Settings → Clinic**, and add people in **Users**. It is deliberately not possible
to re-run the wizard over live data — the wizard is what creates the data.

---

## 5. Command-line switches

`DENTIVA.exe` is a normal desktop application, but it also understands these switches — useful
for shortcuts, IT scripts and diagnostics. Open a Command Prompt in the folder to use them.

| Switch | Effect |
| --- | --- |
| `--data <dir>` | Use a specific data folder (database, attachments, logs, backups) |
| `--portable` | Force data into a `data` folder beside the executable |
| `--port <n>` | Use a fixed local HTTP port instead of a free one |
| `--browser <path>` | Use a specific browser executable for the application window |
| `--help` | Print the switch list |
| `--open` | Always open the application window, even if an instance is already running |
| `--size <w,h>` | Initial window size (default `1440,900`) |
| `--no-window` | Start the local server only; open the UI yourself at the printed URL |
| `--quiet` | Suppress informational console output |
| `--dev` | Development mode (verbose logging, no window host enforcement) |
| `--self-test` | Run the built-in diagnostics and exit — proves the executable and its database work |
| `--version` | Print the application version, build number and schema version and exit |
| `--stop` | Stop a running instance of Dentiva for this data folder |

Starting the application twice with the same data folder is safe: the second launch detects the
running instance and focuses the existing window instead of opening a second copy of the
database.

---

## 6. Where your data lives

| Path | Contents |
| --- | --- |
| `%LOCALAPPDATA%\Dentiva\dentiva.db` | The clinic database (SQLite) |
| `%LOCALAPPDATA%\Dentiva\attachments\` | Files attached to patients, visits and treatments |
| `%LOCALAPPDATA%\Dentiva\backups\` | Backups created by the application |
| `%LOCALAPPDATA%\Dentiva\logs\` | `launcher-YYYY-MM-DD.log` — startup and error diagnostics |
| `%LOCALAPPDATA%\Dentiva\exports\` | CSV/JSON exports written by the Data screen |
| `%LOCALAPPDATA%\Dentiva\browser\` | The isolated browser profile used for the app window |
| `%LOCALAPPDATA%\Dentiva\temp\` | Scratch space used while restoring a backup |
| `%LOCALAPPDATA%\Dentiva\instance.json` | Single-instance lock for the current session |

With `--portable`, `--data` or `DENTIVA_DATA_DIR`, the same tree is created inside the folder
you chose.

**Back up this folder and you have backed up the practice.** The in-app **Backup** screen
creates, verifies and restores archives without closing the application, and can schedule
automatic daily/weekly/monthly backups with a retention count.

---

## 7. Upgrading

1. Take a backup (**Backup → Create backup**) or copy the data folder.
2. Extract the new archive over the old one, or run the new installer — it replaces program
   files and keeps your data folder untouched.
3. Start Dentiva. Any database migrations run automatically on start-up, are additive, and are
   recorded in the `schema_migrations` table. A migration never drops or rewrites patient,
   clinical or financial records, and each one runs inside a transaction.

---

## 8. Uninstalling

* **Settings → Apps → Installed apps → Dentiva → Uninstall**, or
  `powershell -ExecutionPolicy Bypass -File uninstall.ps1`.
* Uninstalling removes the program files and shortcuts. Your database, attachments and
  backups stay in `%LOCALAPPDATA%\Dentiva` so an accidental uninstall never destroys patient
  records.
* To remove the data as well, run
  `powershell -ExecutionPolicy Bypass -File uninstall.ps1 -RemoveData` — this asks for
  confirmation first and cannot be undone.

---

## 9. Troubleshooting

| Symptom | What to do |
| --- | --- |
| A message box appears saying Dentiva could not start | It shows the path of the log file; open it — the last lines name the cause. Most often the data folder is not writable. |
| The window does not open but the taskbar shows Dentiva | Microsoft Edge or Google Chrome was not found, so the default browser is used instead. Run `DENTIVA.exe --browser "C:\path\to\chrome.exe"`, or `DENTIVA.exe --no-window` and open the printed address. |
| Second copy will not start | By design. Use `DENTIVA.exe --stop`, or run it with a different `--data` folder. |
| Printing looks wrong | Check **Settings → Printing**: default paper (A4/A5/Letter/Legal/thermal 80 mm/58 mm), orientation, margins and scale. The *Save as PDF* printer gives you a PDF without any extra software. |
| A document window does not appear | Your browser blocked the pop-up; allow pop-ups for the local address, then print again. |
| Bengali text shows as boxes | Update the archive — fonts are embedded; a broken copy is the usual cause. Re-extract the zip. |
| You forgot the owner password | Deliberate design: there is no back door. Restore a backup, or open the database directly with the credentials of another Owner account. Administrator recovery is described in `docs/SECURITY.md`. |

Diagnostics that help when reporting a problem:

```powershell
DENTIVA.exe --version       # Dentiva 1.0.0 (build 100, schema v10)
DENTIVA.exe --self-test     # starts the engine, checks the API, prints JSON, exits
```

Both print machine-readable output and never modify your data. `--self-test` is the quickest way
to confirm that an installation is healthy: it reports `ok`, the version, the build, the schema
version and the data folder it used. It is also what `install.ps1` runs at the end of an install.

---

## 10. Checking you have the genuine build

The executable carries its own identity, so you can verify a copy without opening it:

* **Right-click `DENTIVA.exe` → Properties → Details.** You should see *Product name* `Dentiva`,
  *File description* `Dentiva — Dental Practice Management System`, *File version* and *Product
  version* `1.0.0.100`, *Company* `Md. Shohan Khan` and *Copyright* `© 2026 Md. Shohan Khan`.
* **The icon in Explorer, the taskbar, the Start Menu and Alt-Tab** is the teal tooth mark at every
  size Windows asks for (16–256 px). A generic or Bun-shaped icon means the file is not a Dentiva
  build.
* **The SHA-256 checksums** in `dist/SHA256SUMS.txt` (also inside the release archive) must match:

  ```powershell
  Get-FileHash .\DENTIVA.exe -Algorithm SHA256
  ```

* Builders can re-verify everything from source: `bun run verify:exe` reports the icon and version
  resources, and `bun run verify:artifacts` re-checks the checksums, the PE headers, the executable
  identity, the archive contents and that no test data reached the artifacts.
* To build the release **on Windows** instead of cross-compiling, run the pipeline in
  `resources/ci/release-windows.yml` on a Windows runner. GitHub only accepts workflow files from an
  account with the `workflows` permission, so copy it in once and push it — from a clone with your
  own account:

  ```bash
  mkdir -p .github/workflows
  cp resources/ci/release-windows.yml .github/workflows/release-windows.yml
  git add .github/workflows/release-windows.yml
  git commit -m "Add the Windows release pipeline"
  git push
  ```

  Then open **Actions → Build and verify the Windows release → Run workflow**. The run rebuilds the
  executable natively, reads the icon and version resource back out, runs `--self-test`, drives the
  packaged application end to end, checks the installer and the uninstaller, records a Defender scan
  and publishes the artefacts with checksums — and its evidence is what a Windows-side verification
  claim can be based on.

**Windows SmartScreen.** Dentiva is not code-signed (a certificate costs money every year and is a
distribution decision for the vendor), so the first launch may show *"Windows protected your PC"*.
Choose *More info* → *Run anyway*. The verification steps above are the honest substitute for a
signature: they prove the file is the one this repository built. Once the publisher buys a
certificate, `signtool` can sign the same executable without any code change.
