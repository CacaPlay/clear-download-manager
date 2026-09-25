//! Small, on-demand native clipboard reader for the unified link intake.
//!
//! This command deliberately does not persist clipboard contents and avoids
//! WebView2's navigator.clipboard permission prompt.  It is only called by
//! the focus-driven watcher after the frontend has decided that a check is
//! appropriate.

#[tauri::command]
pub(crate) fn read_clipboard_text() -> Result<String, String> {
    #[cfg(windows)]
    {
        read_windows_unicode_clipboard()
    }

    #[cfg(not(windows))]
    {
        Ok(String::new())
    }
}

/// Places one completed download in the Windows file clipboard. Explorer
/// understands CF_HDROP together with Preferred DropEffect, which preserves
/// the user's choice between copy and move without exposing the file contents
/// to the webview.
#[tauri::command]
pub(crate) fn set_file_clipboard(path: String, cut: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        write_windows_file_clipboard(path, cut)
    }

    #[cfg(not(windows))]
    {
        let _ = (path, cut);
        Err("El portapapeles de archivos solo está disponible en Windows".to_string())
    }
}

/// Starts a real Windows shell drag for one completed file.  This is separate
/// from the clipboard command: Explorer and apps such as WhatsApp require an
/// OLE IDataObject/CF_HDROP drag source rather than a webview DownloadURL.
#[tauri::command]
pub(crate) fn start_file_drag(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        start_windows_file_drag(path)
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Err("El arrastre nativo solo está disponible en Windows".to_string())
    }
}

#[cfg(windows)]
fn read_windows_unicode_clipboard() -> Result<String, String> {
    use std::ffi::c_void;
    use std::ptr::null_mut;
    use std::slice;

    type HGlobal = *mut c_void;
    type HWnd = *mut c_void;

    const CF_UNICODETEXT: u32 = 13;

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(owner: HWnd) -> i32;
        fn CloseClipboard() -> i32;
        fn GetClipboardData(format: u32) -> HGlobal;
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalLock(handle: HGlobal) -> *mut c_void;
        fn GlobalUnlock(handle: HGlobal) -> i32;
        fn GlobalSize(handle: HGlobal) -> usize;
    }

    // Clipboard ownership is process-global. Browsers and WebView2 can hold
    // it briefly while a copy operation completes, so use a short bounded
    // retry instead of converting that normal race into a silent miss.
    let mut opened = false;
    for attempt in 0..8 {
        if unsafe { OpenClipboard(null_mut()) } != 0 {
            opened = true;
            break;
        }
        if attempt < 7 {
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
    }
    if !opened {
        return Ok(String::new());
    }

    let handle = unsafe { GetClipboardData(CF_UNICODETEXT) };
    if handle.is_null() {
        unsafe { CloseClipboard() };
        return Ok(String::new());
    }

    let pointer = unsafe { GlobalLock(handle) } as *const u16;
    if pointer.is_null() {
        unsafe { CloseClipboard() };
        return Ok(String::new());
    }

    let max_units = unsafe { GlobalSize(handle) } / std::mem::size_of::<u16>();
    let mut length = 0usize;
    if max_units > 0 {
        let data = unsafe { slice::from_raw_parts(pointer, max_units) };
        while length < data.len() && data[length] != 0 {
            length += 1;
        }
    }
    let text = if length == 0 {
        String::new()
    } else {
        let data = unsafe { slice::from_raw_parts(pointer, length) };
        String::from_utf16_lossy(data)
    };

    unsafe {
        GlobalUnlock(handle);
        CloseClipboard();
    }
    Ok(text)
}

