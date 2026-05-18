// johndisandonato's Dark Souls III Practice Tool
// Copyright (C) 2022-2024  johndisandonato <https://github.com/veeenu>
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published
// by the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

mod config;
mod map;
mod util;
mod viewer;

use std::ffi::c_void;
use std::panic;
use std::sync::atomic::Ordering;
use std::sync::Once;
use std::time::{Duration, Instant};
use std::{env, mem, ptr, thread};

use hudhook::hooks::dx11::ImguiDx11Hooks;
use hudhook::mh::{MH_ApplyQueued, MH_Initialize, MhHook, MH_STATUS};
use hudhook::tracing::{error, trace};
use hudhook::{eject, Hudhook};
use libds3::pointers::PointerChains;
use once_cell::sync::Lazy;
use viewer::Viewer;
use windows::core::{s, w, GUID, HRESULT, PCWSTR};
use windows::Win32::Foundation::{ERROR_SUCCESS, HINSTANCE, MAX_PATH};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::System::SystemServices::DLL_PROCESS_ATTACH;
use windows::Win32::UI::Input::KeyboardAndMouse::{GetAsyncKeyState, VK_RSHIFT};
use windows::Win32::UI::Input::XboxController::XINPUT_STATE;

type FDirectInput8Create = unsafe extern "system" fn(
    hinst: HINSTANCE,
    dwversion: u32,
    riidltf: *const GUID,
    ppvout: *mut *mut c_void,
    punkouter: HINSTANCE,
) -> HRESULT;

static DIRECTINPUT8CREATE: Lazy<FDirectInput8Create> = Lazy::new(|| unsafe {
    let mut dinput8_path = [0u16; MAX_PATH as usize];
    let count = GetSystemDirectoryW(Some(&mut dinput8_path)) as usize;

    // If count == 0, this will be fun
    ptr::copy_nonoverlapping(w!("\\dinput8.dll").0, dinput8_path[count..].as_mut_ptr(), 12);

    let dinput8 = LoadLibraryW(PCWSTR(dinput8_path.as_ptr())).unwrap();
    let directinput8create = mem::transmute::<
        Option<unsafe extern "system" fn() -> isize>,
        FDirectInput8Create,
    >(GetProcAddress(dinput8, s!("DirectInput8Create")));

    apply_no_logo();

    directinput8create
});

#[no_mangle]
unsafe extern "system" fn DirectInput8Create(
    hinst: HINSTANCE,
    dwversion: u32,
    riidltf: *const GUID,
    ppvout: *mut *mut c_void,
    punkouter: HINSTANCE,
) -> HRESULT {
    (DIRECTINPUT8CREATE)(hinst, dwversion, riidltf, ppvout, punkouter)
}

type FXInputGetState =
    unsafe extern "system" fn(dw_user_index: u32, xinput_state: *mut XINPUT_STATE) -> u32;
static INIT_PANIC_HOOK: Once = Once::new();

static XINPUTGETSTATE: Lazy<FXInputGetState> = Lazy::new(|| unsafe {
    let mut path = [0u16; MAX_PATH as usize];
    let count = GetSystemDirectoryW(Some(&mut path)) as usize;

    ptr::copy_nonoverlapping(w!("\\xinput1_3.dll").0, path[count..].as_mut_ptr(), 14);

    let lib = LoadLibraryW(PCWSTR(path.as_ptr())).unwrap();

    let xinput_get_state_addr = GetProcAddress(lib, s!("XInputGetState")).unwrap();

    match MH_Initialize() {
        MH_STATUS::MH_ERROR_ALREADY_INITIALIZED | MH_STATUS::MH_OK => {},
        status @ MH_STATUS::MH_ERROR_MEMORY_ALLOC => {
            panic!("XInputCreate hook: initialize: {status:?}");
        },
        _ => unreachable!(),
    }

    let hook =
        MhHook::new(xinput_get_state_addr as *mut c_void, xinput_get_state_impl as *mut c_void)
            .expect("XInputCreate hook: create");

    hook.queue_enable().expect("XInputCreate hook: queue enable");
    MH_ApplyQueued().ok().expect("XInputCreate hook: apply queued");

    mem::transmute(hook.trampoline())
});

