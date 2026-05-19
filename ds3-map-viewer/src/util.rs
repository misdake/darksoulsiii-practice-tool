use std::ffi::OsString;
use std::fs::OpenOptions;
use std::io::Write;
use std::os::windows::prelude::OsStringExt;
use std::path::PathBuf;
use std::ptr::null_mut;
use std::time::{SystemTime, UNIX_EPOCH};

use hudhook::tracing::error;
use windows::core::PCSTR;
use windows::Win32::Foundation::{HMODULE, MAX_PATH};
use windows::Win32::System::LibraryLoader::{
    GetModuleFileNameW, GetModuleHandleExA, GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
    GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
};

/// Returns the path of the implementor's DLL.
pub fn get_dll_path() -> Option<PathBuf> {
    let mut hmodule = HMODULE(null_mut());
    // SAFETY
    // This is reckless, but it should never fail, and if it does, it's ok to crash
    // and burn.
    if let Err(e) = unsafe {
        GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
            PCSTR("DllMain".as_ptr() as _),
            &mut hmodule,
        )
    } {
        error!("get_dll_path: GetModuleHandleExA error: {e:?}");
        return None;
    }

    let mut sz_filename = [0u16; MAX_PATH as usize];
    // SAFETY
    // pointer to sz_filename always defined and MAX_PATH bounds manually checked
    let len = unsafe { GetModuleFileNameW(Some(hmodule), &mut sz_filename) } as usize;

    Some(OsString::from_wide(&sz_filename[..len]).into())
}

pub fn append_log_line(msg: &str) {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = format!("[{}] {}\n", now_ms, msg);

    let log_path = std::env::current_exe()
        .ok()
        .map(|mut p| {
            p.pop();
            p.join("map-work").join("ds3_map_viewer.log")
        })
        .or_else(|| {
            get_dll_path().map(|mut p| {
                p.pop();
                p.join("map-work").join("ds3_map_viewer.log")
            })
        })
        .unwrap_or_else(|| PathBuf::from("ds3_map_viewer.log"));

    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path) {
        let _ = f.write_all(line.as_bytes());
    }
}