#[cfg(windows)]
fn write_windows_file_clipboard(path: String, cut: bool) -> Result<(), String> {
    use std::ffi::{c_void, OsStr};
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr::{copy_nonoverlapping, null_mut};

    type HGlobal = *mut c_void;
    type HWnd = *mut c_void;

    const CF_HDROP: u32 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;
    const DROP_EFFECT_COPY: u32 = 1;
    const DROP_EFFECT_MOVE: u32 = 2;

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        point_x: i32,
        point_y: i32,
        non_client: i32,
        wide: i32,
    }

    #[link(name = "user32")]
    unsafe extern "system" {
        fn OpenClipboard(owner: HWnd) -> i32;
        fn CloseClipboard() -> i32;
        fn EmptyClipboard() -> i32;
        fn SetClipboardData(format: u32, data: HGlobal) -> HGlobal;
        fn RegisterClipboardFormatW(name: *const u16) -> u32;
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> HGlobal;
        fn GlobalFree(handle: HGlobal) -> HGlobal;
        fn GlobalLock(handle: HGlobal) -> *mut c_void;
        fn GlobalUnlock(handle: HGlobal) -> i32;
    }

    let file_path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "La ruta no existe".to_string())?;
    // CF_HDROP and the Shell PIDL APIs expect normal Win32 paths. Rust may
    // return an extended `\\?\\` path from canonicalize, which Explorer can
    // reject when pasting even though other clients accept it.
    let file_path = normalize_windows_shell_path(file_path);
    if !file_path.is_file() {
        return Err("La ruta no corresponde a un archivo".to_string());
    }

    let mut wide_path: Vec<u16> = OsStr::new(&file_path).encode_wide().collect();
    wide_path.extend([0, 0]);
    let header_size = size_of::<DropFiles>();
    let payload_size = header_size
        .checked_add(wide_path.len() * size_of::<u16>())
        .ok_or_else(|| "La ruta es demasiado larga".to_string())?;

    let mut opened = false;
    for attempt in 0..8 {
        if unsafe { OpenClipboard(null_mut()) } != 0 {
            opened = true;
            break;
        }
        if attempt < 7 {
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
    }
    if !opened {
        return Err("No se pudo abrir el portapapeles".to_string());
    }

    let result = (|| {
        if unsafe { EmptyClipboard() } == 0 {
            return Err("No se pudo preparar el portapapeles".to_string());
        }
        let handle = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, payload_size) };
        if handle.is_null() {
            return Err("No se pudo reservar el portapapeles".to_string());
        }
        let pointer = unsafe { GlobalLock(handle) };
        if pointer.is_null() {
            unsafe { GlobalFree(handle) };
            return Err("No se pudo escribir el portapapeles".to_string());
        }
        let header = DropFiles {
            p_files: header_size as u32,
            point_x: 0,
            point_y: 0,
            non_client: 0,
            wide: 1,
        };
        unsafe {
            copy_nonoverlapping(
                (&header as *const DropFiles).cast::<u8>(),
                pointer.cast::<u8>(),
                header_size,
            );
            copy_nonoverlapping(
                wide_path.as_ptr().cast::<u8>(),
                pointer.cast::<u8>().add(header_size),
                wide_path.len() * size_of::<u16>(),
            );
            GlobalUnlock(handle);
        }
        if unsafe { SetClipboardData(CF_HDROP, handle) }.is_null() {
            unsafe { GlobalFree(handle) };
            return Err("No se pudo asignar el archivo al portapapeles".to_string());
        }

        let format_name: Vec<u16> = OsStr::new("Preferred DropEffect")
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let format = unsafe { RegisterClipboardFormatW(format_name.as_ptr()) };
        if format == 0 {
            return Err("No se pudo configurar la operación del archivo".to_string());
        }
        let effect = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, size_of::<u32>()) };
        if effect.is_null() {
            return Err("No se pudo configurar la operación del archivo".to_string());
        }
        let effect_pointer = unsafe { GlobalLock(effect) };
        if effect_pointer.is_null() {
            unsafe { GlobalFree(effect) };
            return Err("No se pudo configurar la operación del archivo".to_string());
        }
        let value = if cut {
            DROP_EFFECT_MOVE
        } else {
            DROP_EFFECT_COPY
        };
        unsafe {
            *(effect_pointer.cast::<u32>()) = value;
            GlobalUnlock(effect);
        }
        if unsafe { SetClipboardData(format, effect) }.is_null() {
            unsafe { GlobalFree(effect) };
            return Err("No se pudo configurar la operación del archivo".to_string());
        }
        Ok(())
    })();
    unsafe {
        CloseClipboard();
    }
    result
}

