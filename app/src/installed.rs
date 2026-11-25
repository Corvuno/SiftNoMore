//! The names of the programs installed on this PC, read from the same list Windows shows under
//! "Installed apps". Used to tell that an installer in Downloads has already done its job.

#[cfg(windows)]
pub fn program_names() -> Vec<String> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    const PATHS: &[&str] = &[
        r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut names = Vec::new();
    for hive in [HKEY_LOCAL_MACHINE, HKEY_CURRENT_USER] {
        let root = RegKey::predef(hive);
        for path in PATHS {
            let Ok(key) = root.open_subkey_with_flags(path, KEY_READ) else {
                continue;
            };
            for sub in key.enum_keys().flatten() {
                if let Ok(k) = key.open_subkey_with_flags(&sub, KEY_READ) {
                    if let Ok(name) = k.get_value::<String, _>("DisplayName") {
                        names.push(name);
                    }
                }
            }
        }
    }
    names.sort();
    names.dedup();
    names
}

#[cfg(not(windows))]
pub fn program_names() -> Vec<String> {
    Vec::new()
}
