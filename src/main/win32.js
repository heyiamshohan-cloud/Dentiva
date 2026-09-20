/**
 * DENTIVA — Windows shell helpers.
 *
 * The launcher is a GUI-subsystem program (no console window appears when the
 * clinic double-clicks it), so the two things a GUI program still needs are
 * done through `kernel32`/`user32`:
 *
 *   • `attachParentConsole()` — when Dentiva is started from `cmd.exe` with a
 *     command-line switch (`--self-test`, `--stop`, …) the output of that
 *     console is re-attached so the switches behave like ordinary tools;
 *   • `showErrorMessage()` — a native message box for a launch that failed
 *     before any window could open. Without it a GUI process would fail
 *     silently.
 *
 * Everything here is best-effort: on other platforms, or if FFI is unavailable,
 * the functions quietly do nothing and the caller falls back to stdout/stderr.
 * No library is loaded unless it is actually needed.
 */

/** @type {any} */
let kernel32 = null;
/** @type {any} */
let user32 = null;
let kernelTried = false;
let userTried = false;

async function ffi() {
  try {
    return await import('bun:ffi');
  } catch {
    return null;
  }
}

async function loadKernel32() {
  if (kernelTried) return kernel32;
  kernelTried = true;
  const api = await ffi();
  if (!api || process.platform !== 'win32') return null;
  try {
    kernel32 = api.dlopen('kernel32.dll', {
      AttachConsole: { args: [api.FFIType.u32], returns: api.FFIType.bool },
      FreeConsole: { args: [], returns: api.FFIType.bool },
      GetConsoleWindow: { args: [], returns: api.FFIType.ptr },
    });
  } catch {
    kernel32 = null;
  }
  return kernel32;
}

async function loadUser32() {
  if (userTried) return user32;
  userTried = true;
  const api = await ffi();
  if (!api || process.platform !== 'win32') return null;
  try {
    user32 = api.dlopen('user32.dll', {
      MessageBoxW: { args: [api.FFIType.ptr, api.FFIType.ptr, api.FFIType.ptr, api.FFIType.u32], returns: api.FFIType.i32 },
    });
  } catch {
    user32 = null;
  }
  return user32;
}

/** UTF-16LE, NUL-terminated buffer for the wide-character Win32 APIs. */
function wide(text) {
  return Buffer.from(`${String(text)}\0`, 'utf16le');
}

/**
 * Re-attach the console of the process that started us (cmd.exe, PowerShell).
 * @returns {Promise<boolean>} true when a console was attached
 */
export async function attachParentConsole() {
  const lib = await loadKernel32();
  if (!lib) return false;
  try {
    // ATTACH_PARENT_PROCESS = -1 (u32)
    return Boolean(lib.symbols.AttachConsole(0xffffffff));
  } catch {
    return false;
  }
}

/** Detach from a console this process may have inherited. */
export async function detachConsole() {
  const lib = await loadKernel32();
  if (!lib) return false;
  try {
    return Boolean(lib.symbols.FreeConsole());
  } catch {
    return false;
  }
}

/**
 * Native error dialog (MB_OK | MB_ICONERROR | MB_SETFOREGROUND).
 * @param {string} title
 * @param {string} message
 */
export async function showErrorMessage(title, message) {
  const lib = await loadUser32();
  if (!lib) return false;
  const api = await ffi();
  if (!api) return false;
  try {
    const text = wide(message);
    const caption = wide(title);
    lib.symbols.MessageBoxW(0, api.ptr(text), api.ptr(caption), 0x10 | 0x10000);
    return true;
  } catch {
    return false;
  }
}

/** True when the process has a console window of its own. */
export async function hasConsoleWindow() {
  const lib = await loadKernel32();
  if (!lib) return false;
  try {
    const handle = lib.symbols.GetConsoleWindow();
    return Boolean(handle);
  } catch {
    return false;
  }
}

export default { attachParentConsole, detachConsole, showErrorMessage, hasConsoleWindow };