#[cfg(windows)]
fn start_windows_file_drag(path: String) -> Result<(), String> {
    use std::ffi::OsStr;
    use std::mem::size_of;
    use std::os::windows::ffi::OsStrExt;
    use std::path::PathBuf;
    use std::ptr::{copy_nonoverlapping, null_mut};
    use std::sync::atomic::{AtomicU32, Ordering};

    type HResult = i32;
    type Pidl = *mut std::ffi::c_void;
    type IDataObject = std::ffi::c_void;
    const S_OK: HResult = 0;
    const S_FALSE: HResult = 1;
    const E_NOINTERFACE: HResult = 0x8004_0042u32 as i32;
    const DRAGDROP_S_DROP: HResult = 0x0004_0100;
    const DRAGDROP_S_CANCEL: HResult = 0x0004_0101;
    const DRAGDROP_S_USEDEFAULTCURSORS: HResult = 0x0004_0102;
    const DROPEFFECT_COPY: u32 = 1;
    const CF_HDROP: u16 = 15;
    const GMEM_MOVEABLE: u32 = 0x0002;
    const GMEM_ZEROINIT: u32 = 0x0040;
    const TYMED_HGLOBAL: u32 = 1;
    const DVASPECT_CONTENT: u32 = 1;

    unsafe fn release_shell_data_object(data: *mut std::ffi::c_void) {
        if data.is_null() {
            return;
        }
        let vtbl = *data.cast::<*const usize>();
        let release = *vtbl.add(2);
        let release_fn: extern "system" fn(*mut std::ffi::c_void) -> u32 =
            std::mem::transmute(release);
        release_fn(data);
    }

    #[repr(C)]
    struct DropFiles {
        p_files: u32,
        point_x: i32,
        point_y: i32,
        non_client: i32,
        wide: i32,
    }
    #[repr(C)]
    struct FormatEtc {
        cf_format: u16,
        ptd: *mut std::ffi::c_void,
        dw_aspect: u32,
        lindex: i32,
        tymed: u32,
    }
    #[repr(C)]
    union StgMediumData {
        global: *mut std::ffi::c_void,
        pointer: *mut std::ffi::c_void,
    }
    #[repr(C)]
    struct StgMedium {
        tymed: u32,
        data: StgMediumData,
        p_unk_for_release: *mut std::ffi::c_void,
    }

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GlobalAlloc(flags: u32, bytes: usize) -> *mut std::ffi::c_void;
        fn GlobalFree(handle: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GlobalLock(handle: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
        fn GlobalUnlock(handle: *mut std::ffi::c_void) -> i32;
    }

    #[repr(C)]
    #[derive(Clone, Copy, PartialEq, Eq)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[repr(C)]
    struct DropSourceVtbl {
        query_interface: unsafe extern "system" fn(
            *mut DropSource,
            *const Guid,
            *mut *mut std::ffi::c_void,
        ) -> HResult,
        add_ref: unsafe extern "system" fn(*mut DropSource) -> u32,
        release: unsafe extern "system" fn(*mut DropSource) -> u32,
        query_continue_drag: unsafe extern "system" fn(*mut DropSource, i32, u32) -> HResult,
        give_feedback: unsafe extern "system" fn(*mut DropSource, u32) -> HResult,
    }
    #[repr(C)]
    struct DropSource {
        vtbl: *const DropSourceVtbl,
        refs: AtomicU32,
    }

    const IID_IUNKNOWN: Guid = Guid {
        data1: 0,
        data2: 0,
        data3: 0,
        data4: [0, 0, 0, 0, 0, 0, 0, 0x46],
    };
    const IID_IDROPSOURCE: Guid = Guid {
        data1: 0x0000_0121,
        data2: 0,
        data3: 0,
        data4: [0, 0, 0, 0, 0, 0, 0, 0x46],
    };
    unsafe extern "system" fn query_interface(
        this: *mut DropSource,
        riid: *const Guid,
        out: *mut *mut std::ffi::c_void,
    ) -> HResult {
        if out.is_null() || riid.is_null() {
            return E_NOINTERFACE;
        }
        if *riid == IID_IUNKNOWN || *riid == IID_IDROPSOURCE {
            *out = this.cast();
            ((*(*this).vtbl).add_ref)(this);
            S_OK
        } else {
            *out = null_mut();
            E_NOINTERFACE
        }
    }
    unsafe extern "system" fn add_ref(this: *mut DropSource) -> u32 {
        (*this).refs.fetch_add(1, Ordering::Relaxed) + 1
    }
    unsafe extern "system" fn release(this: *mut DropSource) -> u32 {
        let remaining = (*this).refs.fetch_sub(1, Ordering::Release) - 1;
        if remaining == 0 {
            std::sync::atomic::fence(Ordering::Acquire);
            drop(Box::from_raw(this));
        }
        remaining
    }
    unsafe extern "system" fn query_continue_drag(
        _this: *mut DropSource,
        escape: i32,
        buttons: u32,
    ) -> HResult {
        if escape != 0 {
            return DRAGDROP_S_CANCEL;
        }
        if buttons == 0 {
            DRAGDROP_S_DROP
        } else {
            S_OK
        }
    }
    unsafe extern "system" fn give_feedback(_this: *mut DropSource, _effect: u32) -> HResult {
        DRAGDROP_S_USEDEFAULTCURSORS
    }
    static DROP_SOURCE_VTBL: DropSourceVtbl = DropSourceVtbl {
        query_interface,
        add_ref,
        release,
        query_continue_drag,
        give_feedback,
    };

    #[link(name = "ole32")]
    unsafe extern "system" {
        fn OleInitialize(reserved: *mut std::ffi::c_void) -> HResult;
        fn OleUninitialize();
        fn CoTaskMemFree(pointer: *mut std::ffi::c_void);
        fn DoDragDrop(
            data_object: *mut IDataObject,
            drop_source: *mut DropSource,
            allowed_effects: u32,
            effect: *mut u32,
        ) -> HResult;
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn CIDLData_CreateFromIDArray(
            folder: Pidl,
            count: u32,
            children: *const Pidl,
            out: *mut *mut IDataObject,
        ) -> HResult;
        fn SHParseDisplayName(
            name: *const u16,
            bind_ctx: *mut std::ffi::c_void,
            pidl: *mut Pidl,
            attrs: u32,
            attrs_out: *mut u32,
        ) -> HResult;
    }

    let file_path = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "La ruta no existe".to_string())?;
    let file_path = normalize_windows_shell_path(file_path);
    if !file_path.is_file() {
        return Err("La ruta no corresponde a un archivo".to_string());
    }
    let wide: Vec<u16> = OsStr::new(&file_path)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    // DoDragDrop requires OLE initialization, not merely a COM apartment.
    // OleInitialize also sets up the shell drag image and drop-target bridge.
    let init = unsafe { OleInitialize(null_mut()) };
    if init != S_OK && init != S_FALSE {
        return Err(format!("No se pudo inicializar OLE ({init:#x})"));
    }
    let result = (|| {
        let mut pidl: Pidl = null_mut();
        let mut attrs = 0u32;
        let hr = unsafe { SHParseDisplayName(wide.as_ptr(), null_mut(), &mut pidl, 0, &mut attrs) };
        if hr < 0 || pidl.is_null() {
            return Err(format!(
                "No se pudo preparar el archivo para arrastrar ({hr:#x})"
            ));
        }
        let children = [pidl];
        let mut data: *mut IDataObject = null_mut();
        // A null folder explicitly means that the array contains fully
        // qualified PIDLs. Keep the Shell IDList formats, then add an explicit
        // CF_HDROP payload because many external drop targets only request
        // this standard list-of-files format.
        let hr = unsafe { CIDLData_CreateFromIDArray(null_mut(), 1, children.as_ptr(), &mut data) };
        if hr < 0 || data.is_null() {
            unsafe {
                CoTaskMemFree(pidl);
            }
            return Err(format!("No se pudo crear el objeto de arrastre ({hr:#x})"));
        }
        let mut wide_path: Vec<u16> = OsStr::new(&file_path).encode_wide().collect();
        wide_path.extend([0, 0]);
        let header_size = size_of::<DropFiles>();
        let Some(payload_size) = header_size.checked_add(wide_path.len() * size_of::<u16>()) else {
            unsafe {
                release_shell_data_object(data);
                CoTaskMemFree(pidl);
            }
            return Err("La ruta es demasiado larga".to_string());
        };
        let hdrop = unsafe { GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, payload_size) };
        if hdrop.is_null() {
            unsafe {
                release_shell_data_object(data);
                CoTaskMemFree(pidl);
            }
            return Err("No se pudo preparar el archivo para arrastrar".to_string());
        }
        let memory = unsafe { GlobalLock(hdrop) };
        if memory.is_null() {
            unsafe {
                GlobalFree(hdrop);
                release_shell_data_object(data);
                CoTaskMemFree(pidl);
            }
            return Err("No se pudo preparar la ruta del archivo para arrastrar".to_string());
        }
        let header = DropFiles {
            p_files: header_size as u32,
            point_x: 0,
            point_y: 0,
            non_client: 0,
            wide: 1,
        };
        unsafe {
            copy_nonoverlapping(
                (&header as *const DropFiles).cast::<u8>(),
                memory.cast::<u8>(),
                header_size,
            );
            copy_nonoverlapping(
                wide_path.as_ptr().cast::<u8>(),
                memory.cast::<u8>().add(header_size),
                wide_path.len() * size_of::<u16>(),
            );
            GlobalUnlock(hdrop);
        }
        let mut format = FormatEtc {
            cf_format: CF_HDROP,
            ptd: null_mut(),
            dw_aspect: DVASPECT_CONTENT,
            lindex: -1,
            tymed: TYMED_HGLOBAL,
        };
        let mut medium = StgMedium {
            tymed: TYMED_HGLOBAL,
            data: StgMediumData { global: hdrop },
            p_unk_for_release: null_mut(),
        };
        let vtbl = unsafe { *data.cast::<*const usize>() };
        let set_data_pointer = unsafe { *vtbl.add(7) };
        let set_data: unsafe extern "system" fn(
            *mut IDataObject,
            *mut FormatEtc,
            *mut StgMedium,
            i32,
        ) -> HResult = unsafe { std::mem::transmute(set_data_pointer) };
        let set_result = unsafe { set_data(data, &mut format, &mut medium, 1) };
        if set_result < 0 {
            unsafe {
                GlobalFree(hdrop);
                release_shell_data_object(data);
                CoTaskMemFree(pidl);
            }
            return Err(format!(
                "No se pudo exponer el formato de archivo CF_HDROP ({set_result:#x})"
            ));
        }
        let source = Box::into_raw(Box::new(DropSource {
            vtbl: &DROP_SOURCE_VTBL,
            refs: AtomicU32::new(1),
        }));
        let mut effect = 0u32;
        let drag_hr = unsafe { DoDragDrop(data, source, DROPEFFECT_COPY, &mut effect) };
        unsafe {
            release_shell_data_object(data);
            CoTaskMemFree(pidl);
            ((*(*source).vtbl).release)(source);
        }
        // DoDragDrop returns DRAGDROP_S_DROP when the target accepted the
        // file. It is a success HRESULT (despite being non-zero); treating it
        // as an error made a completed Explorer drop look rejected to CDM.
        if drag_hr == DRAGDROP_S_DROP || drag_hr == DRAGDROP_S_CANCEL || drag_hr == S_OK {
            Ok(())
        } else {
            Err(format!("El arrastre fue rechazado ({drag_hr:#x})"))
        }
    })();
    unsafe {
        OleUninitialize();
    }
    result
}

#[cfg(windows)]
fn normalize_windows_shell_path(path: std::path::PathBuf) -> std::path::PathBuf {
    let value = path.to_string_lossy();
    if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = value.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    path
}