unsafe extern "system" fn xinput_get_state_impl(
    dw_user_index: u32,
    xinput_state: *mut XINPUT_STATE,
) -> u32 {
    let r = (XINPUTGETSTATE)(dw_user_index, xinput_state);

    if viewer::BLOCK_XINPUT.load(Ordering::SeqCst) {
        *xinput_state = Default::default();
        return r;
    }

    if r != ERROR_SUCCESS.0 {
        return r;
    }

    const DEADZONE: i16 = 64;

    // Apply deadzone.
    if let Some(state) = xinput_state.as_mut() {
        if (-DEADZONE..=DEADZONE).contains(&state.Gamepad.sThumbLX) {
            state.Gamepad.sThumbLX = 0;
        }
        if (-DEADZONE..=DEADZONE).contains(&state.Gamepad.sThumbLY) {
            state.Gamepad.sThumbLY = 0;
        }
        if (-DEADZONE..=DEADZONE).contains(&state.Gamepad.sThumbRX) {
            state.Gamepad.sThumbRX = 0;
        }
        if (-DEADZONE..=DEADZONE).contains(&state.Gamepad.sThumbRY) {
            state.Gamepad.sThumbRY = 0;
        }
    }

    r
}

fn apply_no_logo() {
    // This is evaluated twice: here and in [`Viewer::new()`]. No big deal,
    // but might want to refactor that eventually.
    let pointer_chains = PointerChains::new();
    pointer_chains.no_logo.write([
        0x48, 0x31, 0xC0, 0x48, 0x89, 0x02, 0x49, 0x89, 0x04, 0x24, 0x90, 0x90, 0x90, 0x90, 0x90,
        0x90, 0x90, 0x90, 0x90, 0x90,
    ]);
}

fn start_plugin(hmodule: HINSTANCE) {
    INIT_PANIC_HOOK.call_once(|| {
        panic::set_hook(Box::new(|info| {
            util::append_log_line(&format!("panic: {}", info));
        }));
        util::append_log_line("panic hook installed");
    });
    util::append_log_line("start_plugin: begin");
    let practice_tool = Viewer::new();

    if let Err(e) = Hudhook::builder()
        .with::<ImguiDx11Hooks>(practice_tool)
        .with_hmodule(hmodule)
        .build()
        .apply()
    {
        error!("Couldn't apply hooks: {e:?}");
        util::append_log_line(&format!("start_plugin: apply failed: {e:?}"));
        eject();
    } else {
        util::append_log_line("start_plugin: hooks applied");
    }
}

fn await_rshift() -> bool {
    let duration_threshold = Duration::from_secs(2);
    let check_window = Duration::from_secs(10);
    let poll_interval = Duration::from_millis(100);

    let start_time = Instant::now();
    let mut key_down_start: Option<Instant> = None;

    while start_time.elapsed() < check_window {
        let state = unsafe { GetAsyncKeyState(VK_RSHIFT.0 as i32) };
        let key_down = state < 0;

        match (key_down, key_down_start) {
            (true, None) => {
                key_down_start = Some(Instant::now());
            },
            (true, Some(start)) => {
                if start.elapsed() >= duration_threshold {
                    return true;
                }
            },
            (false, _) => {
                key_down_start = None;
            },
        }

        thread::sleep(poll_interval);
    }

    false
}

fn env_start_requested() -> bool {
    if env::var("DOLL_SKIP").ok().map(|s| s == "consistent").unwrap_or(false) {
        thread::sleep(Duration::from_millis(2000));
        true
    } else {
        false
    }
}

#[no_mangle]
#[allow(clippy::missing_safety_doc)]
pub unsafe extern "system" fn DllMain(hmodule: HINSTANCE, reason: u32, _: *mut c_void) {
    if reason == DLL_PROCESS_ATTACH {
        trace!("DllMain()");
        util::append_log_line("DllMain: DLL_PROCESS_ATTACH");
        Lazy::force(&DIRECTINPUT8CREATE);
        Lazy::force(&XINPUTGETSTATE);
        util::append_log_line("DllMain: lazy hooks initialized");

        let hmodule_ptr = hmodule.0 as usize;
        thread::spawn(move || {
            let hmodule = HINSTANCE(hmodule_ptr as *mut c_void);
            util::append_log_line("start thread: spawned");
            if util::get_dll_path()
                .and_then(|path| {
                    path.file_name().map(|s| s.to_string_lossy().to_lowercase() == "dinput8.dll")
                })
                .unwrap_or(false)
            {
                util::append_log_line("start thread: dinput8 mode");
                if env_start_requested() || await_rshift() {
                    util::append_log_line("start thread: start condition met");
                    start_plugin(hmodule)
                } else {
                    util::append_log_line("start thread: start condition not met");
                }
            } else {
                util::append_log_line("start thread: direct mode");
                start_plugin(hmodule)
            }
        });
    }
}
